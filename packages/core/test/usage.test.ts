/** Usage/cost accumulation tests. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../src/types.ts";
import { addUsage, computeUsageTotals, createUsageTotals } from "../src/usage.ts";

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 100,
		output: 50,
		cacheRead: 10,
		cacheWrite: 5,
		totalTokens: 165,
		cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
		...overrides,
	};
}

describe("usage totals", () => {
	it("starts at zero", () => {
		const totals = createUsageTotals();
		assert.equal(totals.totalTokens, 0);
		assert.equal(totals.cost.total, 0);
		assert.equal(totals.responses, 0);
	});

	it("accumulates tokens, cost, and response count", () => {
		const totals = createUsageTotals();
		addUsage(totals, usage());
		addUsage(totals, usage({ input: 200, totalTokens: 265 }));
		assert.equal(totals.input, 300);
		assert.equal(totals.output, 100);
		assert.equal(totals.cacheRead, 20);
		assert.equal(totals.cacheWrite, 10);
		assert.equal(totals.totalTokens, 430);
		assert.equal(totals.responses, 2);
		assert.ok(Math.abs(totals.cost.total - 0.0066) < 1e-9);
	});

	it("computeUsageTotals aggregates assistant messages only", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "hi", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
				usage: usage(),
			} as never,
			{
				role: "assistant",
				content: [{ type: "text", text: "again" }],
				usage: usage(),
			} as never,
			// Assistant without usage (e.g. custom message) is skipped.
			{ role: "assistant", content: [{ type: "text", text: "x" }] } as never,
		];
		const totals = computeUsageTotals(messages);
		assert.equal(totals.responses, 2);
		assert.equal(totals.totalTokens, 330);
	});

	it("computeUsageTotals of empty list is zero", () => {
		assert.equal(computeUsageTotals([]).totalTokens, 0);
	});
});
