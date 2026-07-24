import { afterEach, beforeEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AgentSession,
	type AgentTool,
	type AgentToolResult,
	SessionManager,
	type StreamFn,
} from "@arbor-space/core";
import { createCodingTools } from "@arbor-space/core/tools";
import {
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { createTestRenderer } from "@opentui/core/testing";
import { createTuiApp } from "../src/app.ts";

let workspace: string;
let faux: FauxProviderHandle;
let streamFn: StreamFn;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "arbor-tui-ws-"));
	faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	streamFn = (model: unknown, context: unknown, options: unknown) =>
		models.streamSimple(model as never, context as never, options as never);
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
});

function makeSession() {
	return new AgentSession({
		cwd: workspace,
		model: faux.getModel(),
		streamFn,
		systemPrompt: "You are Arbor.",
		tools: createCodingTools(workspace),
		sessionManager: SessionManager.inMemory(workspace),
	});
}

/** A fake `task` tool that returns a subagent thread in its details. */
function fakeTaskTool(): AgentTool {
	return {
		name: "task",
		label: "Task",
		mutates: false,
		description: "fake task",
		parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
		async execute(_id, params): Promise<AgentToolResult> {
			const agent = (params as { agent?: string }).agent;
			return {
				content: [{ type: "text", text: "Subagent report." }],
				details: {
					...(agent ? { agent } : {}),
					messageCount: 1,
					toolSummaries: ["grep: 3 matches"],
					thread: [
						{ type: "text", text: "Scanning." },
						{ type: "tool", toolName: "grep", summary: "3 matches" },
						{ type: "text", text: "Subagent report." },
					],
					streamingText: "Subagent report.",
					exitCode: 0,
				},
			};
		},
	};
}

describe("tui app", () => {
	it("renders the user message and assistant reply", async () => {
		faux.setResponses([fauxAssistantMessage("Hi there from the agent.")]);
		const { renderer, flush, captureCharFrame } = await createTestRenderer({
			width: 60,
			height: 12,
		});
		const session = makeSession();
		const app = createTuiApp(renderer, session);
		try {
			await session.prompt("hello arbor");
			await flush();
			const frame = captureCharFrame();
			assert.ok(frame.includes("hello arbor"), "user message should render");
			assert.ok(frame.includes("Hi there from the agent."), "assistant reply should render");
		} finally {
			app.destroy();
			renderer.destroy();
		}
	});

	it("shows running then idle in the status line", async () => {
		faux.setResponses([fauxAssistantMessage("done.")]);
		const { renderer, flush, captureCharFrame } = await createTestRenderer({
			width: 60,
			height: 12,
		});
		const session = makeSession();
		const app = createTuiApp(renderer, session);
		try {
			await session.prompt("go");
			await flush();
			const frame = captureCharFrame();
			assert.ok(frame.includes("idle"), "status should settle to idle after the run");
		} finally {
			app.destroy();
			renderer.destroy();
		}
	});

	it("renders an edit tool diff", async () => {
		await writeFile(path.join(workspace, "foo.txt"), "old line\n");
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "foo.txt", edits: [{ oldText: "old line", newText: "new line" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Edited."),
		]);
		const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 60, height: 12 });
		const session = makeSession();
		const app = createTuiApp(renderer, session);
		try {
			await session.prompt("edit foo.txt");
			await flush();
			const frame = captureCharFrame();
			assert.ok(frame.includes("new line"), "diff added line should render");
			assert.ok(frame.includes("old line"), "diff removed line should render");
		} finally {
			app.destroy();
			renderer.destroy();
		}
	});

	it("renders a subagent inline block and switches to its thread on Ctrl+T", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("task", { prompt: "audit", agent: "scout" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done."),
		]);
		const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 60, height: 14 });
		const session = new AgentSession({
			cwd: workspace,
			model: faux.getModel(),
			streamFn,
			systemPrompt: "You are Arbor.",
			tools: [...createCodingTools(workspace), fakeTaskTool()],
			sessionManager: SessionManager.inMemory(workspace),
		});
		const app = createTuiApp(renderer, session);
		try {
			await session.prompt("run a subagent");
			await flush();
			let frame = captureCharFrame();
			assert.ok(frame.includes("scout"), "subagent inline block renders the agent name");
			assert.ok(frame.includes("Ctrl+T"), "block shows the switch hint");

			// Ctrl+T switches the scrollback to the subagent thread view.
			renderer.keyInput.emit("keypress", { name: "t", ctrl: true, sequence: "" } as never);
			await flush();
			frame = captureCharFrame();
			assert.ok(frame.includes("Scanning."), "thread view renders the subagent text");
			assert.ok(frame.includes("[grep] 3 matches"), "thread view renders the subagent tool");
		} finally {
			app.destroy();
			renderer.destroy();
		}
	});
});
