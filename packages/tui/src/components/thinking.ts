/**
 * Thinking tail: a clamped view of the model's reasoning. Only the most recent
 * lines are visible — older reasoning scrolls off the top — so a long thinking
 * stream never displaces the conversation. Always clamped (Ctrl+O is reserved
 * for tool output); there is no expand.
 */
import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import type { ArborTheme } from "../theme.ts";

export interface ThinkingTail {
	container: BoxRenderable;
	update: (text: string, streaming: boolean) => void;
}

const MAX_LINES = 6;

/** Keep only the trailing N lines so old reasoning scrolls off the top. */
function tail(text: string): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	if (lines.length <= MAX_LINES) return { text, truncated: false };
	return { text: lines.slice(lines.length - MAX_LINES).join("\n"), truncated: true };
}

export function createThinkingTail(
	renderer: CliRenderer,
	theme: ArborTheme,
	opts: { width: number },
): ThinkingTail {
	const container = new BoxRenderable(renderer, {
		flexDirection: "column",
		width: opts.width,
		border: true,
		borderColor: theme.borderDim,
		borderStyle: "single",
		paddingLeft: 1,
		paddingRight: 1,
	});
	const label = new TextRenderable(renderer, { content: "thinking", fg: theme.think });
	const body = new TextRenderable(renderer, { content: "", fg: theme.dim });
	container.add(label);
	container.add(body);

	return {
		container,
		update(text: string, streaming: boolean): void {
			label.fg = streaming ? theme.think : theme.dim;
			if (!text) {
				label.content = "thinking";
				body.content = "";
				return;
			}
			const { text: shown, truncated } = tail(text);
			label.content = truncated ? "thinking  ↑ older scrolled off" : "thinking";
			body.content = shown;
		},
	};
}
