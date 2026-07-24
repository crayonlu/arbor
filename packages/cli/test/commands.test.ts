/** Slash command registry + dispatch tests (faux provider, no tokens). */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	AgentSession,
	type ExtensionRunner,
	ExtensionRunner as Runner,
	SessionManager,
	type StreamFn,
} from "@arbor-space/core";
import { createCodingTools } from "@arbor-space/core/tools";
import { createModels, type FauxProviderHandle, fauxProvider } from "@earendil-works/pi-ai";
import {
	createSlashRuntime,
	executeSlashCommand,
	listCommands,
	parseSlashCommand,
} from "../src/commands/index.ts";

let workspace: string;
let faux: FauxProviderHandle;
let streamFn: StreamFn;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "arbor-cmd-ws-"));
	faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	streamFn = (model: unknown, context: unknown, options: unknown) =>
		models.streamSimple(model as never, context as never, options as never);
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
});

function makeSession(extensions?: ExtensionRunner) {
	return new AgentSession({
		cwd: workspace,
		model: faux.getModel(),
		streamFn,
		systemPrompt: "You are Arbor.",
		tools: createCodingTools(workspace),
		sessionManager: SessionManager.inMemory(workspace),
		...(extensions ? { extensions } : {}),
	});
}

function makeRuntime(session: AgentSession) {
	const out: string[] = [];
	const runtime = createSlashRuntime(session, session.session, {
		cwd: workspace,
		output: (text: string) => {
			out.push(text);
		},
	});
	return { runtime, out };
}

describe("slash commands", () => {
	it("parseSlashCommand splits category, name, and args", () => {
		assert.deepEqual(parseSlashCommand("/mode plan"), {
			category: "mode",
			name: "plan",
			args: "",
			text: "mode plan",
		});
		const p = parseSlashCommand("session name my task");
		assert.equal(p.category, "session");
		assert.equal(p.name, "name");
		assert.equal(p.args, "my task");
	});

	it("listCommands includes builtins across categories", () => {
		const infos = listCommands();
		const cats = new Set(infos.map((c) => c.category));
		assert.ok(cats.has("session"));
		assert.ok(cats.has("model"));
		assert.ok(cats.has("help"));
		assert.ok(infos.some((c) => c.name === "compact"));
	});

	it("merges extension-registered commands under 'extension'", async () => {
		const extensions = new Runner();
		await extensions.register((api) => {
			api.registerCommand("myext", { description: "an extension command", handler: async () => {} });
		});
		const session = makeSession(extensions);
		const infos = listCommands(session);
		const ext = infos.find((c) => c.name === "myext");
		assert.equal(ext?.category, "extension");
		assert.equal(ext?.description, "an extension command");
	});

	it("dispatches a builtin headless handler (mode plan)", async () => {
		const session = makeSession();
		const { runtime } = makeRuntime(session);
		const outcome = await executeSlashCommand("/mode plan", runtime);
		assert.equal(outcome.kind, "consumed");
		assert.equal(session.mode, "plan");
	});

	it("sets the session name via /session name", async () => {
		const session = makeSession();
		const { runtime, out } = makeRuntime(session);
		const outcome = await executeSlashCommand("/session name my-task", runtime);
		assert.equal(outcome.kind, "consumed");
		assert.equal(session.session.name, "my-task");
		assert.ok(out.some((t) => t.includes("my-task")));
	});

	it("reports tui_only for commands without a headless handler", async () => {
		const session = makeSession();
		const { runtime } = makeRuntime(session);
		const outcome = await executeSlashCommand("/model set anthropic/x", runtime);
		assert.equal(outcome.kind, "tui_only");
		assert.equal(outcome.kind === "tui_only" ? outcome.name : "", "model set");
	});

	it("reports unknown for unrecognized commands", async () => {
		const session = makeSession();
		const { runtime } = makeRuntime(session);
		const outcome = await executeSlashCommand("/bogus thing", runtime);
		assert.equal(outcome.kind, "unknown");
	});

	it("invokes an extension command", async () => {
		let called = "";
		const extensions = new Runner();
		await extensions.register((api) => {
			api.registerCommand("myext", {
				description: "ext",
				handler: async (args: string) => {
					called = args;
				},
			});
		});
		const session = makeSession(extensions);
		const { runtime } = makeRuntime(session);
		const outcome = await executeSlashCommand("/myext hello", runtime);
		assert.equal(outcome.kind, "consumed");
		assert.equal(called, "hello");
	});
});
