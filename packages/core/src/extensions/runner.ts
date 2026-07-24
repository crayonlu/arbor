/**
 * ExtensionRunner: registers extensions and dispatches events to them.
 *
 * Handlers run in registration order. For intercepting events (tool_call,
 * tool_result, context, compaction, user_prompt) the first decisive result
 * wins for block/handled semantics, while transform results chain: each
 * handler sees the output of the previous one.
 */
import type { AgentTool } from "../types.ts";
import type {
	ContextEventResult,
	ExtensionAPI,
	ExtensionCommand,
	ExtensionContext,
	ExtensionEventHandler,
	ExtensionEventMap,
	ExtensionEventName,
	ExtensionFactory,
	ToolCallEventResult,
	ToolResultEventResult,
} from "./types.ts";

interface RegisteredHandler {
	event: ExtensionEventName;
	handler: ExtensionEventHandler<any>;
	/** Name of the extension that registered this handler (diagnostics). */
	source: string;
}

export interface ExtensionLoadError {
	source: string;
	error: Error;
}

export class ExtensionRunner {
	private handlers: RegisteredHandler[] = [];
	private tools = new Map<string, AgentTool<any>>();
	private commands = new Map<string, ExtensionCommand>();
	private loadErrors: ExtensionLoadError[] = [];

	/** Run an extension factory, collecting its registrations. */
	async register(factory: ExtensionFactory, source = "inline"): Promise<void> {
		const api: ExtensionAPI = {
			on: (event, handler) => {
				this.handlers.push({ event, handler, source });
			},
			registerTool: (tool) => {
				if (this.tools.has(tool.name)) {
					throw new Error(`Duplicate extension tool name: ${tool.name} (from ${source})`);
				}
				this.tools.set(tool.name, tool);
			},
			registerCommand: (name, command) => {
				if (this.commands.has(name)) {
					throw new Error(`Duplicate extension command: /${name} (from ${source})`);
				}
				this.commands.set(name, command);
			},
		};
		try {
			await factory(api);
		} catch (error) {
			this.loadErrors.push({
				source,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		}
	}

	getTools(): AgentTool<any>[] {
		return [...this.tools.values()];
	}

	getCommands(): Map<string, ExtensionCommand> {
		return new Map(this.commands);
	}

	getLoadErrors(): ExtensionLoadError[] {
		return [...this.loadErrors];
	}

	/**
	 * Fire a notification event (no result). Handler failures are isolated:
	 * one broken extension does not break the run.
	 */
	async emit<K extends ExtensionEventName>(
		event: K,
		payload: ExtensionEventMap[K]["event"],
		ctx: ExtensionContext,
	): Promise<void> {
		for (const registered of this.handlers) {
			if (registered.event !== event) continue;
			try {
				await registered.handler(payload, ctx);
			} catch {
				// Notification handlers must not break the loop.
			}
		}
	}

	/**
	 * Fire `tool_call`. The first handler that blocks wins; `args` rewrites
	 * chain through subsequent handlers.
	 */
	async emitToolCall(
		payload: ExtensionEventMap["tool_call"]["event"],
		ctx: ExtensionContext,
	): Promise<ToolCallEventResult | undefined> {
		let currentArgs: unknown = payload.input;
		let rewritten = false;
		for (const registered of this.handlers) {
			if (registered.event !== "tool_call") continue;
			const result = (await registered.handler({ ...payload, input: currentArgs }, ctx)) as
				| ToolCallEventResult
				| undefined;
			if (result?.block) {
				return result;
			}
			if (result?.args !== undefined) {
				currentArgs = result.args;
				rewritten = true;
			}
		}
		return rewritten ? { args: currentArgs } : undefined;
	}

	/** Fire `tool_result`. Override fields chain across handlers. */
	async emitToolResult(
		payload: ExtensionEventMap["tool_result"]["event"],
		ctx: ExtensionContext,
	): Promise<ToolResultEventResult | undefined> {
		let current = payload;
		let override: ToolResultEventResult | undefined;
		for (const registered of this.handlers) {
			if (registered.event !== "tool_result") continue;
			const result = (await registered.handler(current, ctx)) as ToolResultEventResult | undefined;
			if (result) {
				override = { ...override, ...result };
				current = {
					...current,
					result: {
						content: (result.content ?? current.result.content) as unknown[],
						details: result.details !== undefined ? result.details : current.result.details,
					},
					isError: result.isError ?? current.isError,
				};
			}
		}
		return override;
	}

	/** Fire `context`. Message-list transforms chain across handlers. */
	async emitContext(
		payload: ExtensionEventMap["context"]["event"],
		ctx: ExtensionContext,
	): Promise<ContextEventResult | undefined> {
		let messages = payload.messages;
		let transformed = false;
		for (const registered of this.handlers) {
			if (registered.event !== "context") continue;
			const result = (await registered.handler({ type: "context", messages }, ctx)) as
				| ContextEventResult
				| undefined;
			if (result?.messages) {
				messages = result.messages;
				transformed = true;
			}
		}
		return transformed ? { messages } : undefined;
	}

	/** Fire `compaction`. The first handler that provides a summary takes over. */
	async emitCompaction(
		payload: ExtensionEventMap["compaction"]["event"],
		ctx: ExtensionContext,
	): Promise<ExtensionEventMap["compaction"]["result"]> {
		for (const registered of this.handlers) {
			if (registered.event !== "compaction") continue;
			const result = await registered.handler(payload, ctx);
			if (result && (result as { summary?: string }).summary !== undefined) {
				return result as ExtensionEventMap["compaction"]["result"];
			}
		}
		return undefined;
	}

	/** Fire `user_prompt`. `handled` short-circuits; text rewrites chain. */
	async emitUserPrompt(
		payload: ExtensionEventMap["user_prompt"]["event"],
		ctx: ExtensionContext,
	): Promise<ExtensionEventMap["user_prompt"]["result"]> {
		let text = payload.text;
		let rewritten = false;
		for (const registered of this.handlers) {
			if (registered.event !== "user_prompt") continue;
			const result = await registered.handler({ type: "user_prompt", text }, ctx);
			if (result?.handled) {
				return { handled: true };
			}
			if (result?.text !== undefined) {
				text = result.text;
				rewritten = true;
			}
		}
		return rewritten ? { text } : undefined;
	}
}
