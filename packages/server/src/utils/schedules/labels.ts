import type { Compose } from "@dokploy/server/services/compose";
import { scheduleJob } from "node-schedule";
import type {
	ComposeSpecification,
	DefinitionsService,
	ListOrDict,
} from "../docker/types";

const LABEL_PREFIX = "dokploy.schedule.";

/** Profile that keeps run-mode job services out of `docker compose up`. */
export const SCHEDULE_JOB_PROFILE = "dokploy-schedule";

export type ScheduleLabels = {
	cronExpression: string;
	timeout: number | null;
	timezone: string | null;
	enabled: boolean;
	name: string | null;
	mode: "run" | "start";
};

export type ParsedScheduleLabels =
	| { ok: true; value: ScheduleLabels }
	| { ok: false; reason: string };

const toRecord = (labels: ListOrDict | undefined): Record<string, string> => {
	if (!labels) return {};
	if (Array.isArray(labels)) {
		return Object.fromEntries(
			labels.map((label) => {
				const index = label.indexOf("=");
				return index === -1
					? [label, ""]
					: [label.slice(0, index), label.slice(index + 1)];
			}),
		);
	}
	return Object.fromEntries(
		Object.entries(labels).map(([key, value]) => [key, String(value ?? "")]),
	);
};

/** Swarm only exposes `deploy.labels` on the service, so they win for stacks. */
export const readServiceLabels = (
	service: DefinitionsService,
	composeType: Compose["composeType"],
) =>
	composeType === "stack"
		? { ...toRecord(service.labels), ...toRecord(service.deploy?.labels) }
		: toRecord(service.labels);

// Validates with the same parser node-schedule uses when the job is registered.
const isValidCron = (rule: string, tz: string) => {
	try {
		const job = scheduleJob({ rule, tz }, () => {});
		job?.cancel();
		return job !== null;
	} catch {
		return false;
	}
};

const isValidTimezone = (timezone: string) => {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
		return true;
	} catch {
		return false;
	}
};

export const parseScheduleLabels = (
	labels: Record<string, string>,
): ParsedScheduleLabels | null => {
	const get = (key: string) => labels[`${LABEL_PREFIX}${key}`]?.trim();

	const cronExpression = get("cron");
	if (cronExpression === undefined) return null;

	const timezone = get("timezone") || null;
	if (timezone && !isValidTimezone(timezone)) {
		return { ok: false, reason: `invalid timezone "${timezone}"` };
	}
	if (!cronExpression || !isValidCron(cronExpression, timezone || "UTC")) {
		return { ok: false, reason: `invalid cron "${cronExpression}"` };
	}

	const rawTimeout = get("timeout");
	const timeout = rawTimeout ? Number(rawTimeout) : null;
	if (timeout !== null && !(Number.isInteger(timeout) && timeout > 0)) {
		return { ok: false, reason: `invalid timeout "${rawTimeout}"` };
	}

	const mode = get("mode") || "run";
	if (mode !== "run" && mode !== "start") {
		return { ok: false, reason: `invalid mode "${mode}"` };
	}

	const enabled = get("enabled") || "true";
	if (enabled !== "true" && enabled !== "false") {
		return { ok: false, reason: `invalid enabled "${enabled}"` };
	}

	return {
		ok: true,
		value: {
			cronExpression,
			timeout,
			timezone,
			enabled: enabled === "true",
			name: get("name") || null,
			mode,
		},
	};
};

/**
 * Keeps scheduled job services from running as long-lived services on deploy.
 * Values the user already set are left untouched.
 */
export const applyScheduleJobDefaults = (
	spec: ComposeSpecification,
	composeType: Compose["composeType"],
) => {
	for (const service of Object.values(spec.services ?? {})) {
		if (!service) continue;
		const parsed = parseScheduleLabels(readServiceLabels(service, composeType));
		if (!parsed?.ok) continue;
		const { mode } = parsed.value;

		if (composeType === "docker-compose") {
			if (mode === "run" && !service.profiles) {
				service.profiles = [SCHEDULE_JOB_PROFILE];
			}
			continue;
		}

		service.deploy ??= {};
		service.deploy.restart_policy ??= {};
		service.deploy.restart_policy.condition ??= "none";
		if (mode === "run") {
			service.deploy.replicas ??= 0;
		}
	}
	return spec;
};
