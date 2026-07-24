/** Built-in tool tests against a temp directory workspace. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { BackgroundJobs } from "../src/jobs/registry.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { applyMatchedEdits, createEditTool, detectLineEnding, matchEdits } from "../src/tools/edit.ts";
import { createFindTool } from "../src/tools/find.ts";
import { globToRegex } from "../src/tools/glob.ts";
import { createGrepTool } from "../src/tools/grep.ts";
import { createLsTool } from "../src/tools/ls.ts";
import { createReadTool } from "../src/tools/read.ts";
import { truncateHead, truncateTail } from "../src/tools/truncate.ts";
import { gitignorePatternToRule } from "../src/tools/walker.ts";
import { createWriteTool } from "../src/tools/write.ts";

let cwd: string;

before(async () => {
	cwd = await mkdtemp(path.join(os.tmpdir(), "arbor-tools-"));
	await writeFile(path.join(cwd, "hello.txt"), "line one\nline two\nline three\n");
	await writeFile(path.join(cwd, "code.ts"), 'export const greeting = "hi";\nexport const answer = 42;\n');
});

after(async () => {
	await rm(cwd, { recursive: true, force: true });
});

function text(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((c) => c.text ?? "").join("");
}

describe("read tool", () => {
	it("reads a text file", async () => {
		const tool = createReadTool(cwd);
		const result = await tool.execute("t1", { path: "hello.txt" });
		assert.match(text(result), /line one/);
		assert.equal(result.details.truncated, false);
	});

	it("supports offset and limit windows", async () => {
		const tool = createReadTool(cwd);
		const result = await tool.execute("t1", { path: "hello.txt", offset: 2, limit: 1 });
		assert.equal(text(result), "line two");
	});

	it("throws a clean error for missing files", async () => {
		const tool = createReadTool(cwd);
		await assert.rejects(tool.execute("t1", { path: "nope.txt" }), /File not found/);
	});

	it("rejects offsets beyond the end of the file", async () => {
		const tool = createReadTool(cwd);
		await assert.rejects(tool.execute("t1", { path: "hello.txt", offset: 99 }), /beyond the end/);
	});
});

describe("write tool", () => {
	it("creates files with parent directories", async () => {
		const tool = createWriteTool(cwd);
		const result = await tool.execute("t1", { path: "sub/dir/new.txt", content: "created\n" });
		assert.equal(result.details.created, true);
		assert.equal(await readFile(path.join(cwd, "sub/dir/new.txt"), "utf-8"), "created\n");
	});

	it("overwrites existing files and reports it", async () => {
		const tool = createWriteTool(cwd);
		await tool.execute("t1", { path: "over.txt", content: "v1" });
		const result = await tool.execute("t2", { path: "over.txt", content: "v2" });
		assert.equal(result.details.created, false);
		assert.equal(await readFile(path.join(cwd, "over.txt"), "utf-8"), "v2");
	});
});

describe("edit tool", () => {
	it("applies a single exact replacement and returns a diff", async () => {
		await writeFile(path.join(cwd, "edit-me.txt"), "alpha\nbeta\ngamma\n");
		const tool = createEditTool(cwd);
		const result = await tool.execute("t1", {
			path: "edit-me.txt",
			edits: [{ oldText: "beta", newText: "BETA" }],
		});
		assert.equal(await readFile(path.join(cwd, "edit-me.txt"), "utf-8"), "alpha\nBETA\ngamma\n");
		assert.match(result.details.diff, /-beta/);
		assert.match(result.details.diff, /\+BETA/);
	});

	it("applies multiple non-overlapping edits against the original content", async () => {
		await writeFile(path.join(cwd, "multi.txt"), "one two three four\n");
		const tool = createEditTool(cwd);
		await tool.execute("t1", {
			path: "multi.txt",
			edits: [
				{ oldText: "one", newText: "1" },
				{ oldText: "three", newText: "3" },
			],
		});
		assert.equal(await readFile(path.join(cwd, "multi.txt"), "utf-8"), "1 two 3 four\n");
	});

	it("rejects ambiguous oldText", async () => {
		await writeFile(path.join(cwd, "dup.txt"), "same\nsame\n");
		const tool = createEditTool(cwd);
		await assert.rejects(
			tool.execute("t1", { path: "dup.txt", edits: [{ oldText: "same", newText: "x" }] }),
			/multiple locations/,
		);
	});

	it("rejects missing oldText with an actionable message", async () => {
		const tool = createEditTool(cwd);
		await assert.rejects(
			tool.execute("t1", { path: "hello.txt", edits: [{ oldText: "not here", newText: "x" }] }),
			/not found/,
		);
	});

	it("preserves CRLF line endings", async () => {
		await writeFile(path.join(cwd, "crlf.txt"), "a\r\nb\r\nc\r\n");
		const tool = createEditTool(cwd);
		await tool.execute("t1", { path: "crlf.txt", edits: [{ oldText: "b", newText: "B" }] });
		assert.equal(await readFile(path.join(cwd, "crlf.txt"), "utf-8"), "a\r\nB\r\nc\r\n");
	});

	it("rejects overlapping edits", () => {
		assert.throws(
			() =>
				matchEdits("abcdef", [
					{ oldText: "abcd", newText: "x" },
					{ oldText: "cdef", newText: "y" },
				]),
			/overlap/,
		);
	});

	it("matchEdits + applyMatchedEdits round-trip", () => {
		const content = "The quick brown fox";
		const matched = matchEdits(content, [
			{ oldText: "quick", newText: "slow" },
			{ oldText: "fox", newText: "dog" },
		]);
		assert.equal(applyMatchedEdits(content, matched), "The slow brown dog");
	});

	it("detectLineEnding picks the majority ending", () => {
		assert.equal(detectLineEnding("a\r\nb\r\nc\n"), "\r\n");
		assert.equal(detectLineEnding("a\nb\nc\r\n"), "\n");
	});
});

describe("bash tool", () => {
	it("runs a command and captures output", async () => {
		const tool = createBashTool(cwd);
		const result = await tool.execute("t1", { command: "echo hello-from-bash" });
		assert.match(text(result), /hello-from-bash/);
		assert.equal(result.details.exitCode, 0);
	});

	it("reports non-zero exit codes in the output", async () => {
		const tool = createBashTool(cwd);
		const result = await tool.execute("t1", { command: "exit 3" });
		assert.equal(result.details.exitCode, 3);
		assert.match(text(result), /Exit code: 3/);
	});

	it("kills long commands on timeout", async () => {
		const tool = createBashTool(cwd);
		const result = await tool.execute("t1", { command: "sleep 10", timeout: 100 });
		assert.equal(result.details.killedByTimeout, true);
		assert.match(text(result), /killed after/);
	});

	it("respects abort signals", async () => {
		const tool = createBashTool(cwd);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		const result = await tool.execute("t1", { command: "sleep 10" }, controller.signal);
		assert.match(text(result), /aborted/);
	});

	it("runs in the workspace directory", async () => {
		const tool = createBashTool(cwd);
		const result = await tool.execute("t1", { command: "pwd" });
		assert.match(text(result), new RegExp(path.basename(cwd)));
	});
});

describe("bash tool background", () => {
	it("schema omits background without a jobs registry", () => {
		const tool = createBashTool(cwd);
		const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
		assert.equal("background" in properties, false);
		assert.doesNotMatch(tool.description, /background/i);
	});

	it("schema includes background with a jobs registry", () => {
		const tool = createBashTool(cwd, { jobs: new BackgroundJobs(), logsRoot: cwd });
		const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
		assert.equal("background" in properties, true);
		assert.match(tool.description, /background/i);
	});

	it("returns a job id immediately and completes via the registry", async () => {
		const jobs = new BackgroundJobs();
		const logsRoot = path.join(cwd, "bg-logs");
		const tool = createBashTool(cwd, { jobs, logsRoot });
		const settled = new Promise<void>((resolve) => {
			jobs.subscribe((n) => {
				if (n.kind === "settled") resolve();
			});
		});

		const result = await tool.execute("t1", {
			command: "sleep 0.5 && echo done-in-background",
			background: true,
		});
		const { jobId, logPath } = result.details;
		assert.ok(jobId);
		assert.ok(logPath);
		assert.match(text(result), /Started background job/);
		assert.equal(jobs.get(jobId)?.status, "running");

		await settled;
		const info = jobs.get(jobId);
		assert.equal(info?.status, "completed");
		assert.equal(info?.exitCode, 0);
		assert.match(await readFile(logPath, "utf-8"), /done-in-background/);
	});

	it("reports fast failures in the immediate result", async () => {
		const jobs = new BackgroundJobs();
		const tool = createBashTool(cwd, { jobs, logsRoot: path.join(cwd, "bg-logs") });
		const result = await tool.execute("t1", { command: "echo oops >&2; exit 7", background: true });
		assert.match(text(result), /already finished: failed \(exit 7\)/);
		assert.match(text(result), /oops/);
		assert.ok(result.details.jobId);
		assert.equal(jobs.get(result.details.jobId)?.status, "failed");
	});

	it("kill via the registry stops a background command", async () => {
		const jobs = new BackgroundJobs();
		const tool = createBashTool(cwd, { jobs, logsRoot: path.join(cwd, "bg-logs") });
		const result = await tool.execute("t1", { command: "sleep 30", background: true });
		assert.ok(result.details.jobId);
		const info = jobs.kill(result.details.jobId);
		assert.equal(info?.status, "killed");
	});
});

describe("bash tool auto-background", () => {
	it("fast commands finish in the foreground untouched", async () => {
		const jobs = new BackgroundJobs();
		const tool = createBashTool(cwd, {
			jobs,
			logsRoot: path.join(cwd, "bg-logs"),
			autoBackground: { thresholdMs: 2000 },
		});
		const result = await tool.execute("t1", { command: "echo quick-result" });
		assert.match(text(result), /quick-result/);
		assert.equal(result.details.jobId, undefined);
		assert.equal(jobs.list().length, 0);
	});

	it("slow commands are promoted to a background job and keep running", async () => {
		const jobs = new BackgroundJobs();
		const logsRoot = path.join(cwd, "bg-logs");
		const tool = createBashTool(cwd, {
			jobs,
			logsRoot,
			autoBackground: { thresholdMs: 200 },
		});
		const settled = new Promise<void>((resolve) => {
			jobs.subscribe((n) => {
				if (n.kind === "settled") resolve();
			});
		});

		const started = Date.now();
		const result = await tool.execute("t1", {
			command: "echo early-output && sleep 0.6 && echo late-output",
		});
		// Promoted around the 200ms mark, well before the command finishes.
		assert.ok(Date.now() - started < 500);
		assert.match(text(result), /moved to the background/);
		assert.match(text(result), /early-output/);
		const { jobId, logPath } = result.details;
		assert.ok(jobId);
		assert.ok(logPath);
		assert.equal(jobs.get(jobId)?.status, "running");

		await settled;
		assert.equal(jobs.get(jobId)?.status, "completed");
		const logContent = await readFile(logPath, "utf-8");
		assert.match(logContent, /early-output/);
		assert.match(logContent, /late-output/);
	});

	it("pending steering promotes immediately", async () => {
		const jobs = new BackgroundJobs();
		let pending = false;
		const tool = createBashTool(cwd, {
			jobs,
			logsRoot: path.join(cwd, "bg-logs"),
			autoBackground: { thresholdMs: 30_000, steeringPending: () => pending },
		});
		setTimeout(() => {
			pending = true;
		}, 100);
		const started = Date.now();
		const result = await tool.execute("t1", { command: "sleep 5" });
		assert.ok(Date.now() - started < 2000, "promoted well before the 30s threshold");
		assert.match(text(result), /queued user message/);
		assert.ok(result.details.jobId);
		jobs.kill(result.details.jobId);
	});

	it("an explicit short timeout still kills in the foreground", async () => {
		const jobs = new BackgroundJobs();
		const tool = createBashTool(cwd, {
			jobs,
			logsRoot: path.join(cwd, "bg-logs"),
			autoBackground: { thresholdMs: 60_000 },
		});
		const result = await tool.execute("t1", { command: "sleep 10", timeout: 150 });
		assert.equal(result.details.killedByTimeout, true);
		assert.equal(result.details.jobId, undefined);
	});

	it("explicit timeout carries over to the promoted job", async () => {
		const jobs = new BackgroundJobs();
		const tool = createBashTool(cwd, {
			jobs,
			logsRoot: path.join(cwd, "bg-logs"),
			autoBackground: { thresholdMs: 200 },
		});
		const settled = new Promise<void>((resolve) => {
			jobs.subscribe((n) => {
				if (n.kind === "settled") resolve();
			});
		});
		// Promotes at ~200ms (timeout 5000 leaves a 1s-headroom window of 200ms),
		// then the carried-over timeout kills the sleep long before 30s.
		const result = await tool.execute("t1", { command: "sleep 30", timeout: 5000 });
		assert.ok(result.details.jobId);
		await settled;
		assert.equal(jobs.get(result.details.jobId)?.status, "killed");
	});

	it("without autoBackground slow commands still block (regression)", async () => {
		const jobs = new BackgroundJobs();
		const tool = createBashTool(cwd, { jobs, logsRoot: path.join(cwd, "bg-logs") });
		const started = Date.now();
		const result = await tool.execute("t1", { command: "sleep 0.4 && echo waited" });
		assert.ok(Date.now() - started >= 350);
		assert.match(text(result), /waited/);
		assert.equal(result.details.jobId, undefined);
	});
});

describe("grep tool", () => {
	it("finds regex matches with file:line output", async () => {
		const tool = createGrepTool(cwd);
		const result = await tool.execute("t1", { pattern: "greeting" });
		assert.match(text(result), /code\.ts:1/);
		assert.ok(result.details.matchCount >= 1);
	});

	it("returns a friendly message when nothing matches", async () => {
		const tool = createGrepTool(cwd);
		const result = await tool.execute("t1", { pattern: "zzz-no-match-zzz" });
		assert.match(text(result), /No matches/);
	});

	it("filters by glob", async () => {
		const tool = createGrepTool(cwd);
		const result = await tool.execute("t1", { pattern: "line", glob: "*.ts" });
		assert.doesNotMatch(text(result), /hello\.txt/);
	});
});

describe("find tool", () => {
	it("finds files at any depth with a bare pattern", async () => {
		const tool = createFindTool(cwd);
		const result = await tool.execute("t1", { pattern: "*.ts" });
		assert.match(text(result), /code\.ts/);
	});

	it("reports zero matches cleanly", async () => {
		const tool = createFindTool(cwd);
		const result = await tool.execute("t1", { pattern: "*.nope" });
		assert.match(text(result), /No files matching/);
	});
});

describe("ls tool", () => {
	it("lists directories before files with sizes", async () => {
		const tool = createLsTool(cwd);
		const result = await tool.execute("t1", {});
		const output = text(result);
		assert.match(output, /sub\//);
		assert.match(output, /hello\.txt \(/);
		assert.ok(output.indexOf("sub/") < output.indexOf("hello.txt"));
	});

	it("refuses to list a file", async () => {
		const tool = createLsTool(cwd);
		await assert.rejects(tool.execute("t1", { path: "hello.txt" }), /is a file/);
	});
});

describe("truncation", () => {
	it("truncateHead keeps the first lines under the byte budget", () => {
		const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
		const result = truncateHead(content, { maxLines: 10 });
		assert.equal(result.truncated, true);
		assert.equal(result.outputLines, 10);
		assert.match(result.content, /^line 0/);
	});

	it("truncateTail keeps the last lines", () => {
		const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
		const result = truncateTail(content, { maxLines: 10 });
		assert.equal(result.truncated, true);
		assert.match(result.content, /line 99\n$/);
	});

	it("truncateTail keeps the newest bytes of one huge line", () => {
		const content = `${"x".repeat(1000)}TAIL-MARKER`;
		const result = truncateTail(content, { maxBytes: 20 });
		assert.match(result.content, /TAIL-MARKER/);
	});

	it("does not truncate content within limits", () => {
		const result = truncateHead("short\n");
		assert.equal(result.truncated, false);
		assert.equal(result.content, "short\n");
	});
});

describe("glob and gitignore", () => {
	it("bare globs match at any depth", () => {
		const regex = globToRegex("*.ts");
		assert.ok(regex.test("a.ts"));
		assert.ok(regex.test("deep/nested/b.ts"));
		assert.ok(!regex.test("a.tsx"));
	});

	it("path globs are anchored", () => {
		const regex = globToRegex("src/**/*.ts");
		assert.ok(regex.test("src/deep/a.ts"));
		assert.ok(!regex.test("other/src-like/a.ts"));
	});

	it("gitignore rules support negation and dir-only", () => {
		const ignore = gitignorePatternToRule("logs/");
		const negate = gitignorePatternToRule("!logs/keep.txt");
		assert.ok(ignore && negate);
		assert.ok(ignore.dirOnly);
		assert.ok(negate.negated);
		assert.ok(ignore.regex.test("logs"));
	});

	it("gitignore comments and blanks are skipped", () => {
		assert.equal(gitignorePatternToRule("# comment"), null);
		assert.equal(gitignorePatternToRule("   "), null);
	});
});
