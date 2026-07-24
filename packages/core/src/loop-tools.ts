/**
 * Tool call execution for the agent loop: validation, before/after
 * interception, parallel/sequential batches, and result finalization.
 */
import type { AssistantMessage, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

export interface ExecutedToolCallBatch {
	messages: ToolResultMessage[];
	terminate: boolean;
}

interface FinalizedToolCall {
	toolCall: AgentToolCall;
	result: AgentToolResult;
	isError: boolean;
}

/** A tool call that resolved before execution (unknown tool, invalid args, blocked). */
interface ImmediateOutcome {
	kind: "immediate";
	toolCall: AgentToolCall;
	result: AgentToolResult;
	isError: boolean;
}

/** A tool call that passed validation and interception and is ready to run. */
interface PreparedCall {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
}

type Preparation = ImmediateOutcome | PreparedCall;

export function createErrorToolResult(text: string): AgentToolResult {
	return { content: [{ type: "text", text } satisfies TextContent], details: undefined };
}

function createToolResultMessage(finalized: FinalizedToolCall): ToolResultMessage {
	const { toolCall, result, isError } = finalized;
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};
	if (result.usage !== undefined) {
		message.usage = result.usage;
	}
	return message;
}

/** Early termination only when every finalized call in the batch requested it. */
function shouldTerminateBatch(finalized: FinalizedToolCall[]): boolean {
	return finalized.length > 0 && finalized.every((f) => !f.isError && f.result.terminate === true);
}

/**
 * Validate a tool call and run `beforeToolCall` interception.
 * Never throws; failures become immediate error outcomes.
 */
async function prepareToolCall(
	context: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<Preparation> {
	const tool = context.tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			toolCall,
			result: createErrorToolResult(`Unknown tool: ${toolCall.name}`),
			isError: true,
		};
	}

	let args: unknown;
	try {
		args = validateToolArguments(tool, toolCall);
	} catch (error) {
		return {
			kind: "immediate",
			toolCall,
			result: createErrorToolResult(
				`Invalid arguments for tool "${toolCall.name}": ${error instanceof Error ? error.message : String(error)}`,
			),
			isError: true,
		};
	}

	if (config.beforeToolCall) {
		try {
			const interception = await config.beforeToolCall({ assistantMessage, toolCall, args, context }, signal);
			if (interception?.block) {
				return {
					kind: "immediate",
					toolCall,
					result: createErrorToolResult(interception.reason ?? `Tool call "${toolCall.name}" was blocked.`),
					isError: true,
				};
			}
			if (interception?.args !== undefined) {
				args = interception.args;
			}
		} catch (error) {
			return {
				kind: "immediate",
				toolCall,
				result: createErrorToolResult(
					`beforeToolCall interceptor failed: ${error instanceof Error ? error.message : String(error)}`,
				),
				isError: true,
			};
		}
	}

	return { kind: "prepared", toolCall, tool, args };
}

/** Execute a prepared call. Tool throw/abort becomes an error result. */
async function executePreparedCall(
	prepared: PreparedCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<{ result: AgentToolResult; isError: boolean }> {
	const { toolCall, tool, args } = prepared;
	try {
		const result = await tool.execute(toolCall.id, args as never, signal, (partialResult) => {
			void emit({
				type: "tool_execution_update",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args,
				partialResult,
			});
		});
		return { result, isError: false };
	} catch (error) {
		if (signal?.aborted) {
			return { result: createErrorToolResult("Tool execution aborted."), isError: true };
		}
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

/** Apply `afterToolCall` overrides to an executed result. */
async function finalizeExecutedCall(
	context: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedCall,
	executed: { result: AgentToolResult; isError: boolean },
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCall> {
	let { result, isError } = executed;
	if (config.afterToolCall) {
		try {
			const override = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					context,
					result,
					isError,
				},
				signal,
			);
			if (override) {
				result = {
					content: override.content ?? result.content,
					details: override.details !== undefined ? override.details : result.details,
					...(override.usage !== undefined || result.usage !== undefined
						? { usage: override.usage ?? result.usage }
						: {}),
					...(override.terminate !== undefined || result.terminate !== undefined
						? { terminate: override.terminate ?? result.terminate }
						: {}),
				};
				isError = override.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(
				`afterToolCall interceptor failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			isError = true;
		}
	}
	return { toolCall: prepared.toolCall, result, isError };
}

async function emitEndAndCreateMessage(
	finalized: FinalizedToolCall,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
	const message = createToolResultMessage(finalized);
	await emit({ type: "message_start", message });
	await emit({ type: "message_end", message });
	return message;
}

/**
 * Fail every tool call from an assistant message truncated by the output token
 * limit: streamed arguments may parse but be silently incomplete, so none are
 * safe to execute.
 */
export async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCall = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		messages.push(await emitEndAndCreateMessage(finalized, emit));
	}
	return { messages, terminate: false };
}

/**
 * Execute all tool calls from an assistant message.
 *
 * Tools whose definition sets `parallel: false` — or a config-level
 * "sequential" mode — force one-at-a-time execution. Otherwise calls are
 * prepared sequentially (interceptors see a stable order) and executed
 * concurrently; results are emitted in assistant source order.
 */
export async function executeToolCalls(
	context: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const finalized: FinalizedToolCall[] = [];
	const messages: ToolResultMessage[] = [];

	// Phase 1: emit starts + prepare sequentially so interceptors run in order.
	const preparations: Preparation[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		preparations.push(await prepareToolCall(context, assistantMessage, toolCall, config, signal));
	}

	// Phase 2: execute prepared calls concurrently.
	const executions = preparations.map(async (prep) => {
		if (prep.kind === "immediate") {
			return { toolCall: prep.toolCall, result: prep.result, isError: prep.isError };
		}
		const executed = await executePreparedCall(prep, signal, emit);
		return finalizeExecutedCall(context, assistantMessage, prep, executed, config, signal);
	});
	const settled = await Promise.all(executions);

	// Phase 3: finalize + emit in assistant source order.
	for (const outcome of settled) {
		finalized.push(outcome);
		messages.push(await emitEndAndCreateMessage(outcome, emit));
	}

	return { messages, terminate: shouldTerminateBatch(finalized) };
}
