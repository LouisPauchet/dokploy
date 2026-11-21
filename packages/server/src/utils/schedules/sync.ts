import { IS_CLOUD } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import { type Schedule, schedules } from "@dokploy/server/db/schema/schedule";
import type { Compose } from "@dokploy/server/services/compose";
import { deleteSchedule } from "@dokploy/server/services/schedule";
import { and, eq } from "drizzle-orm";
import { quote } from "shell-quote";
import { loadDockerCompose, loadDockerComposeRemote } from "../docker/domain";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import {
	parseScheduleLabels,
	readServiceLabels,
	type ScheduleLabels,
} from "./labels";
import { removeScheduleJob, scheduleJob } from "./utils";

const readLabelSchedules = async (compose: Compose, log: string[]) => {
	const spec = compose.serverId
		? await loadDockerComposeRemote(compose)
		: await loadDockerCompose(compose);
	if (!spec) return null;

	const wanted = new Map<string, ScheduleLabels>();
	for (const [serviceName, service] of Object.entries(spec.services ?? {})) {
		if (!service) continue;
		const parsed = parseScheduleLabels(
			readServiceLabels(service, compose.composeType),
		);
		if (!parsed) continue;
		if (!parsed.ok) {
			log.push(
				`⚠️ Skipping schedule labels of service '${serviceName}': ${parsed.reason}`,
			);
			continue;
		}
		wanted.set(serviceName, parsed.value);
	}
	return wanted;
};

const upsertLabelSchedules = async (
	compose: Compose,
	wanted: Map<string, ScheduleLabels>,
	existing: Schedule[],
) =>
	db.transaction(async (tx) => {
		const saved: Schedule[] = [];
		for (const [serviceName, labels] of wanted) {
			const values = {
				name: labels.name ?? `${serviceName} (labels)`,
				cronExpression: labels.cronExpression,
				timezone: labels.timezone,
				timeout: labels.timeout,
				enabled: labels.enabled,
				executionMode: labels.mode,
				command: "",
			};
			const current = existing.find((row) => row.serviceName === serviceName);
			const [row] = current
				? await tx
						.update(schedules)
						.set(values)
						.where(eq(schedules.scheduleId, current.scheduleId))
						.returning()
				: await tx
						.insert(schedules)
						.values({
							...values,
							scheduleType: "compose",
							composeId: compose.composeId,
							serviceName,
							source: "label",
						})
						.returning();
			if (row) saved.push(row);
		}
		return saved;
	});

/**
 * Mirrors the `dokploy.schedule.*` labels of the deployed compose file into
 * read-only schedules. It only reports problems to the deploy log, so a bad
 * label never fails a deploy that already succeeded.
 */
export const syncLabelSchedules = async (compose: Compose, logPath: string) => {
	const log: string[] = [];
	try {
		// Cloud schedules are registered in a separate jobs service.
		if (IS_CLOUD) return;

		const wanted = await readLabelSchedules(compose, log);
		if (!wanted) {
			log.push("⚠️ Could not read the compose file to sync label schedules");
			return;
		}
		const existing = await db.query.schedules.findMany({
			where: and(
				eq(schedules.composeId, compose.composeId),
				eq(schedules.source, "label"),
			),
		});
		if (wanted.size === 0 && existing.length === 0) return;

		const removed = existing.filter(
			(row) => !row.serviceName || !wanted.has(row.serviceName),
		);
		for (const row of removed) {
			removeScheduleJob(row.scheduleId);
			await deleteSchedule(row.scheduleId);
		}

		const saved = await upsertLabelSchedules(compose, wanted, existing);
		for (const row of saved) {
			removeScheduleJob(row.scheduleId);
			if (row.enabled) scheduleJob(row);
		}

		log.push(
			`🕒 Schedules from labels: ${
				saved
					.map(
						(row) =>
							`${row.serviceName} (${row.cronExpression}${row.enabled ? "" : ", disabled"})`,
					)
					.join(", ") || "none"
			}${removed.length > 0 ? `; removed: ${removed.map((row) => row.serviceName).join(", ")}` : ""}`,
		);
	} catch (error) {
		log.push(
			`⚠️ Could not sync label schedules: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		if (log.length > 0) {
			const command = `printf '%s\\n' ${quote(log)} >> ${quote([logPath])}`;
			await (compose.serverId
				? execAsyncRemote(compose.serverId, command)
				: execAsync(command)
			).catch(() => {});
		}
	}
};
