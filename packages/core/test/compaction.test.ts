/** Compaction tests: thresholds, cut points, LLM summarization via faux provider. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { compactMessages, estimateTokens, findCutPoint, shouldCompact } from "../src/session/compaction.ts";
import type { AgentMessage, StreamFn } from "../src/types.ts";

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function toolResult(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

describe("estimateTokens / shouldCompact", () => {
	it("estimates roughly chars/4", () => {
		const tokens = estimateTokens([user("x".repeat(4000))]);
		assert.ok(tokens > 900 && tokens < 1200, `got ${tokens}`);
	});

	it("compacts only when past window minus reserve", () => {
		const small = [user("short")];
		assert.equal(shouldCompact(small, 200_000), false);
		const big = [user("x".repeat(900_000))];
		assert.equal(shouldCompact(big, 200_000), true);
	});

	it("never compacts without a known context window", () => {
		const big = [user("x".repeat(900_000))];
		assert.equal(shouldCompact(big, undefined), false);
	});
});

describe("findCutPoint", () => {
	it("keeps the newest messages within budget", () => {
		const messages = [user("old ".repeat(2000)), user("mid ".repeat(2000)), user("new")];
		const cut = findCutPoint(messages, 100);
		assert.equal(cut, 2);
	});

	it("never cuts at a tool result", () => {
		const messages = [user("old ".repeat(2000)), toolResult("output"), user("new")];
		// Budget large enough to reach the toolResult but not past it.
		const cut = findCutPoint(messages, estimateTokens([toolResult("output"), user("new")]));
		// Cut index must not point at the toolResult.
		const target = messages[cut] as { role?: string };
		assert.notEqual(target?.role, "toolResult");
	});

	it("keeps everything when budget covers the whole conversation", () => {
		const messages = [user("a"), user("b")];
		assert.equal(findCutPoint(messages, 100_000), 0);
	});
});

describe("compactMessages", () => {
	function setup() {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const streamFn: StreamFn = (model, context, options) => models.streamSimple(model, context, options);
		return { faux, streamFn };
	}

	it("summarizes old messages and keeps the recent tail", async () => {
		const { faux, streamFn } = setup();
		faux.setResponses([fauxAssistantMessage("## Goal\nDo the thing\n## State\nDone A\n## Open items\nB")]);

		const messages = [user("old ".repeat(3000)), user("also old ".repeat(3000)), user("recent")];
		const result = await compactMessages(messages, faux.getModel(), streamFn, {
			keepRecentTokens: 50,
		});

		assert.match(result.summary, /## Goal/);
		assert.equal(result.keepMessages.length, 1);
		assert.equal((result.keepMessages[0] as { content: string }).content, "recent");
		assert.ok(result.tokensBefore > 0);
		assert.ok(result.usage);
	});

	it("folds a previous summary into the new one", async () => {
		const { faux, streamFn } = setup();
		let sawPrevious = false;
		faux.setResponses([
			(context: { messages: { content: unknown }[] }) => {
				const input = JSON.stringify(context.messages);
				sawPrevious = /EARLIER SUMMARY/.test(input);
				return fauxAssistantMessage("merged summary");
			},
		]);

		const messages = [user("old ".repeat(3000)), user("recent")];
		const result = await compactMessages(
			messages,
			faux.getModel(),
			streamFn,
			{ keepRecentTokens: 10 },
			"EARLIER SUMMARY",
		);
		assert.equal(sawPrevious, true);
		assert.equal(result.summary, "merged summary");
	});

	it("returns without an LLM call when nothing needs summarizing", async () => {
		const { faux, streamFn } = setup();
		// No responses queued: an LLM call would throw.
		const messages = [user("recent")];
		const result = await compactMessages(messages, faux.getModel(), streamFn, {
			keepRecentTokens: 100_000,
		});
		assert.equal(result.keepMessages.length, 1);
		assert.equal(faux.getPendingResponseCount(), 0);
	});

	it("throws when the summarizer errors", async () => {
		const { faux, streamFn } = setup();
		faux.setResponses([fauxAssistantMessage("x", { stopReason: "error", errorMessage: "summarizer down" })]);
		const messages = [user("old ".repeat(3000)), user("recent")];
		await assert.rejects(
			compactMessages(messages, faux.getModel(), streamFn, { keepRecentTokens: 10 }),
			/summarizer down/,
		);
	});
});
