import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { type Item, SessionModel } from "../src/event-bridge.ts";

/** Build an assistant message content array with optional text + thinking. */
function assistantContent(text?: string, thinking?: string) {
	const blocks: { type: string; text?: string; thinking?: string }[] = [];
	if (thinking) blocks.push({ type: "thinking", thinking });
	if (text) blocks.push({ type: "text", text });
	return blocks;
}

describe("event-bridge SessionModel", () => {
	it("extracts thinking blocks onto the assistant item", () => {
		const model = new SessionModel();
		model.handle({ type: "agent_start" });
		model.handle({
			type: "message_start",
			message: { role: "assistant", content: assistantContent(undefined, "initial thought") } as never,
		});
		model.handle({
			type: "message_update",
			message: { role: "assistant", content: assistantContent("hello", "initial thought\nmore") } as never,
			assistantMessageEvent: { type: "text_delta" } as never,
		});
		model.handle({
			type: "message_end",
			message: { role: "assistant", content: assistantContent("hello", "initial thought\nmore") } as never,
		});

		const items = model.get().items;
		const asst = items.find((i) => i.kind === "assistant");
		assert.ok(asst && asst.kind === "assistant");
		assert.equal(asst.text, "hello");
		assert.equal(asst.thinking, "initial thought\nmore");
		assert.equal(asst.streaming, false);
	});

	it("tracks a task tool's live subagent thread", () => {
		const model = new SessionModel();
		model.handle({ type: "agent_start" });
		model.handle({
			type: "tool_execution_start",
			toolCallId: "tc1",
			toolName: "task",
			args: { prompt: "audit", agent: "scout" },
		});
		model.handle({
			type: "tool_execution_update",
			toolCallId: "tc1",
			toolName: "task",
			args: { prompt: "audit" },
			partialResult: {
				content: [{ type: "text", text: "[grep] 3 matches" }],
				details: {
					agent: "scout",
					streamingText: "working",
					thread: [
						{ type: "text", text: "working" },
						{ type: "tool", toolName: "grep", summary: "3 matches" },
					],
				},
			},
		});
		model.handle({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "task",
			isError: false,
			result: {
				content: [{ type: "text", text: "Final report" }],
				details: {
					agent: "scout",
					streamingText: "Final report",
					thread: [
						{ type: "text", text: "working" },
						{ type: "tool", toolName: "grep", summary: "3 matches" },
						{ type: "text", text: "Final report" },
					],
				},
			},
		});

		const tool = model.get().items.find((i) => i.kind === "tool") as Extract<Item, { kind: "tool" }>;
		assert.ok(tool);
		assert.equal(tool.agent, "scout");
		assert.equal(tool.status, "done");
		assert.equal(tool.thread?.length, 3);
		assert.equal(tool.streamingText, "Final report");

		const threads = model.subagentThreads();
		assert.equal(threads.length, 1);
		assert.equal(threads[0]?.agent, "scout");
		assert.equal(threads[0]?.toolCount, 1);
	});

	it("reports multiple parallel task tools as switchable threads", () => {
		const model = new SessionModel();
		model.handle({ type: "agent_start" });
		for (const id of ["tc-a", "tc-b"]) {
			model.handle({
				type: "tool_execution_start",
				toolCallId: id,
				toolName: "task",
				args: { prompt: "p" },
			});
			model.handle({
				type: "tool_execution_update",
				toolCallId: id,
				toolName: "task",
				args: { prompt: "p" },
				partialResult: {
					content: [{ type: "text", text: "t" }],
					details: {
						streamingText: "t",
						thread: [{ type: "text", text: "t" }],
					},
				},
			});
		}
		const threads = model.subagentThreads();
		assert.equal(threads.length, 2);
		assert.equal(threads[0]?.id, "tc-a");
		assert.equal(threads[1]?.id, "tc-b");
	});
});
