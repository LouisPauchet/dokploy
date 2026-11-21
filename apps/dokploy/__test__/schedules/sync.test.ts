import type { Compose } from "@dokploy/server/services/compose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	insertValues: vi.fn(),
	updateSet: vi.fn(),
	deleteSchedule: vi.fn(),
	scheduleJob: vi.fn(),
	removeScheduleJob: vi.fn(),
	loadDockerCompose: vi.fn(),
	execAsync: vi.fn(async (_command: string) => ({ stdout: "", stderr: "" })),
}));

vi.mock("@dokploy/server/db", () => {
	const tx = {
		insert: () => ({
			values: (values: Record<string, unknown>) => {
				mocks.insertValues(values);
				return { returning: async () => [{ scheduleId: "new", ...values }] };
			},
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => {
				mocks.updateSet(values);
				return {
					where: () => ({
						returning: async () => [
							{ scheduleId: "existing", serviceName: "report", ...values },
						],
					}),
				};
			},
		}),
	};
	return {
		db: {
			query: { schedules: { findMany: mocks.findMany } },
			transaction: async (callback: (t: typeof tx) => unknown) => callback(tx),
		},
	};
});

vi.mock("@dokploy/server/services/schedule", () => ({
	deleteSchedule: mocks.deleteSchedule,
}));

vi.mock("@dokploy/server/utils/schedules/utils", () => ({
	scheduleJob: mocks.scheduleJob,
	removeScheduleJob: mocks.removeScheduleJob,
}));

vi.mock("@dokploy/server/utils/docker/domain", () => ({
	loadDockerCompose: mocks.loadDockerCompose,
	loadDockerComposeRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: vi.fn(),
}));

import { syncLabelSchedules } from "@dokploy/server/utils/schedules/sync";

const compose = {
	composeId: "compose-1",
	composeType: "docker-compose",
	serverId: null,
} as Compose;

const writtenLog = () =>
	mocks.execAsync.mock.calls.map(([command]) => command).join("\n");

describe("syncLabelSchedules", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("creates, updates and removes label schedules to match the compose file", async () => {
		mocks.loadDockerCompose.mockResolvedValue({
			services: {
				web: { image: "nginx" },
				backup: {
					labels: {
						"dokploy.schedule.cron": "0 3 * * *",
						"dokploy.schedule.timeout": "600",
					},
				},
				report: {
					labels: [
						"dokploy.schedule.cron=0 4 * * *",
						"dokploy.schedule.mode=start",
						"dokploy.schedule.enabled=false",
					],
				},
				broken: { labels: ["dokploy.schedule.cron=nope"] },
			},
		});
		mocks.findMany.mockResolvedValue([
			{ scheduleId: "existing", serviceName: "report" },
			{ scheduleId: "stale", serviceName: "old-job" },
		]);

		await syncLabelSchedules(compose, "/logs/deploy.log");

		expect(mocks.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "backup (labels)",
				cronExpression: "0 3 * * *",
				timeout: 600,
				executionMode: "run",
				scheduleType: "compose",
				composeId: "compose-1",
				serviceName: "backup",
				source: "label",
			}),
		);
		expect(mocks.updateSet).toHaveBeenCalledWith(
			expect.objectContaining({
				cronExpression: "0 4 * * *",
				executionMode: "start",
				enabled: false,
			}),
		);
		expect(mocks.updateSet.mock.calls[0]?.[0]).not.toHaveProperty("source");

		expect(mocks.deleteSchedule).toHaveBeenCalledWith("stale");
		expect(mocks.removeScheduleJob).toHaveBeenCalledWith("stale");
		expect(mocks.scheduleJob).toHaveBeenCalledTimes(1);
		expect(mocks.scheduleJob).toHaveBeenCalledWith(
			expect.objectContaining({ scheduleId: "new" }),
		);

		expect(writtenLog()).toContain("Skipping schedule labels of service");
		expect(writtenLog()).toContain("removed: old-job");
	});

	it("never throws into the deploy", async () => {
		mocks.loadDockerCompose.mockRejectedValue(new Error("boom"));

		await expect(
			syncLabelSchedules(compose, "/logs/deploy.log"),
		).resolves.toBeUndefined();
		expect(writtenLog()).toContain("Could not sync label schedules: boom");
	});

	it("does nothing for a compose without label schedules", async () => {
		mocks.loadDockerCompose.mockResolvedValue({
			services: { web: { image: "nginx" } },
		});
		mocks.findMany.mockResolvedValue([]);

		await syncLabelSchedules(compose, "/logs/deploy.log");

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.scheduleJob).not.toHaveBeenCalled();
	});
});
