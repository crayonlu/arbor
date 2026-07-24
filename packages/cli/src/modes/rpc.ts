/**
 * RPC mode: a stdio JSONL protocol for embedding Arbor in other applications.
 *
 * stdin  : commands (`{type, id?, ...}`) and `extension_ui_response` replies.
 * stdout : `response` (id-correlated), AgentEvents (streamed), and
 *          `extension_ui_request` (ask/confirm/select/input roundtrip).
 *
 * The session is built with the roundtrip ExtensionUi so headless hosts can
 * still answer the ask tool and extension prompts. stdin `end` or a `shutdown`
 * command tears down cleanly. Command logic lives in `rpc/handler.ts` so it can
 * be unit-tested without stdio.
 */

import type { AgentEvent, SessionManager } from "@arbor-space/core";
import type { Args } from "../args.ts";
import { buildSession } from "../build-session.ts";
import { attachJsonlLineReader, serializeLine } from "../ndjson.ts";
import { writeRawStdout } from "../output-guard.ts";
import { handleRpcCommand } from "../rpc/handler.ts";
import { createRpcUi } from "../rpc/protocol.ts";
import { fail, type RpcCommand, type RpcOutput } from "../rpc/types.ts";

export interface RunRpcOptions {
	cwd: string;
	args: Args;
	sessionManager: SessionManager;
}

export async function runRpcMode(options: RunRpcOptions): Promise<void> {
	const { cwd, args, sessionManager } = options;

	const output = (value: RpcOutput | AgentEvent): void => {
		writeRawStdout(serializeLine(value));
	};

	const rpcUi = createRpcUi(output);
	const { session, models } = await buildSession({ cwd, args, sessionManager, mode: "rpc", ui: rpcUi.ui });

	const unsubscribe = session.subscribe((event: AgentEvent) => output(event));

	let shuttingDown = false;
	let detachInput: () => void = () => {};
	const shutdown = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		rpcUi.rejectAll(new Error("RPC shutting down"));
		unsubscribe();
		session.abort();
		detachInput();
		process.stdin.pause();
	};

	const handleLine = async (line: string): Promise<void> => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			output(
				fail(
					undefined,
					"parse",
					`Failed to parse command: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
			return;
		}
		if (typeof parsed !== "object" || parsed === null) return;
		const obj = parsed as { type?: string };

		if (obj.type === "extension_ui_response") {
			rpcUi.resolveResponse(parsed as Parameters<typeof rpcUi.resolveResponse>[0]);
			return;
		}
		const command = parsed as RpcCommand;
		const response = await handleRpcCommand(command, { session, models, sessionManager, output });
		if (response) output(response);
		if (command.type === "shutdown") {
			await shutdown();
			process.exit(0);
		}
	};

	const onEnd = (): void => {
		void shutdown().then(() => process.exit(0));
	};
	process.stdin.on("end", onEnd);

	detachInput = attachJsonlLineReader(process.stdin, (line) => {
		void handleLine(line);
	});

	for (const sig of ["SIGTERM", "SIGHUP"] as const) {
		const handler = (): void => {
			void shutdown().then(() => process.exit(sig === "SIGHUP" ? 129 : 143));
		};
		process.on(sig, handler);
	}

	// Keep the process alive for the stdin-driven loop.
	await new Promise<void>(() => {});
}

// Re-export for callers/tests.
export { handleRpcCommand } from "../rpc/handler.ts";
