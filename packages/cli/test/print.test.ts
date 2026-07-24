/** Print mode tests (faux provider). Captures process.stdout.write. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AgentSession, SessionManager, type StreamFn } from "@arbor-space/core";
import { createCodingTools } from "@arbor-space/core/tools";
import {
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";
import { runPrintMode } from "../src/modes/print.ts";

let workspace: string;
let faux: FauxProviderHandle;
let streamFn: StreamFn;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "arbor-print-ws-"));
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

/** Swap process.stdout.write for a collector; returns [capture, restore]. */
function captureStdout(): [() => string, () => void] {
	const chunks: string[] = [];
	const real = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: unknown, encodingOrCb?: unknown, cb?: unknown) => {
		chunks.push(typeof chunk === "string" ? chunk : String(chunk));
		// Node accepts write(chunk, cb) (2-arg) or write(chunk, encoding, cb).
		const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
		if (typeof callback === "function") (callback as () => void)();
		return true;
	}) as typeof process.stdout.write;
	const restore = (): void => {
		process.stdout.write = real;
	};
	return [() => chunks.join(""), restore];
}

describe("runPrintMode", () => {
	it("text mode prints the final assistant text", async () => {
		faux.setResponses([fauxAssistantMessage("Hello from the agent.")]);
		const session = makeSession();
		const [capture, restore] = captureStdout();
		try {
			const code = await runPrintMode(session, { mode: "text", messages: ["hi"] });
			assert.equal(code, 0);
			assert.ok(capture().includes("Hello from the agent."));
		} finally {
			restore();
		}
	});

	it("json mode streams NDJSON events prefixed by session_start", async () => {
		faux.setResponses([fauxAssistantMessage("done.")]);
		const session = makeSession();
		const [capture, restore] = captureStdout();
		try {
			const code = await runPrintMode(session, { mode: "json", messages: ["hi"] });
			assert.equal(code, 0);
			const lines = capture()
				.split("\n")
				.filter((l) => l.length > 0);
			assert.ok(lines.length > 0);
			const parsed = lines.map((l) => JSON.parse(l) as { type: string });
			assert.equal(parsed[0]?.type, "session_start");
			assert.ok(parsed.some((e) => e.type === "agent_start" || e.type === "agent_end"));
		} finally {
			restore();
		}
	});
});
