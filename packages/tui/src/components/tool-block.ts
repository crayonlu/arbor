/**
 * Tool block: a tool call rendered as a header line plus an optional body.
 *
 * - `bash` and other verbose tools clamp their output to a maxHeight; Ctrl+O
 *   (wired by the app) expands/collapses in place. The header signals success
 *   vs failure by background color (pi-style), not an icon.
 * - `edit` results render as a DiffRenderable (handled by the app, which swaps
 *   the body in).
 */
import { BoxRenderable, type CliRenderer, type ColorInput, TextRenderable } from "@opentui/core";
import type { Item } from "../event-bridge.ts";
import type { ArborTheme } from "../theme.ts";

export interface ToolBlock {
	container: BoxRenderable;
	header: TextRenderable;
	body: BoxRenderable;
	/** The clamped output Text node, if any. */
	outputNode: TextRenderable | null;
	/** The diff node, if any. */
	diffNode: import("@opentui/core").DiffRenderable | null;
	/** The bordered box wrapping the diff, if any. */
	diffBox: BoxRenderable | null;
	clamped: boolean;
	expanded: boolean;
}

export function toolStatusText(item: Extract<Item, { kind: "tool" }>): string {
	return item.status === "done" ? "done" : item.status === "error" ? "exit 1" : "running";
}

export function toolBg(item: Extract<Item, { kind: "tool" }>, theme: ArborTheme): ColorInput | undefined {
	if (item.toolName !== "bash") return undefined;
	return item.status === "error" ? theme.delBg : item.status === "running" ? theme.bgRun : theme.addBg;
}

export function createToolBlock(
	renderer: CliRenderer,
	theme: ArborTheme,
	item: Extract<Item, { kind: "tool" }>,
): ToolBlock {
	const container = new BoxRenderable(renderer, { flexDirection: "column", width: "100%" });
	const bg = toolBg(item, theme);
	const header = new TextRenderable(renderer, {
		content: headerText(item),
		fg: theme.text,
		...(bg ? { bg } : {}),
	});
	const body = new BoxRenderable(renderer, { flexDirection: "column", width: "100%" });
	container.add(header);
	container.add(body);
	return {
		container,
		header,
		body,
		outputNode: null,
		diffNode: null,
		diffBox: null,
		clamped: false,
		expanded: false,
	};
}

function headerText(item: Extract<Item, { kind: "tool" }>): string {
	return `${item.toolName}  ${item.args}  ${toolStatusText(item)}`.trim();
}

export function updateToolHeader(block: ToolBlock, item: Extract<Item, { kind: "tool" }>): void {
	block.header.content = headerText(item);
}
