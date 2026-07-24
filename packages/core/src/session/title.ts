/**
 * Session title generation: a one-line name for the session list, produced
 * by a small LLM call from the first user prompt.
 */
import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "../types.ts";

const TITLE_SYSTEM_PROMPT =
	"Generate a short title (max 50 characters) for a coding session that starts with the user message below. " +
	"Reply with the title only: one line, no quotes, no trailing period, imperative or noun phrase.";

const MAX_PROMPT_CHARS = 2000;
const MAX_TITLE_CHARS = 60;

/** Normalize an LLM title reply: first line, quotes stripped, length-capped. */
export function cleanTitle(raw: string): string {
	let title =
		raw
			.split("\n")
			.find((line) => line.trim().length > 0)
			?.trim() ?? "";
	title = title.replace(/^["'`]+|["'`.]+$/g, "").trim();
	if (title.length > MAX_TITLE_CHARS) {
		title = `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
	}
	return title;
}

/**
 * Generate a session title from the first user prompt. Returns null when the
 * model produces nothing usable or errors — callers treat that as "no title".
 */
export async function generateSessionTitle(
	streamFn: StreamFn,
	model: Model<any>,
	firstUserText: string,
	signal?: AbortSignal,
): Promise<string | null> {
	try {
		const stream = await streamFn(
			model,
			{
				systemPrompt: TITLE_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: firstUserText.slice(0, MAX_PROMPT_CHARS),
						timestamp: Date.now(),
					},
				],
			},
			signal ? { signal } : {},
		);
		const message = await stream.result();
		if (message.stopReason === "error" || message.stopReason === "aborted") return null;
		const text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const title = cleanTitle(text);
		return title.length > 0 ? title : null;
	} catch {
		return null;
	}
}
