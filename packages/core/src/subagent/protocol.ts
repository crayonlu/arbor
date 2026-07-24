/**
 * Subagent JSONL protocol: the wire format between the task tool (parent)
 * and a spawned arbor subagent process (child).
 *
 * The child writes one JSON object per line to stdout. The same protocol is
 * used by the headless CLI's --json mode, so any arbor process can act as a
 * subagent for another.
 */
import type { AgentEvent } from "../types.ts";

/** Configuration passed to the child on argv as a single JSON argument. */
export interface SubagentConfig {
	cwd: string;
	provider: string;
	modelId: string;
	prompt: string;
	systemPrompt?: string;
	/** Restrict to read-only tools. */
	mode?: "build" | "plan";
	/** Tool names to expose (default: all coding tools). */
	tools?: string[];
}

/** Events the child emits, one JSON object per stdout line. */
export type SubagentEvent =
	| { type: "ready" }
	| {
			type: "agent_event";
			event: { type: Exclude<AgentEvent["type"], "message_update"> } | Record<string, unknown>;
	  }
	| { type: "text"; text: string }
	| { type: "tool"; toolName: string; summary: string; isError: boolean }
	| { type: "result"; text: string; messageCount: number; isError: boolean }
	| { type: "fatal"; error: string };

/** Serialize one event to a JSONL line. */
export function encodeEvent(event: SubagentEvent): string {
	return `${JSON.stringify(event)}\n`;
}

/** Incremental JSONL decoder for the parent side. */
export function createJsonlDecoder(onEvent: (event: SubagentEvent) => void): (chunk: string) => void {
	let buffer = "";
	return (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line.length > 0) {
				try {
					onEvent(JSON.parse(line) as SubagentEvent);
				} catch {
					// Ignore non-JSON lines (stray stdout from tools).
				}
			}
			newline = buffer.indexOf("\n");
		}
	};
}
