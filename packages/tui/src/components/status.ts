/**
 * Status bar: model · mode · view · running/idle · tokens · cost · queued.
 */

import type { UsageTotals } from "@arbor-space/core";
import { type CliRenderer, TextRenderable } from "@opentui/core";
import { icons } from "../icons.ts";
import type { ArborTheme } from "../theme.ts";

export interface StatusModel {
	modelId: string;
	mode: string;
	view: string;
	running: boolean;
	usage: UsageTotals | null;
	queued: boolean;
	jobsActive: number;
}

export interface StatusBar {
	node: TextRenderable;
	update: (s: StatusModel) => void;
}

export function createStatusBar(renderer: CliRenderer, theme: ArborTheme): StatusBar {
	const node = new TextRenderable(renderer, { content: "idle", fg: theme.dim });

	function update(s: StatusModel): void {
		const tok = s.usage ? `${Math.round(s.usage.totalTokens / 1000)}k` : "";
		const cost = s.usage?.cost.total ? `  $${s.usage.cost.total.toFixed(2)}` : "";
		const jobs = s.jobsActive > 0 ? `  ${icons.load}${s.jobsActive} job${s.jobsActive > 1 ? "s" : ""}` : "";
		const q = s.queued ? "  · 1 queued" : "";
		const view = s.view !== "main" ? `  ${s.view}` : "";
		const state = s.running ? `${icons.load} running` : "idle";
		node.content = `${s.modelId}  ${s.mode}${view}  ${state}${tok ? `  ${tok}` : ""}${cost}${jobs}${q}`;
		node.fg = s.running ? theme.warn : theme.dim;
	}

	return { node, update };
}
