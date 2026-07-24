/** RPC command handler + roundtrip UI tests (faux provider, no stdio). */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AgentSession, SessionManager, type StreamFn } from "@arbor-space/core";
import { createCodingTools } from "@arbor-space/core/tools";
import { createModels, type FauxProviderHandle, fauxProvider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { handleRpcCommand } from "../src/rpc/handler.ts";
import { createRpcUi } from "../src/rpc/protocol.ts";
import type { RpcOutput } from "../src/rpc/types.ts";

let workspace: string;
let faux: FauxProviderHandle;
let streamFn: StreamFn;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "arbor-rpc-ws-"));
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

describe("handleRpcCommand", () => {
	it("get_state returns session snapshot", async () => {
		const session = makeSession();
		const out: RpcOutput[] = [];
		const res = await handleRpcCommand(
			{ type: "get_state", id: "1" },
			{ session, models: builtinModels(), sessionManager: session.session, output: (v) => out.push(v) },
		);
		assert.equal(res?.success, true);
		const data = (res as { data?: { mode: string } }).data;
		assert.equal(data?.mode, "build");
	});

	it("set_mode changes the session mode", async () => {
		const session = makeSession();
		const res = await handleRpcCommand(
			{ type: "set_mode", id: "2", mode: "plan" },
			{ session, models: builtinModels(), sessionManager: session.session, output: () => {} },
		);
		assert.equal(res?.success, true);
		assert.equal(session.mode, "plan");
	});

	it("set_model with a known model updates session.model", async () => {
		const session = makeSession();
		const models = builtinModels();
		const first = models.getModels()[0];
		assert.ok(first, "builtin models should be non-empty");
		const res = await handleRpcCommand(
			{ type: "set_model", id: "3", provider: first.provider, modelId: first.id },
			{ session, models, sessionManager: session.session, output: () => {} },
		);
		assert.equal(res?.success, true);
		const model = session.model as { provider?: string; id?: string };
		assert.equal(model.id, first.id);
	});

	it("set_model with an unknown model fails", async () => {
		const session = makeSession();
		const res = await handleRpcCommand(
			{ type: "set_model", id: "4", provider: "nope", modelId: "nope" },
			{ session, models: builtinModels(), sessionManager: session.session, output: () => {} },
		);
		assert.equal(res?.success, false);
	});

	it("get_commands lists categorized commands", async () => {
		const session = makeSession();
		const res = await handleRpcCommand(
			{ type: "get_commands", id: "5" },
			{ session, models: builtinModels(), sessionManager: session.session, output: () => {} },
		);
		const data = (res as { data?: { commands: { name: string; category: string }[] } }).data;
		assert.ok(data?.commands.some((c) => c.name === "compact"));
	});

	it("invoke_command runs a slash command", async () => {
		const session = makeSession();
		const res = await handleRpcCommand(
			{ type: "invoke_command", id: "6", text: "/mode plan" },
			{ session, models: builtinModels(), sessionManager: session.session, output: () => {} },
		);
		assert.equal(res?.success, true);
		assert.equal(session.mode, "plan");
	});

	it("set_session_name names the session", async () => {
		const session = makeSession();
		const res = await handleRpcCommand(
			{ type: "set_session_name", id: "7", name: "rpc task" },
			{ session, models: builtinModels(), sessionManager: session.session, output: () => {} },
		);
		assert.equal(res?.success, true);
		assert.equal(session.session.name, "rpc task");
	});

	it("unknown command type fails", async () => {
		const session = makeSession();
		const res = await handleRpcCommand(
			{ type: "bogus" as never, id: "8" },
			{ session, models: builtinModels(), sessionManager: session.session, output: () => {} },
		);
		assert.equal(res?.success, false);
	});
});

describe("createRpcUi roundtrip", () => {
	it("confirm emits a request and resolves from the matching response", async () => {
		const emitted: RpcOutput[] = [];
		const handle = createRpcUi((v) => emitted.push(v));
		const confirmPromise = handle.ui.confirm("title", "are you sure?");
		// Wait for the request to be emitted.
		await new Promise((r) => setTimeout(r, 0));
		const request = emitted.find((e) => (e as { method?: string }).method === "confirm") as {
			id: string;
			method: string;
		};
		assert.ok(request, "confirm should emit an extension_ui_request");
		handle.resolveResponse({ type: "extension_ui_response", id: request.id, confirmed: true });
		assert.equal(await confirmPromise, true);
	});

	it("notify is fire-and-forget (emits, no response needed)", async () => {
		const emitted: RpcOutput[] = [];
		const handle = createRpcUi((v) => emitted.push(v));
		handle.ui.notify("hello", "info");
		await new Promise((r) => setTimeout(r, 0));
		assert.ok(emitted.some((e) => (e as { method?: string }).method === "notify"));
	});

	it("rejectAll rejects pending requests", async () => {
		const handle = createRpcUi(() => {});
		const p = handle.ui.confirm("t", "m").catch(() => false);
		await new Promise((r) => setTimeout(r, 0));
		handle.rejectAll(new Error("shutdown"));
		assert.equal(await p, false);
	});
});
