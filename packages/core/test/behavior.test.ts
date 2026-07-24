/** Tests for todo, modes (plan), and goal. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGoalState, goalPromptSection, goalReminderMessage } from "../src/goal.ts";
import { createExitPlanTool, filterToolsForMode, modePromptSection, PLAN_MODE_PROMPT } from "../src/modes.ts";
import { createTodoStore, createTodoTool } from "../src/tools/todo.ts";
import type { AgentTool } from "../src/types.ts";

function tool(name: string, mutates?: boolean): AgentTool<any> {
	return {
		name,
		label: name,
		description: name,
		...(mutates !== undefined ? { mutates } : {}),
		parameters: {} as never,
		execute: async () => ({ content: [], details: undefined }),
	};
}

describe("todo tool", () => {
	it("replaces the list and renders status markers", async () => {
		const changes: unknown[] = [];
		const store = createTodoStore((todos) => changes.push(todos));
		const todoTool = createTodoTool(store);

		const result = await todoTool.execute("t1", {
			todos: [
				{ text: "explore", status: "completed" },
				{ text: "implement", status: "in_progress" },
				{ text: "test", status: "pending" },
			],
		});

		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /\[x\] explore/);
		assert.match(text, /\[~\] implement/);
		assert.match(text, /\[ \] test/);
		assert.equal(store.get().length, 3);
		assert.equal(changes.length, 1);
	});

	it("handles an empty list", async () => {
		const store = createTodoStore();
		const todoTool = createTodoTool(store);
		const result = await todoTool.execute("t1", { todos: [] });
		assert.match((result.content[0] as { text: string }).text, /empty/);
	});
});

describe("plan mode", () => {
	it("filterToolsForMode drops mutating tools in plan mode", () => {
		const tools = [tool("read"), tool("bash", true), tool("edit", true), tool("grep")];
		const planTools = filterToolsForMode(tools, "plan");
		assert.deepEqual(
			planTools.map((t) => t.name),
			["read", "grep"],
		);
		const buildTools = filterToolsForMode(tools, "build");
		assert.equal(buildTools.length, 4);
	});

	it("exit_plan delivers the plan and terminates the batch", async () => {
		let received: string | undefined;
		const exitPlan = createExitPlanTool((plan) => {
			received = plan;
		});
		const result = await exitPlan.execute("t1", { plan: "# The plan\n1. do things" });
		assert.equal(received, "# The plan\n1. do things");
		assert.equal(result.terminate, true);
	});

	it("modePromptSection returns the plan prompt only in plan mode", () => {
		assert.equal(modePromptSection("build"), "");
		assert.equal(modePromptSection("plan"), PLAN_MODE_PROMPT);
	});
});

describe("goal", () => {
	it("stores and clears the goal", () => {
		const changes: (string | null)[] = [];
		const state = createGoalState((g) => changes.push(g));
		assert.equal(state.get(), null);
		state.set("ship v1");
		assert.equal(state.get(), "ship v1");
		state.set(null);
		assert.equal(state.get(), null);
		assert.deepEqual(changes, ["ship v1", null]);
	});

	it("prompt section is empty without a goal and directive with one", () => {
		assert.equal(goalPromptSection(null), "");
		assert.match(goalPromptSection("ship v1"), /ship v1/);
		assert.match(goalPromptSection("ship v1"), /Active goal/);
	});

	it("reminder message names the goal", () => {
		const message = goalReminderMessage("ship v1") as { role: string; content: string };
		assert.equal(message.role, "user");
		assert.match(message.content, /ship v1/);
	});
});
