/** Extension runner and loader tests. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { discoverExtensionPaths, loadExtensions } from "../src/extensions/loader.ts";
import { ExtensionRunner } from "../src/extensions/runner.ts";
import type { ExtensionContext } from "../src/extensions/types.ts";

function makeCtx(): ExtensionContext {
	return {
		cwd: "/tmp",
		ui: {
			notify: () => {},
			confirm: async () => false,
			input: async () => undefined,
			select: async () => undefined,
		},
		appendEntry: () => {},
		requestStop: () => {},
	};
}

const toolCallPayload = (input: Record<string, any>) =>
	({
		type: "tool_call",
		toolName: "bash",
		toolCall: { type: "toolCall", id: "t1", name: "bash", arguments: input },
		input,
	}) as const;

describe("ExtensionRunner", () => {
	it("collects tools and commands from factories", async () => {
		const runner = new ExtensionRunner();
		await runner.register((api) => {
			api.registerTool({
				name: "custom",
				label: "Custom",
				description: "d",
				parameters: {} as never,
				execute: async () => ({ content: [], details: undefined }),
			});
			api.registerCommand("hello", { description: "greet", handler: () => {} });
		});
		assert.equal(runner.getTools().length, 1);
		assert.ok(runner.getCommands().has("hello"));
	});

	it("rejects duplicate tool names across extensions", async () => {
		const runner = new ExtensionRunner();
		const tool = {
			name: "dup",
			label: "Dup",
			description: "d",
			parameters: {} as never,
			execute: async () => ({ content: [], details: undefined }),
		};
		await runner.register((api) => api.registerTool(tool));
		await runner.register((api) => api.registerTool(tool), "second.ts");
		const errors = runner.getLoadErrors();
		assert.equal(errors.length, 1);
		assert.match(errors[0]?.error.message ?? "", /Duplicate extension tool/);
	});

	it("tool_call: first block wins", async () => {
		const runner = new ExtensionRunner();
		await runner.register((api) => {
			api.on("tool_call", () => ({ block: true, reason: "first says no" }));
		});
		await runner.register((api) => {
			api.on("tool_call", () => ({ block: true, reason: "second says no" }));
		});
		const result = await runner.emitToolCall(toolCallPayload({ command: "rm -rf /" }), makeCtx());
		assert.equal(result?.block, true);
		assert.equal(result?.reason, "first says no");
	});

	it("tool_call: args rewrites chain through handlers", async () => {
		const runner = new ExtensionRunner();
		await runner.register((api) => {
			api.on("tool_call", (event) => ({ args: { command: `${(event.input as any).command} --safe` } }));
		});
		await runner.register((api) => {
			api.on("tool_call", (event) => ({ args: { command: `${(event.input as any).command} --verbose` } }));
		});
		const result = await runner.emitToolCall(toolCallPayload({ command: "ls" }), makeCtx());
		assert.deepEqual(result?.args, { command: "ls --safe --verbose" });
	});

	it("tool_result: overrides merge across handlers", async () => {
		const runner = new ExtensionRunner();
		await runner.register((api) => {
			api.on("tool_result", () => ({ content: [{ type: "text", text: "redacted" }] }));
		});
		await runner.register((api) => {
			api.on("tool_result", (event) => {
				// Second handler sees the first handler's rewrite.
				assert.equal((event.result.content[0] as any).text, "redacted");
				return { isError: true };
			});
		});
		const result = await runner.emitToolResult(
			{
				type: "tool_result",
				toolName: "bash",
				toolCall: { type: "toolCall", id: "t1", name: "bash", arguments: {} },
				input: {},
				result: { content: [{ type: "text", text: "secret" }], details: undefined },
				isError: false,
			},
			makeCtx(),
		);
		assert.ok(result);
		assert.equal((result.content?.[0] as any)?.text, "redacted");
		assert.equal(result.isError, true);
	});

	it("context: message transforms chain", async () => {
		const runner = new ExtensionRunner();
		await runner.register((api) => {
			api.on("context", (event) => ({
				messages: [...event.messages, { role: "user", content: "injected-1", timestamp: 0 }],
			}));
		});
		await runner.register((api) => {
			api.on("context", (event) => ({
				messages: [...event.messages, { role: "user", content: "injected-2", timestamp: 0 }],
			}));
		});
		const result = await runner.emitContext({ type: "context", messages: [] }, makeCtx());
		assert.equal(result?.messages?.length, 2);
	});

	it("compaction: first handler with a summary takes over", async () => {
		const runner = new ExtensionRunner();
		await runner.register((api) => {
			api.on("compaction", () => undefined);
		});
		await runner.register((api) => {
			api.on("compaction", () => ({ summary: "extension summary" }));
		});
		const result = await runner.emitCompaction(
			{ type: "compaction", messages: [], estimatedTokens: 100 },
			makeCtx(),
		);
		assert.equal(result?.summary, "extension summary");
	});

	it("user_prompt: handled short-circuits", async () => {
		const runner = new ExtensionRunner();
		const seen: string[] = [];
		await runner.register((api) => {
			api.on("user_prompt", (event) => {
				seen.push(event.text);
				return { handled: true };
			});
		});
		await runner.register((api) => {
			api.on("user_prompt", () => {
				seen.push("should not run");
				return undefined;
			});
		});
		const result = await runner.emitUserPrompt({ type: "user_prompt", text: "hi" }, makeCtx());
		assert.equal(result?.handled, true);
		assert.deepEqual(seen, ["hi"]);
	});

	it("notification handler failures are isolated", async () => {
		const runner = new ExtensionRunner();
		let secondRan = false;
		await runner.register((api) => {
			api.on("turn_start", () => {
				throw new Error("broken extension");
			});
		});
		await runner.register((api) => {
			api.on("turn_start", () => {
				secondRan = true;
			});
		});
		await runner.emit("turn_start", { type: "turn_start" }, makeCtx());
		assert.equal(secondRan, true);
	});

	it("factory errors are captured as load errors", async () => {
		const runner = new ExtensionRunner();
		await runner.register(() => {
			throw new Error("factory exploded");
		}, "bad.ts");
		assert.equal(runner.getLoadErrors().length, 1);
	});
});

describe("extension discovery and loading", () => {
	let tmp: string;

	before(async () => {
		tmp = await mkdtemp(path.join(os.tmpdir(), "arbor-ext-"));
		// Global dir: one flat file + one directory extension.
		await mkdir(path.join(tmp, "global", "dir-ext"), { recursive: true });
		await writeFile(
			path.join(tmp, "global", "flat.ts"),
			`export default function (api) { api.registerCommand("flat", { description: "", handler: () => {} }); }`,
		);
		await writeFile(
			path.join(tmp, "global", "dir-ext", "index.ts"),
			`export default function (api) { api.registerCommand("dir", { description: "", handler: () => {} }); }`,
		);
		// Project dir.
		await mkdir(path.join(tmp, "project", ".arbor", "extensions"), { recursive: true });
		await writeFile(
			path.join(tmp, "project", ".arbor", "extensions", "proj.ts"),
			`export default function (api) { api.registerCommand("proj", { description: "", handler: () => {} }); }`,
		);
		// A broken extension.
		await writeFile(path.join(tmp, "broken.ts"), `export const nope = 1;`);
	});

	after(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	it("discovers global then project then extra paths", async () => {
		const paths = await discoverExtensionPaths({
			cwd: path.join(tmp, "project"),
			globalDir: path.join(tmp, "global"),
		});
		assert.equal(paths.length, 3);
		assert.ok(paths[0]?.endsWith("dir-ext/index.ts"));
		assert.ok(paths[1]?.endsWith("flat.ts"));
		assert.ok(paths[2]?.endsWith("proj.ts"));
	});

	it("noDiscovery still loads explicit extra paths", async () => {
		const paths = await discoverExtensionPaths({
			cwd: path.join(tmp, "project"),
			globalDir: path.join(tmp, "global"),
			noDiscovery: true,
			extraPaths: [path.join(tmp, "global", "flat.ts")],
		});
		assert.equal(paths.length, 1);
	});

	it("loads discovered extensions and reports broken ones", async () => {
		const runner = new ExtensionRunner();
		const { loaded, failed } = await loadExtensions(runner, [
			path.join(tmp, "global", "flat.ts"),
			path.join(tmp, "broken.ts"),
		]);
		assert.equal(loaded.length, 1);
		assert.equal(failed.length, 1);
		assert.match(failed[0]?.error.message ?? "", /default factory/);
		assert.ok(runner.getCommands().has("flat"));
	});
});
