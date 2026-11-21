import { quote } from "shell-quote";

// coreutils `timeout` exits 124 when it sends TERM and 137 when the -k grace period forces KILL.
const TIMEOUT_EXIT_CODES = [124, 137];

export const getTimeoutArgs = (timeout: number | null) =>
	timeout ? ["timeout", "-k", "10", String(timeout)] : [];

export const getTimeoutMessage = (timeout: number | null) =>
	`⏱ Timed out after ${timeout}s`;

export const isTimeoutError = (error: unknown) =>
	TIMEOUT_EXIT_CODES.includes((error as { code?: number })?.code ?? 0);

/** Expects the failed command's exit status in `$code`. */
export const getShellTimeoutCheck = (
	timeout: number | null,
	logPath: string,
	cleanup = "",
) =>
	timeout
		? `case $code in 124|137) echo ${quote([getTimeoutMessage(timeout)])} >> ${quote([logPath])}; ${cleanup};; esac`
		: "";
