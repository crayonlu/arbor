/** Subagent protocol, task tool (with a scripted fake child), and agent discovery tests. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { BackgroundJobs } from "../src/jobs/registry.ts";
import { createJsonlDecoder, encodeEvent, type SubagentEvent } from "../src/subagent/protocol.ts";
import { createTaskTool, discoverAgentDefinitions } from "../src/subagent/task-tool.ts";

let tmp: string;

before(async () => {
	tmp = await mkdtemp(path.join(os.tmpdir(), "arbor-subagent-"));
});

after(async () => {
	await rm(tmp, { recursive: true, force: true });
});

describe("JSONL protocol", () => {
	it("round-trips events through encode/decode", () => {
		const seen: SubagentEvent[] = [];
		const decode = createJsonlDecoder((e) => seen.push(e));
		decode(encodeEvent({ type: "ready" }));
		decode(encodeEvent({ type: "text", text: "hello" }));
		assert.equal(seen.length, 2);
		assert.deepEqual(seen[1], { type: "text", text: "hello" });
	});

	it("handles chunk boundaries mid-line", () => {
		const seen: SubagentEvent[] = [];
		const decode = createJsonlDecoder((e) => seen.push(e));
		const line = encodeEvent({ type: "text", text: "split across chunks" });
		decode(line.slice(0, 10));
		decode(line.slice(10));
		assert.equal(seen.length, 1);
		assert.deepEqual(seen[0], { type: "text", text: "split across chunks" });
	});

	it("ignores non-JSON noise lines", () => {
		const seen: SubagentEvent[] = [];
		const decode = createJsonlDecoder((e) => seen.push(e));
		decode("random tool output\n");
		decode(encodeEvent({ type: "ready" }));
		assert.equal(seen.length, 1);
	});
});

describe("task tool", () => {
	/** Write a fake subagent entry script that emits scripted events. */
	async function writeFakeEntry(name: string, script: string): Promise<string> {
		const file = path.join(tmp, name);
		await writeFile(file, script);
		return file;
	}

	it("returns the child's final result text", async () => {
		const entry = await writeFakeEntry(
			"ok-entry.mjs",
			`
			const config = JSON.parse(process.argv[2]);
			process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "tool", toolName: "grep", summary: "found 3 matches", isError: false }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "result", text: "Report for: " + config.prompt, messageCount: 4, isError: false }) + "\\n");
			`,
		);
		const tool = createTaskTool({
			cwd: tmp,
			provider: "faux",
			modelId: "faux-model",
			entryPath: entry,
		});

		const updates: unknown[] = [];
		const result = await tool.execute("t1", { prompt: "audit the code" }, undefined, (u) => updates.push(u));
		assert.equal((result.content[0] as { text: string }).text, "Report for: audit the code");
		assert.equal(result.details.messageCount, 4);
		assert.deepEqual(result.details.toolSummaries, ["grep: found 3 matches"]);
		assert.equal(updates.length, 1, "tool progress streamed via onUpdate");
		// The ordered thread is surfaced for live UI rendering.
		assert.equal(result.details.thread.length, 1);
		const first = result.details.thread[0];
		assert.ok(first);
		assert.equal(first.type, "tool");
		assert.equal(first.toolName, "grep");
		assert.equal(result.details.streamingText, "");
	});

	it("streams an ordered text+tool thread via onUpdate", async () => {
		const entry = await writeFakeEntry(
			"thread-entry.mjs",
			`
			process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "text", text: "Thinking it over." }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "tool", toolName: "grep", summary: "3 matches", isError: false }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "text", text: "Final report." }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "result", text: "Final report.", messageCount: 2, isError: false }) + "\\n");
			`,
		);
		const tool = createTaskTool({ cwd: tmp, provider: "faux", modelId: "faux-model", entryPath: entry });

		const updates: { details: { thread: { type: string }[]; streamingText: string } }[] = [];
		const result = await tool.execute("t2", { prompt: "go" }, undefined, (u) => updates.push(u as never));

		// Three live updates: text, tool, text.
		assert.equal(updates.length, 3);
		assert.deepEqual(
			updates.map((u) => u.details.thread.map((t) => t.type)),
			[["text"], ["text", "tool"], ["text", "tool", "text"]],
		);
		const last = updates[2];
		assert.ok(last);
		assert.equal(last.details.streamingText, "Final report.");
		// Final details carry the full ordered thread.
		assert.deepEqual(
			result.details.thread.map((t) => t.type),
			["text", "tool", "text"],
		);
		assert.equal(result.details.streamingText, "Final report.");
	});

	it("rejects on a fatal child error", async () => {
		const entry = await writeFakeEntry(
			"fatal-entry.mjs",
			`process.stdout.write(JSON.stringify({ type: "fatal", error: "no such model" }) + "\\n"); process.exit(1);`,
		);
		const tool = createTaskTool({ cwd: tmp, provider: "x", modelId: "y", entryPath: entry });
		await assert.rejects(tool.execute("t1", { prompt: "anything" }), /no such model/);
	});

	it("rejects when the child produces no result", async () => {
		const entry = await writeFakeEntry("silent-entry.mjs", `process.exit(0);`);
		const tool = createTaskTool({ cwd: tmp, provider: "x", modelId: "y", entryPath: entry });
		await assert.rejects(tool.execute("t1", { prompt: "anything" }), /no result/);
	});

	it("kills the child on timeout", async () => {
		const entry = await writeFakeEntry("hang-entry.mjs", `setInterval(() => {}, 1000);`);
		const tool = createTaskTool({
			cwd: tmp,
			provider: "x",
			modelId: "y",
			entryPath: entry,
			timeoutMs: 200,
		});
		await assert.rejects(tool.execute("t1", { prompt: "anything" }), /no result/);
	});

	it("rejects unknown agent types with the available list", async () => {
		const entry = await writeFakeEntry("unused.mjs", "");
		const tool = createTaskTool({
			cwd: tmp,
			provider: "x",
			modelId: "y",
			entryPath: entry,
			agents: [{ name: "scout", description: "read-only explorer", prompt: "You are a scout." }],
		});
		await assert.rejects(
			tool.execute("t1", { prompt: "x", agent: "nope" }),
			/Unknown agent type: nope.*scout/,
		);
	});

	it("passes agent definition config to the child", async () => {
		const entry = await writeFakeEntry(
			"echo-config.mjs",
			`
			const config = JSON.parse(process.argv[2]);
			process.stdout.write(JSON.stringify({ type: "result", text: JSON.stringify({ systemPrompt: config.systemPrompt, tools: config.tools, mode: config.mode }), messageCount: 1, isError: false }) + "\\n");
			`,
		);
		const tool = createTaskTool({
			cwd: tmp,
			provider: "x",
			modelId: "y",
			entryPath: entry,
			agents: [
				{
					name: "scout",
					description: "explorer",
					prompt: "You are a scout.",
					tools: ["read", "grep"],
					mode: "plan",
				},
			],
		});
		const result = await tool.execute("t1", { prompt: "explore", agent: "scout" });
		const config = JSON.parse((result.content[0] as { text: string }).text);
		assert.equal(config.systemPrompt, "You are a scout.");
		assert.deepEqual(config.tools, ["read", "grep"]);
		assert.equal(config.mode, "plan");
	});
});

describe("task tool background", () => {
	async function writeFakeEntry(name: string, script: string): Promise<string> {
		const file = path.join(tmp, name);
		await writeFile(file, script);
		return file;
	}

	it("schema omits background without a jobs registry", async () => {
		const entry = await writeFakeEntry("bg-unused.mjs", "");
		const tool = createTaskTool({ cwd: tmp, provider: "x", modelId: "y", entryPath: entry });
		const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
		assert.equal("background" in properties, false);
	});

	it("returns a job id immediately and settles with the child's result", async () => {
		const entry = await writeFakeEntry(
			"bg-ok.mjs",
			`
			const config = JSON.parse(process.argv[2]);
			process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "tool", toolName: "grep", summary: "searched", isError: false }) + "\\n");
			setTimeout(() => {
				process.stdout.write(JSON.stringify({ type: "result", text: "Background report for: " + config.prompt, messageCount: 2, isError: false }) + "\\n");
			}, 100);
			`,
		);
		const jobs = new BackgroundJobs();
		const tool = createTaskTool({
			cwd: tmp,
			provider: "x",
			modelId: "y",
			entryPath: entry,
			jobs,
			logsRoot: path.join(tmp, "bg-logs"),
		});
		const settled = new Promise<void>((resolve) => {
			jobs.subscribe((n) => {
				if (n.kind === "settled") resolve();
			});
		});

		const result = await tool.execute("t1", { prompt: "audit deps", background: true });
		const { jobId, logPath } = result.details;
		assert.ok(jobId);
		assert.ok(logPath);
		assert.match((result.content[0] as { text: string }).text, /Started background subagent/);
		assert.equal(jobs.get(jobId)?.status, "running");

		await settled;
		const info = jobs.get(jobId);
		assert.equal(info?.status, "completed");
		const logContent = await readFile(logPath, "utf-8");
		assert.match(logContent, /\[grep\] searched/);
		assert.match(logContent, /Background report for: audit deps/);
	});

	it("settles as failed on a fatal child error", async () => {
		const entry = await writeFakeEntry(
			"bg-fatal.mjs",
			`process.stdout.write(JSON.stringify({ type: "fatal", error: "provider exploded" }) + "\\n"); process.exit(1);`,
		);
		const jobs = new BackgroundJobs();
		const tool = createTaskTool({
			cwd: tmp,
			provider: "x",
			modelId: "y",
			entryPath: entry,
			jobs,
			logsRoot: path.join(tmp, "bg-logs"),
		});
		const settled = new Promise<void>((resolve) => {
			jobs.subscribe((n) => {
				if (n.kind === "settled") resolve();
			});
		});

		const result = await tool.execute("t1", { prompt: "anything", background: true });
		await settled;
		assert.ok(result.details.jobId);
		const info = jobs.get(result.details.jobId);
		assert.equal(info?.status, "failed");
		assert.match(info?.error ?? "", /provider exploded/);
	});

	it("kill stops a hung background subagent", async () => {
		const entry = await writeFakeEntry("bg-hang.mjs", `setInterval(() => {}, 1000);`);
		const jobs = new BackgroundJobs();
		const tool = createTaskTool({
			cwd: tmp,
			provider: "x",
			modelId: "y",
			entryPath: entry,
			jobs,
			logsRoot: path.join(tmp, "bg-logs"),
		});
		const result = await tool.execute("t1", { prompt: "hang forever", background: true });
		assert.ok(result.details.jobId);
		const info = jobs.kill(result.details.jobId);
		assert.equal(info?.status, "killed");
	});
});

describe("agent definition discovery", () => {
	it("loads agent definitions from .arbor/agents", async () => {
		const projectDir = path.join(tmp, "proj");
		await mkdir(path.join(projectDir, ".arbor", "agents"), { recursive: true });
		await writeFile(
			path.join(projectDir, ".arbor", "agents", "reviewer.md"),
			`---\nname: reviewer\ndescription: Reviews code for bugs\ntools: read, grep, find\nmode: plan\n---\nYou are a meticulous code reviewer.`,
		);
		const agents = await discoverAgentDefinitions(projectDir, path.join(tmp, "nonexistent-home"));
		assert.equal(agents.length, 1);
		const reviewer = agents[0];
		assert.equal(reviewer?.name, "reviewer");
		assert.deepEqual(reviewer?.tools, ["read", "grep", "find"]);
		assert.equal(reviewer?.mode, "plan");
		assert.match(reviewer?.prompt ?? "", /meticulous/);
	});
});
