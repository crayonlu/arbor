/**
 * bash tool: run a shell command in the workspace.
 *
 * Foreground (default): blocks with timeout, combined tail-truncated output.
 * Background (`background: true`, available when a BackgroundJobs registry is
 * provided): returns immediately with a job id; output streams to a disk log,
 * a stall watchdog warns when the command looks blocked on interactive input,
 * and completion is announced via the registry.
 * Auto-background (optional, requires the registry): a foreground command
 * still running after a threshold — or when a steering message is waiting —
 * is promoted to a background job instead of blocking the conversation.
 */
import { spawn } from "node:child_process";
import { type Static, Type } from "typebox";
import { createJobLog, type JobLog } from "../jobs/log-store.ts";
import type { BackgroundJobs, JobHandle } from "../jobs/registry.ts";
import { startStallWatchdog } from "../jobs/watchdog.ts";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "../types.ts";
import { truncateTail, truncationNotice } from "./truncate.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Hard cap on buffered output before truncation (protects memory). */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
/** Output collected synchronously before a background start returns. */
const BACKGROUND_HEAD_WAIT_MS = 300;
/** Default foreground wait before a command is auto-promoted to background. */
const DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS = 60_000;
/** Poll interval for the steering-pending check during the foreground wait. */
const STEERING_POLL_MS = 250;

const baseProperties = {
	command: Type.String({ description: "The shell command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}; background commands have no default timeout)`,
			minimum: 1,
		}),
	),
};

const foregroundParameters = Type.Object(baseProperties);
const backgroundParameters = Type.Object({
	...baseProperties,
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run the command in the background and return immediately with a job id. " +
				"Use for long-running commands (servers, watch modes, slow builds) when you do not need the result right away. " +
				"You will be notified when it completes — do not poll. Manage with the jobs tool.",
		}),
	),
});

export type BashToolInput = Static<typeof backgroundParameters>;

export interface BashToolDetails {
	command: string;
	exitCode: number | null;
	killedByTimeout: boolean;
	truncated: boolean;
	/** Set when the command was started as a background job. */
	jobId?: string;
	logPath?: string;
}

export interface AutoBackgroundOptions {
	/** Foreground wait before promotion. Default 60s. */
	thresholdMs?: number;
	/**
	 * Returns true when a steering message is waiting (e.g. the user typed
	 * mid-run). A pending message promotes the command immediately so the
	 * message can inject at the next turn boundary.
	 */
	steeringPending?: () => boolean;
}

export interface BashToolOptions {
	/** Enables the `background` parameter when provided. */
	jobs?: BackgroundJobs;
	/** Root directory for background job logs. Default: ~/.arbor/tasks */
	logsRoot?: string;
	/**
	 * Promote still-running foreground commands to background jobs after a
	 * threshold (or when steering input arrives). Requires `jobs`.
	 */
	autoBackground?: AutoBackgroundOptions;
}

function spawnBash(command: string, cwd: string) {
	return spawn("bash", ["-c", command], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ARBOR: "1" },
	});
}

/** Resolved promotion config for the foreground observation window. */
interface PromotionConfig {
	jobs: BackgroundJobs;
	logsRoot: string | undefined;
	thresholdMs: number;
	steeringPending: (() => boolean) | undefined;
}

/**
 * Foreground execution. When `promotion` is set and the command outlives the
 * observation window (or steering input arrives), it is promoted to a
 * background job: buffered output moves to the job log, the command keeps
 * running, and the call resolves with a background-start result.
 */
function executeForeground(
	cwd: string,
	params: { command: string; timeout?: number },
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<BashToolDetails> | undefined,
	promotion?: PromotionConfig,
): Promise<AgentToolResult<BashToolDetails>> {
	const timeoutMs = Math.min(params.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
	const startedAt = Date.now();

	return new Promise((resolve, reject) => {
		const child = spawnBash(params.command, cwd);

		let output = "";
		let bufferedBytes = 0;
		let killedByTimeout = false;
		let settled = false;

		const timer = setTimeout(() => {
			killedByTimeout = true;
			child.kill("SIGKILL");
		}, timeoutMs);

		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort, { once: true });

		const append = (chunk: Buffer) => {
			if (bufferedBytes >= MAX_BUFFER_BYTES) return;
			bufferedBytes += chunk.length;
			output += chunk.toString("utf-8");
			onUpdate?.({
				content: [{ type: "text", text: truncateTail(output).content }],
				details: { command: params.command, exitCode: null, killedByTimeout: false, truncated: false },
			});
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);

		// -- auto-background observation window --------------------------------
		let promotionTimer: NodeJS.Timeout | undefined;
		let steeringPoll: NodeJS.Timeout | undefined;
		const clearPromotionTimers = () => {
			if (promotionTimer) clearTimeout(promotionTimer);
			if (steeringPoll) clearInterval(steeringPoll);
		};

		const promote = (reason: "threshold" | "steering") => {
			if (settled || !promotion) return;
			settled = true;
			clearTimeout(timer);
			clearPromotionTimers();
			signal?.removeEventListener("abort", onAbort);
			child.stdout.off("data", append);
			child.stderr.off("data", append);

			const { jobs } = promotion;
			const handle = jobs.start({
				type: "bash",
				title: params.command,
				kill: () => child.kill("SIGKILL"),
			});
			const log = createJobLog(handle.id, promotion.logsRoot);
			jobs.setLogPath(handle.id, log.path);
			if (output.length > 0) log.append(output);
			attachBackgroundLifecycle(child, handle, log, jobs, {
				// Only an explicit timeout carries over (as remaining time);
				// promoted commands otherwise follow background semantics (no
				// default timeout — the stall watchdog covers hung prompts).
				...(params.timeout !== undefined
					? { killAfterMs: Math.max(1_000, timeoutMs - (Date.now() - startedAt)) }
					: {}),
			});

			const waited = Math.round((Date.now() - startedAt) / 1000);
			const why =
				reason === "steering"
					? "a queued user message needs to inject, so the command was moved to the background"
					: `still running after ${waited}s, so it was moved to the background`;
			const head =
				output.length > 0 ? `\nOutput so far:\n${truncateTail(output, { maxLines: 20 }).content}` : "";
			resolve({
				content: [
					{
						type: "text",
						text: `Command ${why} as job ${handle.id}. It keeps running.\nOutput file: ${log.path}\nYou will be notified when it completes — do not poll. Manage with the jobs tool.${head}`,
					},
				],
				details: {
					command: params.command,
					exitCode: null,
					killedByTimeout: false,
					truncated: false,
					jobId: handle.id,
					logPath: log.path,
				},
			});
		};

		if (promotion) {
			// With an explicit short timeout the command dies before the window
			// matters; leave 1s of headroom so promotion never races the kill.
			const windowMs = Math.min(promotion.thresholdMs, Math.max(0, timeoutMs - 1_000));
			if (windowMs > 0) {
				promotionTimer = setTimeout(() => promote("threshold"), windowMs);
				promotionTimer.unref?.();
				if (promotion.steeringPending) {
					const pending = promotion.steeringPending;
					steeringPoll = setInterval(() => {
						if (pending()) promote("steering");
					}, STEERING_POLL_MS);
					steeringPoll.unref?.();
				}
			}
		}

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearPromotionTimers();
			signal?.removeEventListener("abort", onAbort);
			fn();
		};

		child.on("error", (error) => settle(() => reject(new Error(`Failed to run bash: ${error.message}`))));

		child.on("close", (code) => {
			settle(() => {
				const truncation = truncateTail(output);
				const notice = truncationNotice(truncation, "Output kept from the end.");
				let text = truncation.truncated ? `${notice}\n${truncation.content}` : output;
				if (killedByTimeout) {
					text += `\n[Command killed after ${timeoutMs}ms timeout]`;
				} else if (signal?.aborted) {
					text += "\n[Command aborted]";
				} else if (code !== 0) {
					text += `\n[Exit code: ${code}]`;
				}
				if (text.trim().length === 0) {
					text = "(no output)";
				}
				const details: BashToolDetails = {
					command: params.command,
					exitCode: code,
					killedByTimeout,
					truncated: truncation.truncated,
				};
				// Non-zero exit resolves normally (not a thrown failure): the
				// model needs the output to decide what to do next.
				resolve({ content: [{ type: "text", text }], details });
			});
		});
	});
}

/**
 * Attach the shared background lifecycle to a running child: stream output
 * to the job log, watch for interactive-prompt stalls, optionally kill after
 * a deadline, and settle the job on close/error.
 */
function attachBackgroundLifecycle(
	child: ReturnType<typeof spawnBash>,
	handle: JobHandle,
	log: JobLog,
	jobs: BackgroundJobs,
	options: { killAfterMs?: number } = {},
): void {
	const bgAppend = (chunk: Buffer) => log.append(chunk);
	child.stdout.on("data", bgAppend);
	child.stderr.on("data", bgAppend);

	const cancelWatchdog = startStallWatchdog({
		logPath: log.path,
		onStall: (tail) => {
			jobs.notice(
				handle.id,
				`The command appears to be waiting for interactive input.\nLast output:\n${tail.trimEnd()}\n\nKill this job (jobs tool, action=kill) and re-run non-interactively (e.g. pipe input or add a -y flag).`,
			);
		},
	});

	let killTimer: NodeJS.Timeout | undefined;
	if (options.killAfterMs !== undefined) {
		killTimer = setTimeout(() => jobs.kill(handle.id), Math.min(options.killAfterMs, MAX_TIMEOUT_MS));
		killTimer.unref?.();
	}

	child.on("error", (error) => {
		cancelWatchdog();
		if (killTimer) clearTimeout(killTimer);
		void log.close();
		handle.fail(`Failed to run bash: ${error.message}`);
	});
	child.on("close", (code) => {
		cancelWatchdog();
		if (killTimer) clearTimeout(killTimer);
		void log.close();
		if (!handle.isSettled) {
			if (code === 0) handle.complete(0);
			else handle.fail(`Exited with code ${code}`, code);
		}
	});
}

/** Background execution: register a job, stream output to disk, return immediately. */
async function executeBackground(
	cwd: string,
	params: { command: string; timeout?: number },
	jobs: BackgroundJobs,
	logsRoot: string | undefined,
): Promise<AgentToolResult<BashToolDetails>> {
	const child = spawnBash(params.command, cwd);
	const handle = jobs.start({
		type: "bash",
		title: params.command,
		kill: () => child.kill("SIGKILL"),
	});
	// Log file names use the registry-owned job id, so attach the path after start.
	const log = createJobLog(handle.id, logsRoot);
	jobs.setLogPath(handle.id, log.path);

	let headOutput = "";
	const captureHead = (chunk: Buffer) => {
		if (headOutput.length < 4096) {
			headOutput += chunk.toString("utf-8");
		}
	};
	child.stdout.on("data", captureHead);
	child.stderr.on("data", captureHead);

	attachBackgroundLifecycle(child, handle, log, jobs, {
		...(params.timeout !== undefined ? { killAfterMs: params.timeout } : {}),
	});

	// Give fast-failing commands a moment so obvious errors surface immediately.
	await new Promise((resolve) => setTimeout(resolve, BACKGROUND_HEAD_WAIT_MS));

	const info = jobs.get(handle.id);
	const statusLine =
		info && info.status !== "running"
			? `\nThe command already finished: ${info.status}${info.exitCode !== undefined && info.exitCode !== null ? ` (exit ${info.exitCode})` : ""}.`
			: "\nYou will be notified when it completes — do not poll.";
	const head =
		headOutput.length > 0 ? `\nOutput so far:\n${truncateTail(headOutput, { maxLines: 20 }).content}` : "";
	return {
		content: [
			{
				type: "text",
				text: `Started background job ${handle.id}.\nOutput file: ${log.path}${statusLine}${head}`,
			},
		],
		details: {
			command: params.command,
			exitCode: info?.exitCode ?? null,
			killedByTimeout: false,
			truncated: false,
			jobId: handle.id,
			logPath: log.path,
		},
	};
}

export function createBashTool(
	cwd: string,
	options: BashToolOptions = {},
): AgentTool<typeof backgroundParameters, BashToolDetails> {
	const { jobs } = options;
	const backgroundHint = jobs
		? " Set background=true for long-running commands; you will be notified when they finish."
		: "";
	const promotion: PromotionConfig | undefined =
		jobs && options.autoBackground
			? {
					jobs,
					logsRoot: options.logsRoot,
					thresholdMs: options.autoBackground.thresholdMs ?? DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
					steeringPending: options.autoBackground.steeringPending,
				}
			: undefined;
	return {
		name: "bash",
		label: "Bash",
		mutates: true,
		description:
			"Execute a bash command in the workspace directory. Stdout and stderr are combined. " +
			`Commands time out after ${DEFAULT_TIMEOUT_MS / 1000}s by default (configurable per call). ` +
			`Output keeps the tail when truncated.${backgroundHint}`,
		// Without a registry the schema omits `background` (optional there anyway),
		// so exposing the wider type to callers is safe.
		parameters: jobs ? backgroundParameters : (foregroundParameters as typeof backgroundParameters),
		async execute(
			_id,
			params: BashToolInput,
			signal,
			onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		): Promise<AgentToolResult<BashToolDetails>> {
			if (params.background && jobs) {
				return executeBackground(cwd, params, jobs, options.logsRoot);
			}
			return executeForeground(cwd, params, signal, onUpdate, promotion);
		},
	};
}
