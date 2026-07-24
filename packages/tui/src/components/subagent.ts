/**
 * Subagent rendering. A `task` tool call appears inline as a bordered block in
 * the main conversation; Ctrl+T (wired by the app) swaps the scrollback to a
 * read-only view of that subagent's live transcript. Multiple parallel task
 * calls each get their own switchable thread.
 */

import type { SubagentThreadItem } from "@arbor-space/core";
import { BoxRenderable, type CliRenderer, type ColorInput, TextRenderable } from "@opentui/core";
import type { Item } from "../event-bridge.ts";
import { icons } from "../icons.ts";
import type { ArborTheme } from "../theme.ts";

type TaskItem = Extract<Item, { kind: "tool" }>;

function statusText(item: TaskItem): string {
	return item.status === "done" ? "done" : item.status === "error" ? "exit 1" : "running";
}

function statusColor(item: TaskItem, theme: ArborTheme): ColorInput {
	return item.status === "error" ? theme.error : item.status === "running" ? theme.warn : theme.success;
}

function toolCount(item: TaskItem): number {
	return item.thread?.filter((t) => t.type === "tool").length ?? 0;
}

function label(item: TaskItem): string {
	const agent = item.agent ?? "task";
	return `${agent}  ${statusText(item)}  ${toolCount(item)} tools  ${icons.prompt}Ctrl+T`;
}

/** Inline bordered block shown in the main conversation. */
export function createSubagentBlock(
	renderer: CliRenderer,
	theme: ArborTheme,
	item: TaskItem,
): { container: BoxRenderable; update: (item: TaskItem) => void } {
	const container = new BoxRenderable(renderer, {
		flexDirection: "column",
		width: "100%",
		border: true,
		borderColor: theme.border,
		borderStyle: "single",
		title: ` ${label(item)} `,
		titleColor: statusColor(item, theme),
		titleAlignment: "left",
		paddingLeft: 1,
		paddingRight: 1,
	});
	const body = new TextRenderable(renderer, { content: previewText(item), fg: theme.muted });
	container.add(body);

	return {
		container,
		update(next: TaskItem): void {
			container.title = ` ${label(next)} `;
			container.titleColor = statusColor(next, theme);
			body.content = previewText(next);
			body.fg = next.status === "running" ? theme.text : theme.muted;
		},
	};
}

/** The latest line worth showing in the inline preview. */
function previewText(item: TaskItem): string {
	const thread = item.thread ?? [];
	const lastText = [...thread].reverse().find((t) => t.type === "text");
	if (lastText?.text) return lastText.text;
	const lastTool = [...thread].reverse().find((t) => t.type === "tool");
	if (lastTool) return `[${lastTool.toolName}] ${lastTool.summary ?? ""}`;
	return item.streamingText || item.output || "(subagent starting…)";
}

/** Read-only transcript view shown when the user switches into a subagent. */
export interface SubagentThreadView {
	container: BoxRenderable;
	update: (item: TaskItem) => void;
}

export function createSubagentThreadView(
	renderer: CliRenderer,
	theme: ArborTheme,
	item: TaskItem,
): SubagentThreadView {
	const container = new BoxRenderable(renderer, {
		flexDirection: "column",
		width: "100%",
		paddingLeft: 1,
		paddingRight: 1,
	});
	const back = new TextRenderable(renderer, {
		content: `${icons.prompt}Ctrl+T back to main   ${label(item)}`,
		fg: theme.accent,
	});
	const body = new BoxRenderable(renderer, { flexDirection: "column", width: "100%" });
	container.add(back);
	container.add(body);
	const rows: TextRenderable[] = [];

	function ensure(count: number): void {
		while (rows.length < count) {
			rows.push(new TextRenderable(renderer, { content: "", fg: theme.text }));
			body.add(rows[rows.length - 1] as TextRenderable);
		}
		while (rows.length > count) {
			const r = rows.pop();
			if (r) body.remove(r);
		}
	}

	function renderRow(row: TextRenderable, entry: SubagentThreadItem): void {
		if (entry.type === "text") {
			row.content = entry.text ?? "";
			row.fg = theme.text;
		} else {
			row.content = `[${entry.toolName}] ${entry.summary ?? ""}`;
			row.fg = entry.isError ? theme.error : theme.info;
		}
	}

	const result: SubagentThreadView = {
		container,
		update(next: TaskItem): void {
			back.content = `${icons.prompt}Ctrl+T back to main   ${label(next)}`;
			const thread = next.thread ?? [];
			ensure(thread.length);
			for (let i = 0; i < thread.length; i++) {
				const row = rows[i];
				const entry = thread[i];
				if (row && entry) renderRow(row, entry);
			}
		},
	};
	result.update(item);
	return result;
}
