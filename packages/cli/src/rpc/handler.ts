/**
 * RPC command handler, extracted so it can be unit-tested with a faux session
 * (no real stdio). `runRpcMode` delegates here; tests call `handleRpcCommand`
 * directly.
 */
import type { AgentSession, SessionManager } from "@arbor-space/core";
import type { MutableModels } from "@earendil-works/pi-ai";
import { createSlashRuntime, executeSlashCommand, listCommands } from "../commands/index.ts";
import { fail, ok, type RpcCommand, type RpcOutput, type RpcResponse } from "./types.ts";

export type RpcOutputFn = (value: RpcOutput) => void;

export async function handleRpcCommand(
	command: RpcCommand,
	ctx: {
		session: AgentSession;
		models: MutableModels;
		sessionManager: SessionManager;
		output: RpcOutputFn;
	},
): Promise<RpcResponse | undefined> {
	const { session, models, sessionManager, output } = ctx;
	const id = command.id;
	try {
		switch (command.type) {
			case "prompt": {
				// Prompt streams events; respond immediately. Errors surface as a
				// separate failure response since the success response already went out.
				void session.prompt(command.message).catch((e: unknown) => {
					output(fail(id, "prompt", e instanceof Error ? e.message : String(e)));
				});
				return ok(id, "prompt");
			}
			case "steer":
				session.steer(command.message);
				return ok(id, "steer");
			case "abort":
				session.abort();
				return ok(id, "abort");
			case "request_stop":
				session.requestStop();
				return ok(id, "request_stop");
			case "get_state":
				return ok(id, "get_state", {
					model: modelId(session),
					mode: session.mode,
					isRunning: session.isRunning,
					messageCount: session.getMessages().length,
					sessionId: session.session.sessionId,
					...(session.session.name ? { name: session.session.name } : {}),
					usage: session.getUsageTotals(),
				});
			case "get_messages":
				return ok(id, "get_messages", { messages: session.getMessages() });
			case "set_model": {
				const model = models.getModel(command.provider, command.modelId);
				if (!model) return fail(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				session.model = model;
				return ok(id, "set_model", { model: modelId(session) });
			}
			case "set_mode":
				session.mode = command.mode;
				return ok(id, "set_mode", { mode: session.mode });
			case "compact":
				await session.compactNow();
				return ok(id, "compact");
			case "rewind":
				await session.rewind(command.entryId);
				return ok(id, "rewind");
			case "get_tree":
				return ok(id, "get_tree", {
					entries: session.session.getAllEntries(),
					leafId: session.session.leaf,
				});
			case "get_entries": {
				const all = session.session.getAllEntries();
				const entries = command.since
					? all.slice(Math.max(0, all.findIndex((e) => e.id === command.since) + 1))
					: all;
				return ok(id, "get_entries", { entries, leafId: session.session.leaf });
			}
			case "get_commands":
				return ok(id, "get_commands", { commands: listCommands(session) });
			case "invoke_command": {
				const runtime = createSlashRuntime(session, sessionManager, {
					output: (text) => output({ type: "command_output", text }),
				});
				const result = await executeSlashCommand(command.text, runtime);
				return ok(id, "invoke_command", { result });
			}
			case "set_session_name": {
				const name = command.name.trim();
				if (!name) return fail(id, "set_session_name", "name cannot be empty");
				session.session.setName(name);
				return ok(id, "set_session_name");
			}
			case "shutdown":
				return ok(id, "shutdown");
			case "fork":
				// Forking switches the live session; surfaced via the CLI --session
				// flag rather than mid-RPC. Acknowledge so hosts know it's intentional.
				return fail(id, "fork", "Use --session to fork; mid-stream fork is not supported in rpc");
			default:
				return fail(id, (command as { type: string }).type, "Unknown command");
		}
	} catch (error) {
		return fail(id, command.type, error instanceof Error ? error.message : String(error));
	}
}

export function modelId(session: AgentSession): string {
	const model = session.model as { provider?: string; id?: string } | undefined;
	if (!model) return "unknown";
	return model.provider && model.id ? `${model.provider}/${model.id}` : (model.id ?? "unknown");
}
