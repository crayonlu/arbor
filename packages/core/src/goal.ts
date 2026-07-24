/**
 * Goal: a standing directive injected into the system prompt and re-asserted
 * between turns so long tasks do not drift.
 */
import type { AgentMessage } from "./types.ts";

export interface GoalState {
	get(): string | null;
	set(goal: string | null): void;
}

export function createGoalState(onChange?: (goal: string | null) => void): GoalState {
	let current: string | null = null;
	return {
		get: () => current,
		set: (goal) => {
			current = goal;
			onChange?.(goal);
		},
	};
}

/** System prompt section for the active goal ("" when unset). */
export function goalPromptSection(goal: string | null): string {
	if (!goal) return "";
	return `# Active goal

The user has set a standing goal for this session:

${goal}

Keep working toward this goal. When you believe it is fully met, say so explicitly and explain how each part is satisfied.`;
}

/**
 * Reminder message injected as a follow-up when a run ends while a goal is
 * active and the caller judges the goal unmet.
 */
export function goalReminderMessage(goal: string): AgentMessage {
	return {
		role: "user",
		content: `[goal reminder] The session goal is not yet met:\n\n${goal}\n\nContinue working toward it, or explain concretely why it is already satisfied or cannot be satisfied.`,
		timestamp: Date.now(),
	};
}
