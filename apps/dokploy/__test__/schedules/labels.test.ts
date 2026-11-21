import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import {
	applyScheduleJobDefaults,
	parseScheduleLabels,
	readServiceLabels,
	SCHEDULE_JOB_PROFILE,
} from "@dokploy/server/utils/schedules/labels";
import { describe, expect, it } from "vitest";

describe("readServiceLabels", () => {
	it("reads list and map labels", () => {
		expect(
			readServiceLabels(
				{ labels: ["dokploy.schedule.cron=0 3 * * *", "flag"] },
				"docker-compose",
			),
		).toEqual({ "dokploy.schedule.cron": "0 3 * * *", flag: "" });
		expect(
			readServiceLabels(
				{ labels: { "dokploy.schedule.timeout": 30 } },
				"docker-compose",
			),
		).toEqual({ "dokploy.schedule.timeout": "30" });
	});

	it("lets deploy labels win for stacks only", () => {
		const service = {
			labels: { "dokploy.schedule.cron": "0 1 * * *" },
			deploy: { labels: ["dokploy.schedule.cron=0 2 * * *"] },
		};
		expect(readServiceLabels(service, "stack")).toEqual({
			"dokploy.schedule.cron": "0 2 * * *",
		});
		expect(readServiceLabels(service, "docker-compose")).toEqual({
			"dokploy.schedule.cron": "0 1 * * *",
		});
	});
});

describe("parseScheduleLabels", () => {
	it("returns null without a cron label", () => {
		expect(parseScheduleLabels({ "dokploy.schedule.timeout": "5" })).toBeNull();
	});

	it("applies defaults", () => {
		expect(
			parseScheduleLabels({ "dokploy.schedule.cron": "*/5 * * * *" }),
		).toEqual({
			ok: true,
			value: {
				cronExpression: "*/5 * * * *",
				timeout: null,
				timezone: null,
				enabled: true,
				name: null,
				mode: "run",
			},
		});
	});

	it("reads every label", () => {
		expect(
			parseScheduleLabels({
				"dokploy.schedule.cron": "0 3 * * *",
				"dokploy.schedule.timeout": "1800",
				"dokploy.schedule.timezone": "Europe/Paris",
				"dokploy.schedule.enabled": "false",
				"dokploy.schedule.name": "Nightly backup",
				"dokploy.schedule.mode": "start",
			}),
		).toEqual({
			ok: true,
			value: {
				cronExpression: "0 3 * * *",
				timeout: 1800,
				timezone: "Europe/Paris",
				enabled: false,
				name: "Nightly backup",
				mode: "start",
			},
		});
	});

	it.each([
		[{ "dokploy.schedule.cron": "not a cron" }, "invalid cron"],
		[{ "dokploy.schedule.cron": "" }, "invalid cron"],
		[
			{
				"dokploy.schedule.cron": "0 3 * * *",
				"dokploy.schedule.timeout": "1.5",
			},
			"invalid timeout",
		],
		[
			{
				"dokploy.schedule.cron": "0 3 * * *",
				"dokploy.schedule.timeout": "-1",
			},
			"invalid timeout",
		],
		[
			{ "dokploy.schedule.cron": "0 3 * * *", "dokploy.schedule.mode": "exec" },
			"invalid mode",
		],
		[
			{
				"dokploy.schedule.cron": "0 3 * * *",
				"dokploy.schedule.timezone": "Mars/Base",
			},
			"invalid timezone",
		],
		[
			{
				"dokploy.schedule.cron": "0 3 * * *",
				"dokploy.schedule.enabled": "yes",
			},
			"invalid enabled",
		],
	])("rejects %j", (labels, reason) => {
		const result = parseScheduleLabels(labels);
		expect(result?.ok).toBe(false);
		expect(result && !result.ok && result.reason).toContain(reason);
	});
});

describe("applyScheduleJobDefaults", () => {
	const build = (): ComposeSpecification => ({
		services: {
			web: { image: "nginx" },
			job: {
				image: "alpine",
				labels: ["dokploy.schedule.cron=0 3 * * *"],
				deploy: { labels: ["dokploy.schedule.cron=0 3 * * *"] },
			},
			starter: {
				image: "alpine",
				labels: {
					"dokploy.schedule.cron": "0 3 * * *",
					"dokploy.schedule.mode": "start",
				},
				deploy: {
					labels: {
						"dokploy.schedule.cron": "0 3 * * *",
						"dokploy.schedule.mode": "start",
					},
				},
			},
			custom: {
				image: "alpine",
				profiles: ["manual"],
				labels: ["dokploy.schedule.cron=0 3 * * *"],
				deploy: {
					replicas: 2,
					restart_policy: { condition: "on-failure" },
					labels: ["dokploy.schedule.cron=0 3 * * *"],
				},
			},
			broken: {
				image: "alpine",
				labels: ["dokploy.schedule.cron=nope"],
			},
		},
	});

	it("keeps run-mode services out of compose up", () => {
		const { services = {} } = applyScheduleJobDefaults(
			build(),
			"docker-compose",
		);
		expect(services.job?.profiles).toEqual([SCHEDULE_JOB_PROFILE]);
		expect(services.starter?.profiles).toBeUndefined();
		expect(services.custom?.profiles).toEqual(["manual"]);
		expect(services.web).toEqual({ image: "nginx" });
		expect(services.broken?.profiles).toBeUndefined();
	});

	it("deploys stack job services without running tasks", () => {
		const { services = {} } = applyScheduleJobDefaults(build(), "stack");
		expect(services.job?.deploy?.replicas).toBe(0);
		expect(services.job?.deploy?.restart_policy?.condition).toBe("none");
		expect(services.starter?.deploy?.replicas).toBeUndefined();
		expect(services.starter?.deploy?.restart_policy?.condition).toBe("none");
		expect(services.custom?.deploy?.replicas).toBe(2);
		expect(services.custom?.deploy?.restart_policy?.condition).toBe(
			"on-failure",
		);
		expect(services.web?.deploy).toBeUndefined();
	});
});
