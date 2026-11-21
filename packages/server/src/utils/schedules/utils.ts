import { createWriteStream } from "node:fs";
import path from "node:path";
import { IS_CLOUD, paths } from "@dokploy/server/constants";
import type { Schedule } from "@dokploy/server/db/schema/schedule";
import type { Compose } from "@dokploy/server/services/compose";
import {
	createDeploymentSchedule,
	updateDeployment,
	updateDeploymentStatus,
} from "@dokploy/server/services/deployment";
import { findScheduleById } from "@dokploy/server/services/schedule";
import { scheduledJobs, scheduleJob as scheduleJobNode } from "node-schedule";
import { quote } from "shell-quote";
import {
	getDeployedComposeConfigCommand,
	parseDeployedComposeConfig,
} from "../builders/compose";
import { getComposeContainer, getServiceContainer } from "../docker/utils";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import { spawnAsync } from "../process/spawnAsync";
import { getComposeRunCommand, getComposeStartCommand } from "./container-run";
import {
	getShellTimeoutCheck,
	getTimeoutArgs,
	getTimeoutMessage,
	isTimeoutError,
} from "./timeout";

export const scheduleJob = (schedule: Schedule) => {
	const { cronExpression, scheduleId, timezone } = schedule;

	// Use timezone from schedule, default to UTC if not specified
	const tz = timezone || "UTC";

	scheduleJobNode(
		scheduleId,
		{
			tz,
			rule: cronExpression,
		},
		async () => {
			await runCommand(scheduleId);
		},
	);
};

export const removeScheduleJob = (scheduleId: string) => {
	const currentJob = scheduledJobs[scheduleId];
	currentJob?.cancel();
};

const runComposeContainer = async ({
	compose,
	serviceName,
	command,
	executionMode,
	timeout,
	deployment,
}: {
	compose: Compose;
	serviceName: string;
	command: string;
	executionMode: Schedule["executionMode"];
	timeout: number | null;
	deployment: { deploymentId: string; logPath: string };
}) => {
	const runShell = async (script: string) => {
		if (compose.serverId) return execAsyncRemote(compose.serverId, script);
		if (IS_CLOUD) {
			throw new Error("This feature is not available in the cloud version.");
		}
		return execAsync(script);
	};
	const input = { compose, serviceName, timeout, logPath: deployment.logPath };

	if (executionMode === "start") {
		await runShell(getComposeStartCommand(input));
		return;
	}
	const { stdout } = await runShell(
		getDeployedComposeConfigCommand(compose.appName),
	);
	await runShell(
		getComposeRunCommand({
			...input,
			command,
			runId: deployment.deploymentId,
			deployed: parseDeployedComposeConfig(stdout),
		}),
	);
};

export const runCommand = async (scheduleId: string) => {
	const {
		application,
		command,
		shellType,
		scheduleType,
		compose,
		serviceName,
		appName,
		serverId,
		timeout,
		executionMode,
	} = await findScheduleById(scheduleId);
	const timeoutPrefix = getTimeoutArgs(timeout).join(" ");

	const deployment = await createDeploymentSchedule({
		scheduleId,
		title: "Schedule",
		description: "Schedule",
	});

	try {
		if (scheduleType === "compose" && compose && executionMode !== "exec") {
			await runComposeContainer({
				compose,
				serviceName: serviceName || "",
				command,
				executionMode,
				timeout,
				deployment,
			});
		} else if (scheduleType === "application" || scheduleType === "compose") {
			let containerId = "";
			let serverId = "";
			if (scheduleType === "application" && application) {
				const container = await getServiceContainer(
					application.appName,
					application.serverId,
				);
				containerId = container?.Id || "";
				serverId = application.serverId || "";
			}
			if (scheduleType === "compose" && compose) {
				const container = await getComposeContainer(compose, serviceName || "");
				containerId = container?.Id || "";
				serverId = compose.serverId || "";
			}

			if (!containerId) {
				const target =
					scheduleType === "compose"
						? `service '${serviceName}' of compose '${compose?.name}'`
						: `application '${application?.appName}'`;
				const message = `Container not found for ${target}, make sure the service is running`;
				if (serverId) {
					await execAsyncRemote(
						serverId,
						`echo ${quote([`❌ ${message}`])} >> ${quote([deployment.logPath])}`,
					);
				} else {
					const writeStream = createWriteStream(deployment.logPath, {
						flags: "a",
					});
					writeStream.write(`❌ ${message}\n`);
					writeStream.end();
				}
				throw new Error(message);
			}

			if (serverId) {
				await execAsyncRemote(
					serverId,
					`
					set -e
					echo "Running scheduled command" >> ${quote([deployment.logPath])};
					${timeoutPrefix} docker exec ${quote([containerId])} ${quote([shellType])} -c ${quote([command])} >> ${quote([deployment.logPath])} 2>> ${quote([deployment.logPath])} || {
						code=$?;
						${getShellTimeoutCheck(timeout, deployment.logPath)}
						echo "❌ Command failed" >> ${quote([deployment.logPath])};
						exit 1;
					}
					echo "✅ Command executed successfully" >> ${quote([deployment.logPath])};
					`,
				);
			} else {
				const writeStream = createWriteStream(deployment.logPath, {
					flags: "a",
				});

				try {
					if (IS_CLOUD) {
						writeStream.write(
							"This feature is not available in the cloud version.",
						);
						writeStream.end();
						await updateDeploymentStatus(deployment.deploymentId, "error");
						return { ...deployment, status: "error" as const };
					}
					writeStream.write(
						`docker exec ${containerId} ${shellType} -c ${command}\n`,
					);
					const [bin = "docker", ...args] = [
						...getTimeoutArgs(timeout),
						"docker",
						"exec",
						containerId,
						shellType,
						"-c",
						command,
					];
					await spawnAsync(bin, args, (data) => {
						if (writeStream.writable) {
							writeStream.write(data);
						}
					});

					writeStream.write("✅ Command executed successfully\n");
					writeStream.end();
				} catch (error) {
					if (isTimeoutError(error)) {
						writeStream.write(`${getTimeoutMessage(timeout)}\n`);
					}
					writeStream.write("❌ Command failed\n");
					writeStream.write(
						error instanceof Error ? error.message : "Unknown error",
					);
					writeStream.end();
					throw error;
				}
			}
		} else if (scheduleType === "dokploy-server") {
			const writeStream = createWriteStream(deployment.logPath, { flags: "a" });
			const { SCHEDULES_PATH } = paths();
			const fullPath = path.join(SCHEDULES_PATH, appName || "");

			const [bin = "bash", ...args] = [
				...getTimeoutArgs(timeout),
				"bash",
				"-c",
				"./script.sh",
			];
			await spawnAsync(
				bin,
				args,
				async (data) => {
					if (writeStream.writable) {
						// we need to extract the PID and Schedule ID from the data
						const pid = data?.match(/PID: (\d+)/)?.[1];

						if (pid) {
							await updateDeployment(deployment.deploymentId, {
								pid,
							});
						}
						writeStream.write(data);
					}
				},
				{
					cwd: fullPath,
				},
			).catch((error) => {
				if (isTimeoutError(error)) {
					writeStream.write(`${getTimeoutMessage(timeout)}\n`);
				}
				throw error;
			});
		} else if (scheduleType === "server") {
			const { SCHEDULES_PATH } = paths(true);
			const fullPath = path.join(SCHEDULES_PATH, appName || "");
			const command = `
				set -euo pipefail
				echo "Running script" >> ${deployment.logPath};
				${timeoutPrefix} bash -c ${fullPath}/script.sh 2>&1 | tee -a ${deployment.logPath} || {
					code=$?;
					${getShellTimeoutCheck(timeout, deployment.logPath)}
					echo "❌ Command failed" >> ${deployment.logPath};
					exit 1;
				  }
				echo "✅ Command executed successfully" >> ${deployment.logPath};
			`;
			await execAsyncRemote(serverId, command, async (data) => {
				// we need to extract the PID and Schedule ID from the data
				const pid = data?.match(/PID: (\d+)/)?.[1];
				if (pid) {
					await updateDeployment(deployment.deploymentId, {
						pid,
					});
				}
			});
		}
		await updateDeploymentStatus(deployment.deploymentId, "done");
		return { ...deployment, status: "done" as const };
	} catch {
		await updateDeploymentStatus(deployment.deploymentId, "error");
		return { ...deployment, status: "error" as const };
	}
};
