import { dirname, join } from "node:path";
import { paths } from "@dokploy/server/constants";
import type { Compose } from "@dokploy/server/services/compose";
import { parse, quote } from "shell-quote";
import type { DeployedComposeConfig } from "../builders/compose";
import { getShellTimeoutCheck, getTimeoutArgs } from "./timeout";

type ContainerRunInput = {
	compose: Compose;
	serviceName: string;
	timeout: number | null;
	logPath: string;
};

const runWithTimeout = (
	command: string,
	{ timeout, logPath }: Pick<ContainerRunInput, "timeout" | "logPath">,
	cleanup: string,
) => {
	const log = quote([logPath]);
	const timeoutPrefix = getTimeoutArgs(timeout).join(" ");
	return `${timeoutPrefix} ${command} >> ${log} 2>&1 || {
	code=$?;
	${getShellTimeoutCheck(timeout, logPath, cleanup)}
	echo "❌ Command failed" >> ${log};
	exit 1;
}
echo "✅ Command executed successfully" >> ${log};`;
};

// The command override is user input, so it is split into words and re-quoted
// instead of being interpolated into the host shell. Variables are kept as
// written so the shell in the container expands them, not shell-quote.
const toArgs = (command: string) =>
	quote(
		parse(command, (name) => `\${${name}}`).filter(
			(arg): arg is string => typeof arg === "string",
		),
	);

export const getComposeRunCommand = ({
	compose,
	serviceName,
	timeout,
	logPath,
	command,
	runId,
	deployed,
}: ContainerRunInput & {
	command: string;
	runId: string;
	deployed: DeployedComposeConfig | null;
}) => {
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const projectPath = join(COMPOSE_PATH, compose.appName, "code");
	const composePath =
		compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
	const envFile = join(
		dirname(compose.composePath || "docker-compose.yml"),
		".env",
	);
	const containerName = `${compose.appName}-${serviceName}-sched-${runId}`;

	const fallbackArgs = [
		...(compose.createEnvFile ? ["--env-file", envFile] : []),
		"-f",
		composePath,
	];
	// Prefer the files the last deploy used, as recorded on its containers. They
	// can be missing when the code directory was re-fetched after the deploy.
	let selectArgs = `set -- ${quote(fallbackArgs)}`;
	if (deployed && deployed.configFiles.length > 0 && deployed.workingDir) {
		const deployedArgs = [
			"--project-directory",
			deployed.workingDir,
			...deployed.configFiles.flatMap((f) => ["-f", f]),
			...deployed.envFiles.flatMap((f) => ["--env-file", f]),
		];
		const filesExist = [
			`[ -d ${quote([deployed.workingDir])} ]`,
			...[...deployed.configFiles, ...deployed.envFiles].map(
				(f) => `[ -f ${quote([f])} ]`,
			),
		].join(" && ");
		selectArgs = `if ${filesExist}; then set -- ${quote(deployedArgs)}; else ${selectArgs}; fi`;
	}

	const run = `env -i PATH="$PATH" HOME="$HOME" docker compose -p ${quote([compose.appName])} "$@" run --rm --no-deps -T --name ${quote([containerName])} ${quote([serviceName])} ${toArgs(command)}`;

	return `set -e
cd ${quote([projectPath])}
${selectArgs}
echo ${quote([`Running a new container for service '${serviceName}'`])} >> ${quote([logPath])};
${runWithTimeout(run, { timeout, logPath }, `docker rm -f ${quote([containerName])} >/dev/null 2>&1 || true`)}`;
};

export const getComposeStartCommand = ({
	compose,
	serviceName,
	timeout,
	logPath,
}: ContainerRunInput) => {
	const log = quote([logPath]);
	const filters = [
		`label=com.docker.compose.project=${compose.appName}`,
		`label=com.docker.compose.service=${serviceName}`,
	].flatMap((filter) => ["--filter", filter]);

	return `set -e
id=$(docker ps -a -q ${quote(filters)} | head -n 1)
if [ -z "$id" ]; then
	echo ${quote([`❌ No container found for service '${serviceName}', deploy the compose first`])} >> ${log};
	exit 1;
fi
if [ "$(docker inspect -f '{{.State.Running}}' "$id")" = "true" ]; then
	echo "❌ Container $id is still running from a previous run" >> ${log};
	exit 1;
fi
echo "Starting container $id" >> ${log};
${runWithTimeout(`docker start -a "$id"`, { timeout, logPath }, `docker stop -t 10 "$id" >/dev/null 2>&1 || true`)}`;
};

// Polls until the newest task of the service ($0) is not the task that existed
// before the trigger ($OLD) and has reached a terminal state.
const STACK_TASK_WAIT_LOOP = `while :; do
	set -- $(docker service ps --no-trunc --format "{{.ID}} {{.CurrentState}}" "$0" | head -n 1)
	if [ "$1" != "$OLD" ]; then
		case "$2" in Complete|Failed|Rejected|Shutdown|Orphaned) exit 0;; esac
	fi
	sleep 2
done`;

export const getStackTaskCommand = ({
	compose,
	serviceName,
	timeout,
	logPath,
	mode,
}: ContainerRunInput & { mode: "run" | "start" }) => {
	const log = quote([logPath]);
	const service = quote([`${compose.appName}_${serviceName}`]);
	const scaleDown = `docker service scale -d ${service}=0 >/dev/null 2>&1 || true`;
	// After a timeout scaled it to 0, a forced update would not start any task.
	const trigger =
		mode === "run"
			? `docker service scale -d ${service}=1 >/dev/null`
			: `if [ "$(docker service inspect -f '{{.Spec.Mode.Replicated.Replicas}}' ${service})" = "0" ]; then
	docker service scale -d ${service}=1 >/dev/null
else
	docker service update --force -d ${service} >/dev/null
fi`;

	// A task scaled down after a timeout stays in its slot until its stop grace
	// period ends, and a scale up during that window never gets a new task when
	// the restart policy is "none".
	return `set -e
if [ -n "$(docker service ps -q --filter desired-state=running ${service})" ]; then
	echo ${quote([`❌ A task of service '${serviceName}' is still running from a previous run`])} >> ${log};
	exit 1;
fi
n=0
while [ -n "$(docker service ps -q --filter desired-state=remove ${service})" ]; do
	n=$((n + 1))
	if [ "$n" -gt 60 ]; then
		echo ${quote([`❌ The previous task of service '${serviceName}' is still being removed`])} >> ${log};
		exit 1;
	fi
	sleep 2
done
old=$(docker service ps -q ${service} | head -n 1)
echo ${quote([`Starting a task of service '${serviceName}'`])} >> ${log};
${trigger}
OLD="$old" ${getTimeoutArgs(timeout).join(" ")} sh -c ${quote([STACK_TASK_WAIT_LOOP])} ${service} || {
	code=$?;
	${getShellTimeoutCheck(timeout, logPath, scaleDown)}
	echo "❌ Command failed" >> ${log};
	exit 1;
}
task=$(docker service ps -q ${service} | head -n 1)
docker service logs --raw --no-trunc "$task" >> ${log} 2>&1 || true
code=$(docker inspect -f '{{.Status.ContainerStatus.ExitCode}}' "$task" 2>/dev/null || echo "unknown")
${mode === "run" ? scaleDown : ""}
if [ "$code" != "0" ]; then
	echo "❌ Command failed (exit code $code)" >> ${log};
	exit 1;
fi
echo "✅ Command executed successfully" >> ${log};`;
};
