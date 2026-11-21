import type { Compose } from "@dokploy/server/services/compose";
import {
	getComposeRunCommand,
	getComposeStartCommand,
	getStackTaskCommand,
} from "@dokploy/server/utils/schedules/container-run";
import { describe, expect, it } from "vitest";

const compose = {
	appName: "shop-abc123",
	composeType: "docker-compose",
	sourceType: "github",
	composePath: "./docker-compose.yml",
	createEnvFile: true,
	serverId: null,
} as Compose;

const base = {
	compose,
	serviceName: "backup",
	logPath: "/etc/dokploy/schedules/s/run.log",
};

describe("getComposeRunCommand", () => {
	it("runs a removable one-off container of the service", () => {
		const script = getComposeRunCommand({
			...base,
			timeout: null,
			command: "",
			runId: "dep1",
			deployed: null,
		});

		expect(script).toContain(
			'docker compose -p shop-abc123 "$@" run --rm --no-deps -T --name shop-abc123-backup-sched-dep1 backup',
		);
		expect(script).toContain("set -- --env-file .env -f ./docker-compose.yml");
		expect(script).not.toContain("timeout -k");
	});

	it("prefers the deployed compose files when they still exist", () => {
		const script = getComposeRunCommand({
			...base,
			timeout: null,
			command: "",
			runId: "dep1",
			deployed: {
				workingDir: "/etc/dokploy/compose/shop-abc123/code",
				configFiles: [
					"/etc/dokploy/compose/shop-abc123/code/docker-compose.yml",
				],
				envFiles: ["/etc/dokploy/compose/shop-abc123/code/.env"],
			},
		});

		expect(script).toContain(
			"if [ -d /etc/dokploy/compose/shop-abc123/code ] && [ -f /etc/dokploy/compose/shop-abc123/code/docker-compose.yml ] && [ -f /etc/dokploy/compose/shop-abc123/code/.env ]; then set -- --project-directory",
		);
		expect(script).toContain(
			"else set -- --env-file .env -f ./docker-compose.yml; fi",
		);
	});

	it("re-quotes the command override so it cannot escape the shell", () => {
		const script = getComposeRunCommand({
			...base,
			timeout: null,
			command: "node backup.js --target 'a b'; rm -rf /",
			runId: "dep1",
			deployed: null,
		});

		expect(script).toContain("backup node backup.js --target 'a b' rm -rf /");
		expect(script).not.toContain("; rm -rf /");
	});

	it("wraps the run with a timeout that removes the container", () => {
		const script = getComposeRunCommand({
			...base,
			timeout: 30,
			command: "",
			runId: "dep1",
			deployed: null,
		});

		expect(script).toContain("timeout -k 10 30 env -i");
		expect(script).toContain("docker rm -f shop-abc123-backup-sched-dep1");
		expect(script).toContain("Timed out after 30s");
	});
});

describe("getComposeStartCommand", () => {
	it("starts the existing service container attached", () => {
		const script = getComposeStartCommand({ ...base, timeout: 60 });

		expect(script).toContain(
			"docker ps -a -q --filter label\\=com.docker.compose.project\\=shop-abc123 --filter label\\=com.docker.compose.service\\=backup",
		);
		expect(script).toContain('timeout -k 10 60 docker start -a "$id"');
		expect(script).toContain('docker stop -t 10 "$id"');
	});
});

describe("getStackTaskCommand", () => {
	const stack = {
		...base,
		compose: { ...compose, composeType: "stack" } as Compose,
	};

	it("scales the service up for one task and back down in run mode", () => {
		const script = getStackTaskCommand({
			...stack,
			timeout: null,
			mode: "run",
		});

		expect(script).toContain("docker service scale -d shop-abc123_backup=1");
		expect(script).toContain(
			"docker service scale -d shop-abc123_backup=0 >/dev/null 2>&1 || true",
		);
		expect(script).toContain('docker service logs --raw --no-trunc "$task"');
	});

	it("forces a new task of the existing service in start mode", () => {
		const script = getStackTaskCommand({
			...stack,
			timeout: 45,
			mode: "start",
		});

		expect(script).toContain(
			"docker service update --force -d shop-abc123_backup",
		);
		expect(script).toContain('OLD="$old" timeout -k 10 45 sh -c');
		// Only the timeout cleanup scales a started service down.
		expect(script.match(/shop-abc123_backup=0/g)).toHaveLength(1);
	});

	it("waits for a task being removed and refuses to overlap a running one", () => {
		const script = getStackTaskCommand({
			...stack,
			timeout: null,
			mode: "run",
		});
		const trigger = script.indexOf(
			"docker service scale -d shop-abc123_backup=1",
		);

		expect(
			script.indexOf("--filter desired-state=running shop-abc123_backup"),
		).toBeLessThan(trigger);
		expect(
			script.indexOf("--filter desired-state=remove shop-abc123_backup"),
		).toBeLessThan(trigger);
		expect(script).toContain("is still running from a previous run");
	});
});
