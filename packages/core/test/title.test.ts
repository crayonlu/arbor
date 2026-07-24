/** Session title generation tests. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";
import { AgentSession } from "../src/agent-session.ts";
import { SessionManager } from "../src/session/manager.ts";
import { cleanTitle, generateSessionTitle } from "../src/session/title.ts";
import type { StreamFn } from "../src/types.ts";

let workspace: string;
let sessionsRoot: string;
let faux: FauxProviderHandle;
let streamFn: StreamFn;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "arbor-title-ws-"));
	sessionsRoot = await mkdtemp(path.join(os.tmpdir(), "arbor-title-sess-"));
	faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	streamFn = (model, context, options) => models.streamSimple(model, context, options);
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	await rm(sessionsRoot, { recursive: true, force: true });
});

describe("cleanTitle", () => {
	it("takes the first non-empty line and strips quotes and trailing period", () => {
		assert.equal(cleanTitle('\n  "Fix login bug." \nextra'), "Fix login bug");
		assert.equal(cleanTitle("'Add tests'"), "Add tests");
		assert.equal(cleanTitle("`Refactor`"), "Refactor");
	});

	it("caps length with an ellipsis", () => {
		const long = "a".repeat(100);
		const title = cleanTitle(long);
		assert.ok(title.length <= 60);
		assert.ok(title.endsWith("…"));
	});

	it("empty input stays empty", () => {
		assert.equal(cleanTitle("   \n  "), "");
	});
});

describe("generateSessionTitle", () => {
	it("returns the cleaned title from the model", async () => {
		faux.setResponses([fauxAssistantMessage('"Wire up OAuth flow."')]);
		const title = await generateSessionTitle(streamFn, faux.getModel(), "please add oauth to mcp");
		assert.equal(title, "Wire up OAuth flow");
	});

	it("returns null on model error", async () => {
		faux.setResponses([fauxAssistantMessage("x", { stopReason: "error", errorMessage: "boom" })]);
		const title = await generateSessionTitle(streamFn, faux.getModel(), "anything");
		assert.equal(title, null);
	});

	it("returns null for an empty reply", async () => {
		faux.setResponses([fauxAssistantMessage("   ")]);
		const title = await generateSessionTitle(streamFn, faux.getModel(), "anything");
		assert.equal(title, null);
	});
});

describe("SessionManager.setName", () => {
	it("rewrites the header line and survives reload", async () => {
		const manager = SessionManager.create(workspace, { sessionsRoot });
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.setName("My session");
		assert.equal(manager.name, "My session");

		const reloaded = SessionManager.load(manager.filePath as string);
		assert.equal(reloaded.name, "My session");
		// Entries after the header are intact.
		assert.equal(reloaded.buildContextMessages().length, 1);
	});

	it("works for ephemeral sessions without a file", () => {
		const manager = SessionManager.inMemory(workspace);
		manager.setName("ephemeral");
		assert.equal(manager.name, "ephemeral");
	});
});

describe("AgentSession auto title", () => {
	function makeSession(overrides: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
		return new AgentSession({
			cwd: workspace,
			model: faux.getModel(),
			streamFn,
			systemPrompt: "You are Arbor.",
			tools: [],
			sessionManager: SessionManager.create(workspace, { sessionsRoot }),
			contextFiles: false,
			...overrides,
		});
	}

	it("names the session after the first prompt", async () => {
		faux.setResponses([
			fauxAssistantMessage("Sure, done."),
			// Title generation call.
			fauxAssistantMessage("Set up the project"),
		]);
		const session = makeSession();
		await session.prompt("set up the project skeleton");
		await session.titleSettled();
		assert.equal(session.session.name, "Set up the project");

		const reloaded = SessionManager.load(session.session.filePath as string);
		assert.equal(reloaded.name, "Set up the project");
	});

	it("does not overwrite an existing name", async () => {
		faux.setResponses([fauxAssistantMessage("ok")]);
		const session = makeSession();
		session.session.setName("Manual name");
		await session.prompt("hello");
		await session.titleSettled();
		assert.equal(session.session.name, "Manual name");
	});

	it("autoTitle: false disables generation", async () => {
		faux.setResponses([fauxAssistantMessage("ok")]);
		const session = makeSession({ autoTitle: false });
		await session.prompt("hello");
		await session.titleSettled();
		assert.equal(session.session.name, undefined);
	});

	it("title failure leaves the session unnamed and does not break the turn", async () => {
		faux.setResponses([
			fauxAssistantMessage("Turn reply."),
			fauxAssistantMessage("x", { stopReason: "error", errorMessage: "title model down" }),
		]);
		const session = makeSession();
		const messages = await session.prompt("do something");
		await session.titleSettled();
		assert.ok(messages.length > 0);
		assert.equal(session.session.name, undefined);
	});
});
