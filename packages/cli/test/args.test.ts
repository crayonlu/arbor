/** parseArgs tests. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../src/args.ts";

describe("parseArgs", () => {
	it("parses --flag value and --flag=value", () => {
		const a = parseArgs(["--provider", "anthropic", "--model=openai/gpt-4o"]);
		assert.equal(a.provider, "anthropic");
		assert.equal(a.model, "openai/gpt-4o");
	});

	it("collects positional messages and @file args", () => {
		const a = parseArgs(["hello", "@prompt.md", "world"]);
		assert.deepEqual(a.messages, ["hello", "world"]);
		assert.deepEqual(a.fileArgs, ["prompt.md"]);
	});

	it("-p consumes the next message but not a flag", () => {
		const a = parseArgs(["-p", "do the thing"]);
		assert.equal(a.print, true);
		assert.deepEqual(a.messages, ["do the thing"]);
	});

	it("short flags expand", () => {
		const a = parseArgs(["-c", "-r", "-n", "my session"]);
		assert.equal(a.continueRecent, true);
		assert.equal(a.resume, true);
		assert.equal(a.name, "my session");
	});

	it("splits csv tool lists", () => {
		const a = parseArgs(["-t", "read, bash ,grep", "--exclude-tools=edit"]);
		assert.deepEqual(a.tools, ["read", "bash", "grep"]);
		assert.deepEqual(a.excludeTools, ["edit"]);
	});

	it("collects unknown flags for extensions", () => {
		const a = parseArgs(["--plan", "--level=high", "go"]);
		assert.equal(a.unknownFlags.get("plan"), true);
		assert.equal(a.unknownFlags.get("level"), "high");
		assert.deepEqual(a.messages, ["go"]);
	});

	it("records diagnostics for unknown short flags and missing values", () => {
		const a = parseArgs(["-z", "--model"]);
		assert.ok(a.diagnostics.some((d) => d.type === "error" && d.message.includes("Unknown option")));
		assert.ok(a.diagnostics.some((d) => d.type === "error" && d.message.includes("requires a value")));
	});

	it("validates --mode", () => {
		const good = parseArgs(["--mode", "rpc"]);
		assert.equal(good.mode, "rpc");
		const bad = parseArgs(["--mode", "bogus"]);
		assert.ok(bad.diagnostics.some((d) => d.type === "warning" && d.message.includes("Invalid --mode")));
	});
});
