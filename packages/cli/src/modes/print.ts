/**
 * Print mode (single-shot): send prompts, output result, exit.
 *
 * - text: run all prompts, print the final assistant message's text blocks.
 * - json: subscribe to AgentEvents, stream each as an NDJSON line (prefixed by
 *   a synthetic session_start record), exit when the run settles.
 *
 * Stdout is under the output-guard the whole time so only protocol bytes
 * (json) or the final text (text) reach it. Signals abort the run cleanly.
 */
import type { AgentEvent, AgentMessage, AgentSession } from "@arbor-space/core";
import { serializeLine } from "../ndjson.ts";
import { flushRawStdout, restoreStdout, takeOverStdout, writeRawStdout } from "../output-guard.ts";

export interface PrintModeOptions {
	mode: "text" | "json";
	messages: string[];
	initialMessage?: string;
}
export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<number> {
	const { mode, messages, initialMessage } = options;
	const owned = mode === "json";
	if (owned) takeOverStdout();

	const cleanupSignals: Array<() => void> = [];
	const registerSignals = (): void => {
		const onSignal = (): void => {
			session.abort();
		};
		for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
			const handler = (): void => onSignal();
			process.on(sig, handler);
			cleanupSignals.push(() => process.off(sig, handler));
		}
	};
	registerSignals();

	const unsubscribe = owned
		? session.subscribe((event: AgentEvent) => {
				writeRawStdout(serializeLine(event));
			})
		: undefined;

	if (owned) {
		writeRawStdout(
			serializeLine({
				type: "session_start",
				sessionId: session.session.sessionId,
				...(session.session.name ? { name: session.session.name } : {}),
				cwd: session.cwd,
				model: modelId(session),
			}),
		);
	}

	let exitCode = 0;
	try {
		const prompts: string[] = [];
		if (initialMessage) prompts.push(initialMessage);
		prompts.push(...messages);
		for (const prompt of prompts) {
			await session.prompt(prompt);
		}

		if (mode === "text") {
			const text = lastAssistantText(session.getMessages());
			if (text !== null) {
				process.stdout.write(`${text}\n`);
			} else {
				exitCode = 1;
			}
		}
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		exitCode = 1;
	} finally {
		unsubscribe?.();
		for (const cleanup of cleanupSignals) cleanup();
		if (owned) {
			await flushRawStdout();
			restoreStdout();
		}
	}
	return exitCode;
}

function lastAssistantText(messages: AgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message && (message as { role?: string }).role === "assistant") {
			const content = (message as { content?: unknown }).content;
			if (!Array.isArray(content)) continue;
			const texts = content
				.filter(
					(c): c is { type: "text"; text: string } =>
						typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
				)
				.map((c) => c.text);
			if (texts.length > 0) return texts.join("\n");
		}
	}
	return null;
}

function modelId(session: AgentSession): string {
	const model = session.model as { provider?: string; id?: string } | undefined;
	if (!model) return "unknown";
	return model.provider && model.id ? `${model.provider}/${model.id}` : (model.id ?? "unknown");
}
