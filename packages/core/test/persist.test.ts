/** Large tool output persistence tests. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { Type } from "typebox";
import { persistLargeOutputs, pruneToolOutputs, withOutputPersistence } from "../src/tools/persist.ts";
import type { AgentTool, AgentToolResult } from "../src/types.ts";

let root: string;

before(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "arbor-persist-"));
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

function fakeTool(produce: () => AgentToolResult): AgentTool<any> {
	return {
		name: "fake",
		label: "Fake",
		description: "test tool",
		parameters: Type.Object({}),
		execute: async () => produce(),
	};
}

function textResult(text: string): AgentToolResult {
	return { content: [{ type: "text", text }], details: { original: true } };
}

function text(result: AgentToolResult): string {
	return result.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("");
}

describe("output persistence", () => {
	it("passes small results through untouched", async () => {
		const tool = withOutputPersistence(
			fakeTool(() => textResult("small output")),
			{
				root,
				thresholdBytes: 1024,
			},
		);
		const result = await tool.execute("p1", {});
		assert.equal(text(result), "small output");
		assert.deepEqual(result.details, { original: true });
	});

	it("persists oversized results with preview and path", async () => {
		const big = "x".repeat(5000);
		const tool = withOutputPersistence(
			fakeTool(() => textResult(big)),
			{
				root,
				thresholdBytes: 1024,
				previewBytes: 100,
			},
		);
		const result = await tool.execute("p2", {});
		const output = text(result);
		assert.match(output, /Output too large/);
		assert.match(output, /read it with the read tool/);
		const persistedPath = (result.details as { persistedPath: string }).persistedPath;
		assert.ok(persistedPath.endsWith("p2.txt"));
		assert.equal(await readFile(persistedPath, "utf-8"), big);
		// Preview kept, full content not inlined.
		assert.ok(output.length < 1000);
	});

	it("wx flag keeps the first persisted content on repeat calls", async () => {
		let call = 0;
		const tool = withOutputPersistence(
			fakeTool(() => textResult(`content-${++call}-${"y".repeat(2000)}`)),
			{ root, thresholdBytes: 100 },
		);
		await tool.execute("p3", {});
		const result = await tool.execute("p3", {});
		const persistedPath = (result.details as { persistedPath: string }).persistedPath;
		assert.match(await readFile(persistedPath, "utf-8"), /^content-1/);
	});

	it("skips results containing image blocks", async () => {
		const tool = withOutputPersistence(
			fakeTool(() => ({
				content: [
					{ type: "text", text: "z".repeat(5000) },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				],
				details: {},
			})),
			{ root, thresholdBytes: 100 },
		);
		const result = await tool.execute("p4", {});
		assert.equal(result.content.length, 2);
		assert.doesNotMatch(text(result), /Output too large/);
	});

	it("multi-block text results are joined when persisted", async () => {
		const tool = withOutputPersistence(
			fakeTool(() => ({
				content: [
					{ type: "text", text: "part-one ".repeat(200) },
					{ type: "text", text: "part-two ".repeat(200) },
				],
				details: {},
			})),
			{ root, thresholdBytes: 100 },
		);
		const result = await tool.execute("p5", {});
		const persistedPath = (result.details as { persistedPath: string }).persistedPath;
		const persisted = await readFile(persistedPath, "utf-8");
		assert.match(persisted, /part-one/);
		assert.match(persisted, /part-two/);
	});

	it("persistLargeOutputs wraps every tool in the list", async () => {
		const tools = persistLargeOutputs(
			[fakeTool(() => textResult("a".repeat(2000))), fakeTool(() => textResult("tiny"))],
			{ root, thresholdBytes: 100 },
		);
		const big = await tools[0]?.execute("p6", {});
		const small = await tools[1]?.execute("p7", {});
		assert.match(text(big as AgentToolResult), /Output too large/);
		assert.equal(text(small as AgentToolResult), "tiny");
	});

	it("prune removes only old outputs", async () => {
		const pruneRoot = path.join(root, "prune");
		await mkdir(pruneRoot, { recursive: true });
		await writeFile(path.join(pruneRoot, "old.txt"), "old");
		await writeFile(path.join(pruneRoot, "new.txt"), "new");
		const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
		await utimes(path.join(pruneRoot, "old.txt"), oldTime, oldTime);

		const removed = await pruneToolOutputs(pruneRoot, 7);
		assert.equal(removed, 1);
		assert.equal(
			await stat(path.join(pruneRoot, "new.txt")).then(
				() => true,
				() => false,
			),
			true,
		);
	});
});
