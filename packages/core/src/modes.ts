/**
 * Modes: which tools the model sees.
 *
 * Plan mode is not a tool — it is a filter over the tool list plus a system
 * prompt section. In plan mode only non-mutating tools are exposed, plus the
 * `exit_plan` tool that hands the finished plan back to the harness.
 */
import { type Static, Type } from "typebox";
import type { AgentTool, AgentToolResult } from "./types.ts";

export type AgentMode = "build" | "plan";

/** Tools visible in the given mode. Plan mode drops every mutating tool. */
export function filterToolsForMode(tools: AgentTool<any>[], mode: AgentMode): AgentTool<any>[] {
	if (mode === "build") return tools;
	return tools.filter((tool) => tool.mutates !== true);
}

const exitPlanParameters = Type.Object({
	plan: Type.String({
		description: "The complete implementation plan in markdown, ready for user review",
	}),
});

export type ExitPlanInput = Static<typeof exitPlanParameters>;

export interface ExitPlanDetails {
	plan: string;
}

/**
 * The exit_plan tool: ends plan mode and delivers the plan. Sets `terminate`
 * so the loop stops after this tool batch and the harness can switch modes.
 */
export function createExitPlanTool(
	onPlan: (plan: string) => void | Promise<void>,
): AgentTool<typeof exitPlanParameters, ExitPlanDetails> {
	return {
		name: "exit_plan",
		label: "Exit plan mode",
		description:
			"Call this when your plan is complete. Pass the full plan in markdown. " +
			"This ends plan mode; the user reviews the plan before any implementation starts.",
		parameters: exitPlanParameters,
		async execute(_id, params): Promise<AgentToolResult<ExitPlanDetails>> {
			await onPlan(params.plan);
			return {
				content: [{ type: "text", text: "Plan submitted for review. Plan mode ended." }],
				details: { plan: params.plan },
				terminate: true,
			};
		},
	};
}

export const PLAN_MODE_PROMPT = `You are in PLAN MODE. Your job is to research and design, not to implement.

Rules:
- You only have read-only tools; you cannot edit files or run mutating commands.
- Explore the codebase, understand the task, and design an implementation approach.
- When your plan is ready, call the exit_plan tool with the complete plan in markdown.
- The plan should name concrete files to change, describe the approach, and note verification steps.`;

/** System prompt section for the active mode ("" for build mode). */
export function modePromptSection(mode: AgentMode): string {
	return mode === "plan" ? PLAN_MODE_PROMPT : "";
}
