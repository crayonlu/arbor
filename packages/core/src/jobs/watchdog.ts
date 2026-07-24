/**
 * Stall watchdog for background commands: when output stops growing and the
 * tail looks like an interactive prompt, notify once so the model can kill
 * the job and re-run non-interactively. Silent on merely-slow commands.
 */
import { stat } from "node:fs/promises";
import { tailJobLog } from "./log-store.ts";

/**
 * Last-line patterns suggesting a command is blocked on keyboard input.
 * Kept narrow on purpose: long builds and slow greps must not trigger.
 */
const PROMPT_PATTERNS = [
	/\(y\/n\)/i,
	/\[y\/n\]/i,
	/\(yes\/no\)/i,
	/\b(?:do you|would you|shall i|are you sure|ready to)\b.*\? *$/i,
	/press (any key|enter)/i,
	/continue\?/i,
	/overwrite\?/i,
	/password[^\n]*: *$/i,
];

export function looksLikePrompt(tail: string): boolean {
	const lastLine = tail.trimEnd().split("\n").pop() ?? "";
	return PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine));
}

export interface StallWatchdogOptions {
	logPath: string;
	/** Poll interval. Default 5s. */
	intervalMs?: number;
	/** How long output must be flat before checking the tail. Default 45s. */
	thresholdMs?: number;
	/** Bytes of tail to inspect. Default 1KB. */
	tailBytes?: number;
	/** Fired at most once, with the prompt-looking tail. */
	onStall: (tail: string) => void;
}

/** Start watching a job log for interactive-prompt stalls. Returns cancel. */
export function startStallWatchdog(options: StallWatchdogOptions): () => void {
	const intervalMs = options.intervalMs ?? 5_000;
	const thresholdMs = options.thresholdMs ?? 45_000;
	const tailBytes = options.tailBytes ?? 1024;

	let lastSize = 0;
	let lastGrowth = Date.now();
	let cancelled = false;

	const timer = setInterval(() => {
		void stat(options.logPath).then(
			(s) => {
				if (cancelled) return;
				if (s.size > lastSize) {
					lastSize = s.size;
					lastGrowth = Date.now();
					return;
				}
				if (Date.now() - lastGrowth < thresholdMs) return;
				void tailJobLog(options.logPath, tailBytes).then(
					(tail) => {
						if (cancelled) return;
						if (!looksLikePrompt(tail)) {
							// Not a prompt — reset so the next tail check is a full
							// threshold out instead of re-reading every tick.
							lastGrowth = Date.now();
							return;
						}
						// Latch before the callback so overlapping ticks bail.
						cancelled = true;
						clearInterval(timer);
						options.onStall(tail);
					},
					() => {},
				);
			},
			() => {
				// Log file may not exist yet.
			},
		);
	}, intervalMs);
	timer.unref?.();

	return () => {
		cancelled = true;
		clearInterval(timer);
	};
}
