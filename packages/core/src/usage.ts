/**
 * Usage and cost accumulation across a session.
 *
 * pi-ai reports per-response Usage on every assistant message; this module
 * aggregates those into session totals for footers, /cost commands, and
 * budget tracking. Totals can be recomputed from persisted messages on
 * resume — no separate persistence needed.
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "./types.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	/** Number of assistant responses aggregated. */
	responses: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		responses: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.totalTokens += usage.totalTokens;
	totals.responses += 1;
	totals.cost.input += usage.cost.input;
	totals.cost.output += usage.cost.output;
	totals.cost.cacheRead += usage.cost.cacheRead;
	totals.cost.cacheWrite += usage.cost.cacheWrite;
	totals.cost.total += usage.cost.total;
}

function messageUsage(message: AgentMessage): Usage | undefined {
	const candidate = message as { role?: string; usage?: Usage };
	if (candidate.role !== "assistant") return undefined;
	return candidate.usage;
}

/** Recompute totals from a message list (session resume). */
export function computeUsageTotals(messages: AgentMessage[]): UsageTotals {
	const totals = createUsageTotals();
	for (const message of messages) {
		const usage = messageUsage(message);
		if (usage) addUsage(totals, usage);
	}
	return totals;
}
