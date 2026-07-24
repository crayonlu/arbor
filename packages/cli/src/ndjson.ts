/**
 * NDJSON framing for headless modes (json print mode + rpc).
 *
 * - `serializeLine` produces one strict JSON record terminated by LF, with
 *   U+2028/U+2029 escaped so a line-splitting receiver cannot cut a string
 *   mid-value (ECMA-262 treats those as line terminators; ECMA-404 does not).
 * - `attachJsonlLineReader` splits a stream on LF only. Node's `readline` is
 *   deliberately avoided: it also splits on U+2028/U+2029, breaking JSONL.
 */
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// Built from code points so the source stays pure ASCII (the literal chars
// are invisible and get mangled by editors/diff tools).
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const JS_LINE_TERMINATORS = new RegExp(`${LINE_SEPARATOR}|${PARAGRAPH_SEPARATOR}`, "g");

function escapeJsLineTerminators(json: string): string {
	return json.replace(JS_LINE_TERMINATORS, (c) => (c === LINE_SEPARATOR ? "\\u2028" : "\\u2029"));
}

/** Serialize a value as a single NDJSON record (strict JSON + LF). */
export function serializeLine(value: unknown): string {
	return `${escapeJsLineTerminators(JSON.stringify(value))}\n`;
}

/**
 * Attach an LF-only line reader to a readable stream. Returns a detach
 * function that removes the listeners. The final partial line (no trailing
 * LF) is emitted on `end`.
 */
export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	const emitLine = (line: string): void => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const onData = (chunk: string | Buffer): void => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer);
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			emitLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
		}
	};

	const onEnd = (): void => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			emitLine(buffer);
			buffer = "";
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
