/**
 * Context compaction: summarize older messages when the context approaches
 * the model window, keeping a recent tail intact.
 *
 * Cut-point rules: never cut at a tool result (it must stay with its tool
 * call); cut at user or assistant boundaries walking back from the newest
 * message until the keep budget is spent.
 */
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type { AgentMessage, LlmContext, StreamFn } from "../types.ts";

/** Tokens reserved for the model's response when deciding to compact. */
export const DEFAULT_RESERVE_TOKENS = 16_384;
/** Token budget for the kept tail of recent messages. */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

export interface CompactionSettings {
	reserveTokens?: number;
	keepRecentTokens?: number;
}

export interface CompactionResult {
	summary: string;
	/** Messages kept after the summary (the recent tail). */
	keepMessages: AgentMessage[];
	/** Estimated tokens before compaction. */
	tokensBefore: number;
	/** LLM usage from generating the summary, if the built-in path ran. */
	usage?: Usage;
}

/**
 * Cheap token estimate: ~4 characters per token over the JSON serialization.
 * Used for thresholds only; providers do the authoritative accounting.
 */
export function estimateTokens(messages: AgentMessage[]): number {
	let chars = 0;
	for (const message of messages) {
		chars += JSON.stringify(message).length;
	}
	return Math.ceil(chars / 4);
}

/** Whether the context is close enough to the window to warrant compaction. */
export function shouldCompact(
	messages: AgentMessage[],
	contextWindow: number | undefined,
	settings: CompactionSettings = {},
): boolean {
	if (!contextWindow) return false;
	const reserve = settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
	return estimateTokens(messages) > contextWindow - reserve;
}

/**
 * Find the index of the first message to keep. Walks back accumulating
 * token estimates until the keep budget is spent, then moves forward to the
 * nearest valid cut point (a message that is not a tool result).
 */
export function findCutPoint(messages: AgentMessage[], keepRecentTokens: number): number {
	let budget = keepRecentTokens;
	let index = messages.length;
	while (index > 0) {
		const message = messages[index - 1] as AgentMessage;
		const cost = estimateTokens([message]);
		if (cost > budget) break;
		budget -= cost;
		index--;
	}
	// Never start the kept tail at a tool result: advance to the next
	// non-toolResult boundary (tool results must follow their tool call).
	while (index < messages.length) {
		const message = messages[index] as AgentMessage;
		if (!("role" in message) || message.role !== "toolResult") break;
		index++;
	}
	return index;
}

const SUMMARIZE_SYSTEM_PROMPT = `You are a conversation summarizer for a coding agent. Summarize the conversation so the agent can continue seamlessly with the summary as its only memory of this span.

Structure the summary as:
## Goal
What the user is trying to achieve overall.
## State
What has been done so far: files created/modified/read (with paths), commands run, decisions made and why.
## Open items
What remains to be done, known problems, and the immediate next step.

Be specific about file paths, function names, and command invocations. Omit pleasantries and reasoning that no longer matters.`;

/** Serialize messages for the summarizer input. */
function serializeForSummary(messages: AgentMessage[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (!("role" in message)) continue;
		if (message.role === "user") {
			const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
			parts.push(`[user]\n${text}`);
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text") parts.push(`[assistant]\n${block.text}`);
				else if (block.type === "toolCall")
					parts.push(`[assistant tool call] ${block.name}(${JSON.stringify(block.arguments)})`);
			}
		} else if (message.role === "toolResult") {
			const text = message.content
				.map((c) => (c.type === "text" ? c.text : "[image]"))
				.join("\n")
				.slice(0, 2_000);
			parts.push(`[tool result: ${message.toolName}${message.isError ? " ERROR" : ""}]\n${text}`);
		}
	}
	return parts.join("\n\n");
}

/**
 * Run the built-in LLM compaction: summarize everything before the cut point.
 * `previousSummary` (from an earlier compaction) is folded in iteratively.
 */
export async function compactMessages(
	messages: AgentMessage[],
	model: Model<any>,
	streamFn: StreamFn,
	settings: CompactionSettings = {},
	previousSummary?: string,
	signal?: AbortSignal,
): Promise<CompactionResult> {
	const keepRecentTokens = settings.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
	const tokensBefore = estimateTokens(messages);
	const cutIndex = findCutPoint(messages, keepRecentTokens);
	const toSummarize = messages.slice(0, cutIndex);
	const keepMessages = messages.slice(cutIndex);

	if (toSummarize.length === 0) {
		return { summary: previousSummary ?? "", keepMessages, tokensBefore };
	}

	const input = [
		previousSummary ? `Previous summary (fold into the new one):\n${previousSummary}` : undefined,
		`Conversation to summarize:\n${serializeForSummary(toSummarize)}`,
	]
		.filter((s): s is string => s !== undefined)
		.join("\n\n---\n\n");

	const llmContext: LlmContext = {
		systemPrompt: SUMMARIZE_SYSTEM_PROMPT,
		messages: [{ role: "user", content: input, timestamp: Date.now() }],
	};
	const stream = await streamFn(model, llmContext, signal ? { signal } : {});
	const response: AssistantMessage = await stream.result();
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(`Compaction summarization failed: ${response.errorMessage ?? response.stopReason}`);
	}
	const summary = response.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	return { summary, keepMessages, tokensBefore, usage: response.usage };
}
