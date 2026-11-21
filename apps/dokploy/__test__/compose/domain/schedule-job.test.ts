import type { Compose } from "@dokploy/server/services/compose";
import { addDomainToCompose } from "@dokploy/server/utils/docker/domain";
import { describe, expect, it } from "vitest";

const composeFile = `
services:
  web:
    image: nginx
  job:
    image: alpine
    labels:
      dokploy.schedule.cron: "0 3 * * *"
    deploy:
      labels:
        dokploy.schedule.cron: "0 3 * * *"
`;

const buildCompose = (composeType: "docker-compose" | "stack") =>
	({
		appName: "job-app",
		composeType,
		composePath: "docker-compose.yml",
		sourceType: "raw",
		serverId: null,
		isolatedDeployment: false,
		isolatedDeploymentsVolume: false,
		randomize: false,
		suffix: "",
		composeFile,
	}) as unknown as Compose;

describe("addDomainToCompose with scheduled job services", () => {
	it("keeps a run-mode compose job out of compose up", async () => {
		const result = await addDomainToCompose(buildCompose("docker-compose"), []);

		expect(result?.services?.job?.profiles).toEqual(["dokploy-schedule"]);
		expect(result?.services?.web?.profiles).toBeUndefined();
	});

	it("deploys a run-mode stack job with no running task", async () => {
		const result = await addDomainToCompose(buildCompose("stack"), []);

		expect(result?.services?.job?.deploy?.replicas).toBe(0);
		expect(result?.services?.job?.deploy?.restart_policy?.condition).toBe(
			"none",
		);
	});
});
