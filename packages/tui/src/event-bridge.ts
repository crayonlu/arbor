import type { AgentEvent, AgentMessage, SubagentThreadItem, UsageTotals } from "@arbor-space/core";

export type ItemStatus = "running" | "done" | "error";

export type Item =
	| { id: string; kind: "user"; text: string }
	| { id: string; kind: "assistant"; text: string; thinking?: string; streaming: boolean }
	| { id: string; kind: "thinking"; text: string }
	| {
			id: string;
			kind: "tool";
			toolName: string;
			args: string;
			status: ItemStatus;
			output: string;
			diff?: string;
			filePath?: string;
			/** Present on `task` tool calls: the live subagent transcript. */
			thread?: SubagentThreadItem[];
			agent?: string;
			streamingText?: string;
	  }
	| { id: string; kind: "sys"; text: string }
	| { id: string; kind: "job"; text: string };

export interface SessionModelState {
	items: Item[];
	running: boolean;
	usage: UsageTotals | null;
	view: "main" | { subagent: string };
}

export type ModelListener = (state: SessionModelState) => void;

let counter = 0;
const nextId = (): string => `i${counter++}`;

function assistantText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return "";
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c): c is { type: "text"; text: string } =>
				typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
		)
		.map((c) => c.text)
		.join("\n");
}

/** Concatenate reasoning/thinking blocks carried on an assistant message. */
function thinkingText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c): c is { type: "thinking"; thinking: string } =>
				typeof c === "object" && c !== null && (c as { type?: string }).type === "thinking",
		)
		.map((c) => c.thinking)
		.join("\n");
}

function summarizeArgs(args: unknown): string {
	if (args && typeof args === "object" && "command" in args) {
		return String((args as { command: unknown }).command);
	}
	if (args && typeof args === "object" && "path" in args) {
		return String((args as { path: unknown }).path);
	}
	try {
		return JSON.stringify(args);
	} catch {
		return "";
	}
}

function extractFilePath(args: unknown): string | undefined {
	if (args && typeof args === "object" && "path" in args) {
		const p = (args as { path: unknown }).path;
		return typeof p === "string" ? p : undefined;
	}
	return undefined;
}

/** Pull the named agent type from a `task` tool call's args. */
function extractAgent(args: unknown): string | undefined {
	if (args && typeof args === "object" && "agent" in args) {
		const a = (args as { agent: unknown }).agent;
		return typeof a === "string" ? a : undefined;
	}
	return undefined;
}

/** The subset of TaskToolDetails carried on live tool updates. */
interface TaskLiveDetails {
	agent?: string;
	thread?: SubagentThreadItem[];
	streamingText?: string;
}

export class SessionModel {
	private state: SessionModelState = { items: [], running: false, usage: null, view: "main" };
	private listeners = new Set<ModelListener>();

	subscribe(fn: ModelListener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	get(): SessionModelState {
		return this.state;
	}

	private update(patch: Partial<SessionModelState>): void {
		this.state = { ...this.state, ...patch };
		for (const fn of this.listeners) fn(this.state);
	}

	private patchItem(id: string, patch: Partial<Item>): void {
		this.state = {
			...this.state,
			items: this.state.items.map((it) => (it.id === id ? ({ ...it, ...patch } as Item) : it)),
		};
		for (const fn of this.listeners) fn(this.state);
	}

	/** Apply an AgentEvent from the session. */
	handle(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.update({ running: true });
				break;
			case "agent_end":
				this.update({ running: false });
				break;
			case "message_start": {
				const msg = event.message;
				const role = (msg as { role?: string }).role;
				if (role === "user") {
					const text = typeof msg.content === "string" ? msg.content : "";
					this.update({ items: [...this.state.items, { id: nextId(), kind: "user", text }] });
				} else if (role === "assistant") {
					const thinking = thinkingText(msg);
					this.update({
						items: [
							...this.state.items,
							{
								id: nextId(),
								kind: "assistant",
								text: "",
								...(thinking ? { thinking } : {}),
								streaming: true,
							},
						],
					});
				}
				break;
			}
			case "message_update":
			case "message_end": {
				if ((event.message as { role?: string }).role !== "assistant") break;
				const text = assistantText(event.message);
				const thinking = thinkingText(event.message);
				const last = this.state.items[this.state.items.length - 1];
				if (last && last.kind === "assistant") {
					this.patchItem(last.id, {
						text,
						...(thinking ? { thinking } : {}),
						...(event.type === "message_end" ? { streaming: false } : {}),
					});
				}
				break;
			}
			case "tool_execution_start": {
				const filePath = extractFilePath(event.args);
				const agent = extractAgent(event.args);
				const item: Item = {
					id: event.toolCallId,
					kind: "tool",
					toolName: event.toolName,
					args: summarizeArgs(event.args),
					status: "running",
					output: "",
					...(filePath ? { filePath } : {}),
					...(agent ? { agent } : {}),
				};
				this.update({ items: [...this.state.items, item] });
				break;
			}
			case "tool_execution_update": {
				const details = (event.partialResult as { details?: TaskLiveDetails })?.details;
				const patch: Partial<Extract<Item, { kind: "tool" }>> = {};
				const str = extractResultText(event.partialResult);
				if (str) patch.output = str;
				if (details) {
					if (details.thread) patch.thread = details.thread;
					if (details.streamingText !== undefined) patch.streamingText = details.streamingText;
					if (details.agent) patch.agent = details.agent;
				}
				if (Object.keys(patch).length > 0) this.patchItem(event.toolCallId, patch);
				break;
			}
			case "tool_execution_end": {
				const resultText = extractResultText(event.result);
				const diff = (event.result.details as { diff?: string } | undefined)?.diff;
				const live = (event.result.details as TaskLiveDetails | undefined) ?? undefined;
				this.patchItem(event.toolCallId, {
					status: event.isError ? "error" : "done",
					output: resultText,
					...(diff ? { diff } : {}),
					...(live?.thread ? { thread: live.thread } : {}),
					...(live?.streamingText !== undefined ? { streamingText: live.streamingText } : {}),
					...(live?.agent ? { agent: live.agent } : {}),
				});
				break;
			}
			case "usage_update":
				this.update({ usage: event.totals });
				break;
			case "job_notification":
				this.update({ items: [...this.state.items, { id: nextId(), kind: "job", text: event.text }] });
				break;
			default:
				break;
		}
	}

	setView(view: SessionModelState["view"]): void {
		this.update({ view });
	}

	/** Task-tool calls with a surfaced thread, for Ctrl+T agent switching. */
	subagentThreads(): { id: string; agent?: string; status: ItemStatus; toolCount: number }[] {
		return this.state.items
			.filter((it): it is Extract<Item, { kind: "tool" }> => it.kind === "tool" && it.toolName === "task")
			.map((it) => ({
				id: it.id,
				...(it.agent ? { agent: it.agent } : {}),
				status: it.status,
				toolCount: it.thread?.filter((t) => t.type === "tool").length ?? 0,
			}));
	}
}

function extractResultText(result: unknown): string {
	const content = (result as { content?: unknown })?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c): c is { type: "text"; text: string } =>
				typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
		)
		.map((c) => c.text)
		.join("\n");
}
