/** ask tool tests. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AskUiQuestion, ExtensionUi } from "../src/extensions/types.ts";
import { filterToolsForMode } from "../src/modes.ts";
import { createAskTool } from "../src/tools/ask.ts";

function makeUi(overrides: Partial<ExtensionUi> = {}): ExtensionUi {
	return {
		notify: () => {},
		confirm: async () => false,
		input: async () => undefined,
		select: async () => undefined,
		...overrides,
	};
}

function text(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((c) => c.text ?? "").join("");
}

describe("ask tool", () => {
	it("uses ui.ask when available and reports answers", async () => {
		const seen: AskUiQuestion[] = [];
		const ui = makeUi({
			ask: async (q) => {
				seen.push(q);
				return [q.options[0]?.label ?? ""];
			},
		});
		const tool = createAskTool(ui);
		const result = await tool.execute("a1", {
			questions: [
				{
					question: "Which database?",
					options: [
						{ label: "Postgres", description: "relational" },
						{ label: "SQLite", description: "embedded" },
					],
				},
			],
		});
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.options.length, 2);
		assert.match(text(result), /"Which database\?" → Postgres/);
		assert.deepEqual(result.details.answers, [["Postgres"]]);
	});

	it("multiSelect answers join with commas", async () => {
		const ui = makeUi({ ask: async () => ["A", "C"] });
		const tool = createAskTool(ui);
		const result = await tool.execute("a2", {
			questions: [
				{
					question: "Pick features",
					options: [{ label: "A" }, { label: "B" }, { label: "C" }],
					multiSelect: true,
				},
			],
		});
		assert.match(text(result), /Pick features" → A, C/);
	});

	it("falls back to ui.select when ask is not implemented", async () => {
		let selectTitle = "";
		let selectOptions: string[] = [];
		const ui = makeUi({
			select: async (title, options) => {
				selectTitle = title;
				selectOptions = options;
				return options[1];
			},
		});
		const tool = createAskTool(ui);
		const result = await tool.execute("a3", {
			questions: [{ question: "Approach?", options: [{ label: "Fast" }, { label: "Thorough" }] }],
		});
		assert.equal(selectTitle, "Approach?");
		assert.deepEqual(selectOptions, ["Fast", "Thorough"]);
		assert.deepEqual(result.details.answers, [["Thorough"]]);
	});

	it("unanswered questions resolve as text, not errors", async () => {
		const tool = createAskTool(makeUi());
		const result = await tool.execute("a4", {
			questions: [{ question: "Anyone there?", options: [{ label: "Yes" }, { label: "No" }] }],
		});
		assert.match(text(result), /did not answer/);
		assert.deepEqual(result.details.answers, [null]);
	});

	it("asks multiple questions in order", async () => {
		const asked: string[] = [];
		const ui = makeUi({
			ask: async (q) => {
				asked.push(q.question);
				return [q.options[0]?.label ?? ""];
			},
		});
		const tool = createAskTool(ui);
		await tool.execute("a5", {
			questions: [
				{ question: "First?", options: [{ label: "1a" }, { label: "1b" }] },
				{ question: "Second?", options: [{ label: "2a" }, { label: "2b" }] },
			],
		});
		assert.deepEqual(asked, ["First?", "Second?"]);
	});

	it("remains visible in plan mode (does not mutate)", () => {
		const tool = createAskTool(makeUi());
		assert.notEqual(tool.mutates, true);
		const filtered = filterToolsForMode([tool], "plan");
		assert.equal(filtered.length, 1);
	});
});
