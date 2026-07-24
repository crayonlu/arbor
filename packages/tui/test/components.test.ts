import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { createTestRenderer } from "@opentui/core/testing";
import { createCommandPalette } from "../src/components/command-palette.ts";
import { createSubagentBlock, createSubagentThreadView } from "../src/components/subagent.ts";
import { createThinkingTail } from "../src/components/thinking.ts";
import { createTodoPanel } from "../src/components/todo-panel.ts";
import type { Item } from "../src/event-bridge.ts";
import { darkTheme } from "../src/theme.ts";

function taskItem(overrides: Partial<Extract<Item, { kind: "tool" }>> = {}): Extract<Item, { kind: "tool" }> {
	return {
		id: "tc1",
		kind: "tool",
		toolName: "task",
		args: "audit the code",
		status: "running",
		output: "",
		agent: "scout",
		thread: [
			{ type: "text", text: "Looking around." },
			{ type: "tool", toolName: "grep", summary: "3 matches" },
		],
		streamingText: "Looking around.",
		...overrides,
	};
}

describe("subagent components", () => {
	it("inline block shows agent, status, and the Ctrl+T hint", async () => {
		const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 50, height: 8 });
		const block = createSubagentBlock(renderer, darkTheme, taskItem());
		renderer.root.add(block.container);
		await flush();
		const frame = captureCharFrame();
		assert.match(frame, /scout/);
		assert.match(frame, /running/);
		assert.match(frame, /Ctrl\+T/);
	});

	it("thread view renders the ordered transcript", async () => {
		const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 50, height: 10 });
		const view = createSubagentThreadView(renderer, darkTheme, taskItem());
		renderer.root.add(view.container);
		await flush();
		const frame = captureCharFrame();
		assert.ok(frame.includes("Looking around."), "assistant text should render");
		assert.ok(frame.includes("[grep] 3 matches"), "tool summary should render");
		assert.ok(frame.includes("Ctrl+T"), "back hint should render");
	});
});

describe("todo panel", () => {
	it("renders the count and each item", async () => {
		const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 40, height: 8 });
		const panel = createTodoPanel(renderer, darkTheme);
		renderer.root.add(panel.container);
		panel.update([
			{ text: "scan files", status: "completed" },
			{ text: "write tests", status: "in_progress" },
			{ text: "ship it", status: "pending" },
		]);
		await flush();
		const frame = captureCharFrame();
		assert.match(frame, /1\/3/);
		assert.ok(frame.includes("scan files"));
		assert.ok(frame.includes("write tests"));
	});

	it("renders nothing when empty", async () => {
		const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 40, height: 4 });
		const panel = createTodoPanel(renderer, darkTheme);
		renderer.root.add(panel.container);
		panel.update([]);
		await flush();
		assert.equal(captureCharFrame().trim(), "");
	});
});

describe("thinking tail", () => {
	it("keeps only the trailing lines", async () => {
		const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 40, height: 12 });
		const tail = createThinkingTail(renderer, darkTheme, { width: 38 });
		renderer.root.add(tail.container);
		const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
		tail.update(long, true);
		await flush();
		const frame = captureCharFrame();
		assert.ok(frame.includes("line 19"), "newest line kept");
		assert.ok(!frame.includes("line 0"), "oldest line scrolled off");
	});
});

describe("command palette", () => {
	const commands = [
		{ category: "session", name: "rewind", description: "Rewind" },
		{ category: "model", name: "set", description: "Choose a model" },
		{ category: "mode", name: "plan", description: "Plan mode" },
	];

	it("filters by subsequence and ranks by category", async () => {
		const { renderer } = await createTestRenderer({ width: 50, height: 12 });
		const palette = createCommandPalette(renderer, darkTheme, commands, {
			width: 48,
			maxHeight: 8,
		});
		palette.setQuery("se");
		const names = palette.results().map((c) => c.name);
		assert.ok(names.includes("set"), "model set matches 'se'");
		assert.ok(names.includes("rewind"), "rewind matches 'se' (subsequence)");
		assert.ok(!names.includes("plan"), "plan does not match 'se'");
		// session ranks before model.
		assert.ok(names.indexOf("rewind") < names.indexOf("set"));
	});

	it("selectedText builds the two-level path", async () => {
		const { renderer } = await createTestRenderer({ width: 50, height: 12 });
		const palette = createCommandPalette(renderer, darkTheme, commands, { width: 48, maxHeight: 8 });
		palette.setQuery("plan");
		assert.equal(palette.selectedText(), "/mode plan");
	});

	it("move wraps the selection", async () => {
		const { renderer } = await createTestRenderer({ width: 50, height: 12 });
		const palette = createCommandPalette(renderer, darkTheme, commands, { width: 48, maxHeight: 8 });
		palette.setQuery("");
		palette.move(-1);
		assert.equal(palette.selectedIndex(), palette.results().length - 1);
	});
});
