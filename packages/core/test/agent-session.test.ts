/** AgentSession integration tests: the fully-wired harness with faux provider. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { AgentSession } from "../src/agent-session.ts";
import { ExtensionRunner } from "../src/extensions/runner.ts";
import { BackgroundJobs } from "../src/jobs/registry.ts";
import { SessionManager } from "../src/session/manager.ts";
import { SnapshotManager } from "../src/session/snapshot.ts";
import { createCodingTools } from "../src/tools/index.ts";
import type { StreamFn } from "../src/types.ts";

let workspace: string;
let snapshotsRoot: string;
let faux: FauxProviderHandle;
let streamFn: StreamFn;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "arbor-session-ws-"));
	snapshotsRoot = await mkdtemp(path.join(os.tmpdir(), "arbor-session-snap-"));
	faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	streamFn = (model, context, options) => models.streamSimple(model, context, options);
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	await rm(snapshotsRoot, { recursive: true, force: true });
});

function makeSession(overrides: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
	return new AgentSession({
		cwd: workspace,
		model: faux.getModel(),
		streamFn,
		systemPrompt: "You are Arbor, a coding agent.",
		tools: createCodingTools(workspace),
		sessionManager: SessionManager.inMemory(workspace),
		...overrides,
	});
}

describe("AgentSession", () => {
	it("runs a prompt end-to-end and persists messages to the session tree", async () => {
		faux.setResponses([fauxAssistantMessage("Hi there!")]);
		const session = makeSession();
		const newMessages = await session.prompt("hello");
		assert.equal(newMessages.length, 2);
		const entries = session.session.getAllEntries().filter((e) => e.type === "message");
		assert.equal(entries.length, 2);
		assert.equal(session.getMessages().length, 2);
	});

	it("forwards thinkingLevel to the stream call as reasoning", async () => {
		faux.setResponses([fauxAssistantMessage("ok")]);
		const seen: unknown[] = [];
		const capturingStream: StreamFn = (model, context, options) => {
			seen.push(options);
			return streamFn(model, context, options);
		};
		const session = makeSession({ streamFn: capturingStream, thinkingLevel: "high" });
		await session.prompt("think hard");
		assert.ok(seen.length > 0, "stream was called");
		assert.equal((seen[0] as { reasoning?: string })?.reasoning, "high");

		// Live change takes effect on the next turn.
		session.thinkingLevel = "off";
		seen.length = 0;
		faux.setResponses([fauxAssistantMessage("ok2")]);
		await session.prompt("again");
		assert.notEqual((seen[0] as { reasoning?: string })?.reasoning, "high");
	});

	it("executes real file tools in the workspace", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "hello.txt", content: "from the agent" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("File written."),
		]);
		const session = makeSession();
		await session.prompt("create hello.txt");
		assert.equal(await readFile(path.join(workspace, "hello.txt"), "utf-8"), "from the agent");
	});

	it("takes a workspace snapshot before each prompt when snapshots are enabled", async () => {
		faux.setResponses([fauxAssistantMessage("done")]);
		await writeFile(path.join(workspace, "existing.txt"), "v1");
		const session = makeSession({
			snapshots: new SnapshotManager(workspace, { snapshotsRoot }),
		});
		await session.prompt("look around");
		const snapshotEntries = session.session.getAllEntries().filter((e) => e.type === "snapshot");
		assert.equal(snapshotEntries.length, 1);
	});

	it("rewinds conversation and files together", async () => {
		const snapshots = new SnapshotManager(workspace, { snapshotsRoot });
		const session = makeSession({ snapshots });

		await writeFile(path.join(workspace, "app.ts"), "GOOD");
		faux.setResponses([fauxAssistantMessage("First done.")]);
		await session.prompt("first task");
		const firstUserEntry = session.session
			.getAllEntries()
			.find((e) => e.type === "message" && (e.message as { role: string }).role === "user");
		assert.ok(firstUserEntry);

		// Second turn ruins the file.
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "app.ts", content: "BROKEN" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Broke it."),
		]);
		await session.prompt("second task");
		assert.equal(await readFile(path.join(workspace, "app.ts"), "utf-8"), "BROKEN");

		await session.rewind(firstUserEntry.id);
		assert.equal(await readFile(path.join(workspace, "app.ts"), "utf-8"), "GOOD");
		const contents = session.getMessages().map((m) => JSON.stringify(m));
		assert.ok(!contents.some((c) => c.includes("second task")));
	});

	it("extension tool_call block reaches the loop", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf /" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Understood."),
		]);
		const extensions = new ExtensionRunner();
		await extensions.register((api) => {
			api.on("tool_call", (event) => {
				if (event.toolName === "bash" && String((event.input as any).command).includes("rm -rf")) {
					return { block: true, reason: "dangerous command blocked by extension" };
				}
				return undefined;
			});
		});
		const session = makeSession({ extensions });
		const messages = await session.prompt("clean up");
		const toolResult = messages.find((m: any) => m.role === "toolResult") as any;
		assert.equal(toolResult.isError, true);
		assert.match(toolResult.content[0].text, /blocked by extension/);
	});

	it("plan mode hides mutating tools and captures the plan", async () => {
		faux.setResponses([
			(context: { tools?: { name: string }[] }) => {
				const toolNames = (context.tools ?? []).map((t) => t.name);
				// Mutating tools are hidden; exit_plan is present.
				assert.ok(!toolNames.includes("write"));
				assert.ok(!toolNames.includes("bash"));
				assert.ok(toolNames.includes("read"));
				assert.ok(toolNames.includes("exit_plan"));
				return fauxAssistantMessage([fauxToolCall("exit_plan", { plan: "# Plan\n1. step one" })], {
					stopReason: "toolUse",
				});
			},
		]);
		const session = makeSession({ mode: "plan" });
		await session.prompt("design the feature");
		assert.equal(session.takePendingPlan(), "# Plan\n1. step one");
		assert.equal(session.takePendingPlan(), null, "plan is consumed once");
	});

	it("todo tool persists todos into the session as custom entries", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("todo", { todos: [{ text: "explore", status: "in_progress" }] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Planned."),
		]);
		const session = makeSession();
		await session.prompt("plan the work");
		assert.equal(session.todos.get().length, 1);
		const custom = session.session.getAllEntries().find((e) => e.type === "custom");
		assert.ok(custom && custom.type === "custom");
		assert.equal(custom.customType, "arbor:todos");
	});

	it("goal appears in the system prompt", async () => {
		let seenSystemPrompt = "";
		faux.setResponses([
			(context: { systemPrompt?: string }) => {
				seenSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("ok");
			},
		]);
		const session = makeSession();
		session.goal.set("ship the release");
		await session.prompt("continue");
		assert.match(seenSystemPrompt, /ship the release/);
	});

	it("compacts on overflow and retries", async () => {
		faux.setResponses([
			fauxAssistantMessage("x", {
				stopReason: "error",
				errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
			}),
			// Compaction summarizer call.
			fauxAssistantMessage("## Goal\nsummarized"),
			// Retried turn.
			fauxAssistantMessage("Recovered after compaction."),
		]);
		// Tiny keep budget so the compactor actually summarizes the prompt.
		const session = makeSession({ compaction: { keepRecentTokens: 1 } });
		const messages = await session.prompt(`big context ${"x".repeat(2000)}`);
		const finalAssistant = messages.filter((m: any) => m.role === "assistant").at(-1) as any;
		assert.equal(finalAssistant.content[0].text, "Recovered after compaction.");
		const compactionEntries = session.session.getAllEntries().filter((e) => e.type === "compaction");
		assert.equal(compactionEntries.length, 1);
	});

	it("steering messages queue while running and second prompt becomes steering", async () => {
		faux.setResponses([
			// Delay the first response so the second prompt arrives mid-run.
			async () => {
				await new Promise((r) => setTimeout(r, 100));
				return fauxAssistantMessage([fauxToolCall("ls", {})], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("Done with both."),
		]);
		const session = makeSession();
		const promptPromise = session.prompt("first");
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(session.isRunning, true);
		// While running, a second prompt is queued as steering.
		const second = await session.prompt("also do this");
		assert.deepEqual(second, []);
		const messages = await promptPromise;
		const userTexts = messages.filter((m: any) => m.role === "user").map((m: any) => m.content);
		assert.ok(userTexts.includes("also do this"));
	});

	it("clearSteering withdraws queued steering messages", async () => {
		faux.setResponses([
			async () => {
				await new Promise((r) => setTimeout(r, 100));
				return fauxAssistantMessage("Done.");
			},
		]);
		const session = makeSession();
		const promptPromise = session.prompt("first");
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(session.isRunning, true);
		session.steer("queued a");
		session.steer("queued b");
		assert.equal(session.hasPendingSteering(), true);
		assert.equal(session.clearSteering(), 2);
		assert.equal(session.hasPendingSteering(), false);
		await promptPromise;
	});

	it("resume rebuilds context from a persisted session file", async () => {
		const sessionsRoot = await mkdtemp(path.join(os.tmpdir(), "arbor-resume-"));
		try {
			faux.setResponses([fauxAssistantMessage("First reply.")]);
			const original = makeSession({
				sessionManager: SessionManager.create(workspace, { sessionsRoot }),
			});
			await original.prompt("remember this");

			const resumed = makeSession({
				sessionManager: SessionManager.load(original.session.filePath as string),
			});
			const contents = resumed.getMessages().map((m) => JSON.stringify(m));
			assert.ok(contents.some((c) => c.includes("remember this")));
			assert.ok(contents.some((c) => c.includes("First reply.")));
		} finally {
			await rm(sessionsRoot, { recursive: true, force: true });
		}
	});
});

describe("AgentSession background jobs", () => {
	it("job settling mid-run injects a notification as a follow-up turn", async () => {
		const jobs = new BackgroundJobs();
		let handle: ReturnType<BackgroundJobs["start"]> | undefined;
		const seenUserTexts: string[] = [];
		faux.setResponses([
			// First turn: settle a job while the agent is still running.
			async () => {
				handle = jobs.start({ type: "bash", title: "npm test" });
				handle.complete(0);
				// Give the async notification builder a tick to enqueue.
				await new Promise((r) => setTimeout(r, 50));
				return fauxAssistantMessage("First turn done.");
			},
			// Follow-up turn triggered by the notification.
			(context: { messages: { role: string; content: unknown }[] }) => {
				for (const m of context.messages) {
					if (m.role === "user" && typeof m.content === "string") seenUserTexts.push(m.content);
				}
				return fauxAssistantMessage("Acknowledged the job.");
			},
		]);
		const session = makeSession({ jobs });
		const messages = await session.prompt("run the tests in the background");
		const notification = seenUserTexts.find((t) => t.includes("[background job"));
		assert.ok(notification, "model saw the job notification");
		assert.match(notification, /completed \(exit 0\)/);
		assert.match(notification, /npm test/);
		const finalAssistant = messages.filter((m: any) => m.role === "assistant").at(-1) as any;
		assert.equal(finalAssistant.content[0].text, "Acknowledged the job.");
	});

	it("job settling while idle emits job_notification and queues a follow-up", async () => {
		const jobs = new BackgroundJobs();
		const session = makeSession({ jobs });
		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "job_notification") events.push(event.text);
		});

		const handle = jobs.start({ type: "task", title: "explore the codebase" });
		handle.fail("Exited with code 1", 1);
		await new Promise((r) => setTimeout(r, 50));

		assert.equal(events.length, 1);
		assert.match(events[0] ?? "", /\[background job .* failed \(exit 1\)\]/);
		assert.match(events[0] ?? "", /explore the codebase/);

		// The queued follow-up is delivered to the model on the next prompt.
		const seenUserTexts: string[] = [];
		faux.setResponses([
			(context: { messages: { role: string; content: unknown }[] }) => {
				for (const m of context.messages) {
					if (m.role === "user" && typeof m.content === "string") seenUserTexts.push(m.content);
				}
				return fauxAssistantMessage("Saw the failure.");
			},
		]);
		await session.prompt("what happened?");
		assert.ok(seenUserTexts.some((t) => t.includes("[background job")));
	});

	it("exposes the jobs tool to the model when a registry is provided", async () => {
		const jobs = new BackgroundJobs();
		jobs.start({ type: "bash", title: "npm run dev" });
		let toolNames: string[] = [];
		faux.setResponses([
			(context: { tools?: { name: string }[] }) => {
				toolNames = (context.tools ?? []).map((t) => t.name);
				return fauxAssistantMessage([fauxToolCall("jobs", { action: "list" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("One job running."),
		]);
		const session = makeSession({ jobs });
		const messages = await session.prompt("what jobs are running?");
		assert.ok(toolNames.includes("jobs"));
		const toolResult = messages.find((m: any) => m.role === "toolResult") as any;
		assert.match(toolResult.content[0].text, /npm run dev/);
		assert.match(toolResult.content[0].text, /\[running\]/);
	});

	it("omits the jobs tool without a registry", async () => {
		let toolNames: string[] = [];
		faux.setResponses([
			(context: { tools?: { name: string }[] }) => {
				toolNames = (context.tools ?? []).map((t) => t.name);
				return fauxAssistantMessage("ok");
			},
		]);
		const session = makeSession();
		await session.prompt("hello");
		assert.ok(!toolNames.includes("jobs"));
	});

	it("notification includes the log tail when a log file exists", async () => {
		const jobs = new BackgroundJobs();
		const session = makeSession({ jobs });
		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "job_notification") events.push(event.text);
		});

		const logPath = path.join(workspace, "job.log");
		await writeFile(logPath, "installed 42 packages\nbuild succeeded\n");
		const handle = jobs.start({ type: "bash", title: "npm install" });
		jobs.setLogPath(handle.id, logPath);
		handle.complete(0);
		await new Promise((r) => setTimeout(r, 50));

		assert.equal(events.length, 1);
		assert.match(events[0] ?? "", /Output file: .*job\.log/);
		assert.match(events[0] ?? "", /build succeeded/);
	});
});

describe("AgentSession context files", () => {
	it("discovered AGENTS.md content lands in the system prompt", async () => {
		await writeFile(path.join(workspace, "AGENTS.md"), "Always answer in haiku.");
		let seenSystemPrompt = "";
		faux.setResponses([
			(context: { systemPrompt?: string }) => {
				seenSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("ok");
			},
		]);
		const session = makeSession();
		await session.prompt("hello");
		assert.match(seenSystemPrompt, /# Project context/);
		assert.match(seenSystemPrompt, /Always answer in haiku\./);
	});

	it("contextFiles: false disables discovery", async () => {
		await writeFile(path.join(workspace, "AGENTS.md"), "Should not appear.");
		let seenSystemPrompt = "";
		faux.setResponses([
			(context: { systemPrompt?: string }) => {
				seenSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("ok");
			},
		]);
		const session = makeSession({ contextFiles: false });
		await session.prompt("hello");
		assert.doesNotMatch(seenSystemPrompt, /Should not appear/);
	});

	it("reloadContextFiles picks up new files", async () => {
		const session = makeSession();
		let seenSystemPrompt = "";
		faux.setResponses([
			(context: { systemPrompt?: string }) => {
				seenSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("ok");
			},
		]);
		await writeFile(path.join(workspace, "AGENTS.md"), "Added later.");
		session.reloadContextFiles();
		await session.prompt("hello");
		assert.match(seenSystemPrompt, /Added later\./);
	});
});

describe("AgentSession usage", () => {
	it("accumulates usage across prompts and emits usage_update", async () => {
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const session = makeSession();
		const updates: number[] = [];
		session.subscribe((event) => {
			if (event.type === "usage_update") updates.push(event.totals.responses);
		});
		await session.prompt("first");
		const afterFirst = session.getUsageTotals();
		assert.equal(afterFirst.responses, 1);
		assert.ok(afterFirst.totalTokens > 0);

		await session.prompt("second");
		const afterSecond = session.getUsageTotals();
		assert.equal(afterSecond.responses, 2);
		assert.ok(afterSecond.totalTokens > afterFirst.totalTokens);
		assert.deepEqual(updates, [1, 2]);
	});

	it("getUsageTotals returns a copy", async () => {
		faux.setResponses([fauxAssistantMessage("ok")]);
		const session = makeSession();
		await session.prompt("hello");
		const totals = session.getUsageTotals();
		totals.totalTokens = 999_999;
		totals.cost.total = 42;
		assert.notEqual(session.getUsageTotals().totalTokens, 999_999);
		assert.notEqual(session.getUsageTotals().cost.total, 42);
	});

	it("recomputes totals from a resumed session", async () => {
		const sessionsRoot = await mkdtemp(path.join(os.tmpdir(), "arbor-usage-resume-"));
		try {
			faux.setResponses([fauxAssistantMessage("persisted reply")]);
			const original = makeSession({
				sessionManager: SessionManager.create(workspace, { sessionsRoot }),
			});
			await original.prompt("hello");
			const originalTotals = original.getUsageTotals();
			assert.equal(originalTotals.responses, 1);

			const resumed = makeSession({
				sessionManager: SessionManager.load(original.session.filePath as string),
			});
			assert.deepEqual(resumed.getUsageTotals(), originalTotals);
		} finally {
			await rm(sessionsRoot, { recursive: true, force: true });
		}
	});
});

describe("AgentSession output persistence", () => {
	it("oversized extension tool output is persisted and previewed", async () => {
		const extensions = new ExtensionRunner();
		await extensions.register((api) => {
			api.registerTool({
				name: "dump",
				label: "Dump",
				description: "returns a huge blob",
				parameters: { type: "object", properties: {} } as never,
				execute: async () => ({
					content: [{ type: "text", text: "blob ".repeat(20000) }], // ~100KB
					details: {},
				}),
			});
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("dump", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Saw the dump."),
		]);
		const session = makeSession({
			extensions,
			outputPersistence: { root: path.join(workspace, "outputs") },
		});
		const messages = await session.prompt("dump it");
		const toolResult = messages.find((m: any) => m.role === "toolResult") as any;
		const resultText = toolResult.content[0].text as string;
		assert.match(resultText, /Output too large/);
		assert.match(resultText, /outputs\//);
		const persistedPath = resultText.match(/saved to: (\S+)/)?.[1];
		assert.ok(persistedPath);
		assert.match(await readFile(persistedPath, "utf-8"), /^blob blob /);
	});

	it("outputPersistence: false leaves large outputs inline", async () => {
		const extensions = new ExtensionRunner();
		await extensions.register((api) => {
			api.registerTool({
				name: "dump",
				label: "Dump",
				description: "returns a huge blob",
				parameters: { type: "object", properties: {} } as never,
				execute: async () => ({
					content: [{ type: "text", text: "blob ".repeat(20000) }],
					details: {},
				}),
			});
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("dump", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Saw the dump."),
		]);
		const session = makeSession({ extensions, outputPersistence: false });
		const messages = await session.prompt("dump it");
		const toolResult = messages.find((m: any) => m.role === "toolResult") as any;
		assert.doesNotMatch(toolResult.content[0].text as string, /Output too large/);
	});
});
