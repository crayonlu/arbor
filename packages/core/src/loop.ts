/**
 * The Arbor agent loop.
 *
 * Works with AgentMessage throughout; transforms to LLM Message[] only at the
 * stream call boundary. Emits AgentEvents; `agent_end` is always the final
 * event. Transient provider errors are retried with exponential backoff and
 * context overflow is delegated to `config.onOverflow` (compaction).
 */
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { EventStream, isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AgentEventSink } from "./loop-tools.ts";
import { executeToolCalls, failToolCallsFromTruncatedMessage } from "./loop-tools.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	LlmContext,
	LoopRetryPolicy,
	StreamFn,
} from "./types.ts";

export type { AgentEventSink } from "./loop-tools.ts";

const DEFAULT_RETRY_POLICY: LoopRetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

export type AgentEventStream = EventStream<AgentEvent, AgentMessage[]>;

function createAgentStream(): AgentEventStream {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event) => event.type === "agent_end",
		(event) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Start an agent loop with new prompt messages. The prompts are appended to
 * the context and message events are emitted for them.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	streamFn: StreamFn,
	signal?: AbortSignal,
): AgentEventStream {
	const stream = createAgentStream();
	void runAgentLoop(prompts, context, config, streamFn, (e) => stream.push(e), signal).then((messages) =>
		stream.end(messages),
	);
	return stream;
}

/**
 * Continue an agent loop from the current context without adding a message.
 * Used for resume/retry — the context must already end with a user or
 * toolResult message once converted via `convertToLlm`.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	streamFn: StreamFn,
	signal?: AbortSignal,
): AgentEventStream {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}
	const last = context.messages[context.messages.length - 1];
	if (last && "role" in last && last.role === "assistant") {
		throw new Error("Cannot continue from an assistant message");
	}
	const stream = createAgentStream();
	void runAgentLoop([], context, config, streamFn, (e) => stream.push(e), signal).then((messages) =>
		stream.end(messages),
	);
	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	streamFn: StreamFn,
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

/** Main loop: turns, tool calls, steering, and follow-up queues. */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn: StreamFn,
): Promise<void> {
	let firstTurn = true;
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop continues when follow-up messages arrive after the agent would stop.
	outer: while (true) {
		let hasMoreToolCalls = true;

		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			for (const message of pendingMessages) {
				await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				currentContext.messages.push(message);
				newMessages.push(message);
			}
			pendingMessages = [];

			const message = await streamWithRecovery(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				break outer;
			}

			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// A "length" stop cut the output short: every tool call may carry
				// truncated arguments, so fail the batch instead of executing it.
				const batch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...batch.messages);
				hasMoreToolCalls = !batch.terminate;
				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			if (
				await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				break outer;
			}

			if (signal?.aborted) {
				break outer;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		const followUps = (await config.getFollowUpMessages?.()) || [];
		if (followUps.length === 0) {
			break;
		}
		pendingMessages = followUps;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			signal?.removeEventListener("abort", done);
			clearTimeout(timer);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

/**
 * Stream one assistant response with transient-error retry and one-shot
 * overflow recovery. Failed attempts are removed from the context before the
 * next attempt so the transcript never contains abandoned error messages.
 */
async function streamWithRecovery(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn: StreamFn,
): Promise<AssistantMessage> {
	const retry = config.retry ?? DEFAULT_RETRY_POLICY;
	const maxRetries = retry.enabled ? retry.maxRetries : 0;
	let overflowHandled = false;
	let attempt = 0;

	while (true) {
		const lengthBefore = context.messages.length;
		const message = await streamAssistantResponse(context, config, signal, emit, streamFn);
		if (message.stopReason !== "error" || signal?.aborted) {
			return message;
		}

		const popFailed = () => {
			context.messages.length = lengthBefore;
		};

		if (!overflowHandled && config.onOverflow && isContextOverflow(message, config.model.contextWindow)) {
			overflowHandled = true;
			popFailed();
			const replacement = await config.onOverflow(context.messages, signal);
			if (replacement) {
				context.messages = replacement;
				continue;
			}
			// Overflow handler gave up: restore the error message and surface it.
			context.messages.push(message);
			return message;
		}

		if (attempt < maxRetries && isRetryableAssistantError(message)) {
			attempt += 1;
			const delayMs = retry.baseDelayMs * 2 ** (attempt - 1);
			popFailed();
			await emit({
				type: "retry_scheduled",
				attempt,
				maxAttempts: maxRetries,
				delayMs,
				errorMessage: message.errorMessage ?? "unknown provider error",
			});
			await sleep(delayMs, signal);
			if (signal?.aborted) {
				context.messages.push(message);
				return message;
			}
			continue;
		}

		return message;
	}
}

/**
 * Stream one assistant response. This is the AgentMessage[] → Message[]
 * boundary: transformContext then convertToLlm run on every call.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn: StreamFn,
): Promise<AssistantMessage> {
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
		context.messages = messages;
	}

	const llmMessages = await config.convertToLlm(messages);
	const llmContext: LlmContext = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const response = await streamFn(config.model, llmContext, {
		...config.streamOptions,
		...(signal ? { signal } : {}),
	});

	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				context.messages.push(event.partial);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...event.partial } });
				break;

			case "done":
			case "error":
				break;

			default:
				if (addedPartial) {
					context.messages[context.messages.length - 1] = event.partial;
					await emit({
						type: "message_update",
						message: { ...event.partial },
						assistantMessageEvent: event,
					});
				}
				break;
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}
