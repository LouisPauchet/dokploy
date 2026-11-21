import type { Compose } from "@dokploy/server/services/compose";
import {
	getComposeRunCommand,
	getComposeStartCommand,
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
