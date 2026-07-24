/**
 * Stdout guard for headless modes.
 *
 * In json/rpc modes every byte on stdout is protocol; stray `console.log`
 * from the app or a dependency would corrupt the stream. `takeOverStdout`
 * replaces `process.stdout.write` so unowned writes are diverted to stderr
 * (visible, non-corrupting), while protocol output goes out via
 * `writeRawStdout` which writes the real stream directly. Mirrors pi's
 * output-guard.
 */
import type { WriteStream } from "node:tty";

type WriteFn = (chunk: unknown, encoding?: unknown, cb?: unknown) => boolean;

let originalWrite: WriteFn | null = null;
let owned = false;
let guardedStream: Pick<WriteStream, "write"> = process.stdout;

/** Redirect stdout: unowned writes go to stderr; use `writeRawStdout` for output. */
export function takeOverStdout(stream: Pick<WriteStream, "write"> = process.stdout): void {
	if (owned) return;
	owned = true;
	guardedStream = stream;
	originalWrite = stream.write.bind(stream) as WriteFn;
	stream.write = ((chunk: unknown, _encoding?: unknown, cb?: unknown) => {
		const text = typeof chunk === "string" ? chunk : String(chunk);
		process.stderr.write(text);
		if (typeof cb === "function") (cb as () => void)();
		return true;
	}) as typeof stream.write;
}

/** Restore the original stdout writer. */
export function restoreStdout(stream: Pick<WriteStream, "write"> = process.stdout): void {
	if (!owned || !originalWrite) return;
	stream.write = originalWrite as typeof stream.write;
	originalWrite = null;
	owned = false;
}

/** Write directly to the real stdout, bypassing the guard. */
export function writeRawStdout(text: string, stream: Pick<WriteStream, "write"> = process.stdout): void {
	const real = owned && originalWrite ? originalWrite : (stream.write.bind(stream) as WriteFn);
	real(text);
}

/** Wait for the real stdout to drain. */
export function flushRawStdout(): Promise<void> {
	if (!owned || !originalWrite) return Promise.resolve();
	const real = originalWrite;
	return new Promise((resolve) => {
		// Write an empty chunk to obtain a drain callback on the real stream.
		real.call(guardedStream, "", () => resolve());
	});
}

/** True while stdout is under guard. */
export function isStdoutTakenOver(): boolean {
	return owned;
}
