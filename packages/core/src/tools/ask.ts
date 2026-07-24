/**
 * ask tool: let the model pose multiple-choice questions to the user.
 *
 * Useful for clarifying requirements, choosing between approaches, or
 * offering decisions — especially in plan mode (the tool does not mutate,
 * so it stays visible there). Answers flow back as the tool result; an
 * unanswered/dismissed question is reported as text, never as an error.
 */
import { type Static, Type } from "typebox";
import type { AskUiQuestion, ExtensionUi } from "../extensions/types.ts";
import type { AgentTool, AgentToolResult } from "../types.ts";

const optionSchema = Type.Object({
	label: Type.String({ description: "Short label for this choice (1-5 words)" }),
	description: Type.Optional(Type.String({ description: "What choosing this option means" })),
});

const questionSchema = Type.Object({
	question: Type.String({ description: "The complete question to ask. Clear and specific." }),
	options: Type.Array(optionSchema, {
		description: "2-8 distinct choices. The user can always answer with free text instead.",
		minItems: 2,
		maxItems: 8,
	}),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Allow selecting multiple options (default false)" }),
	),
});

const parameters = Type.Object({
	questions: Type.Array(questionSchema, {
		description: "Questions to ask the user (1-4)",
		minItems: 1,
		maxItems: 4,
	}),
});

export type AskToolInput = Static<typeof parameters>;

export interface AskToolDetails {
	/** One entry per question; null when unanswered. */
	answers: (string[] | null)[];
}

async function askOne(ui: ExtensionUi, question: AskUiQuestion): Promise<string[] | undefined> {
	if (ui.ask) {
		return ui.ask(question);
	}
	// Fallback: single-choice select on the option labels.
	const choice = await ui.select(
		question.question,
		question.options.map((o) => o.label),
	);
	return choice === undefined ? undefined : [choice];
}

export function createAskTool(ui: ExtensionUi): AgentTool<typeof parameters, AskToolDetails> {
	return {
		name: "ask",
		label: "Ask",
		description:
			"Ask the user one or more multiple-choice questions and wait for their answers. " +
			"Use when you are blocked on a decision that is genuinely the user's to make: " +
			"clarifying requirements, choosing between approaches, or confirming preferences. " +
			"Do not use it for choices with an obvious conventional default.",
		parameters,
		async execute(_id, params): Promise<AgentToolResult<AskToolDetails>> {
			const answers: (string[] | null)[] = [];
			const lines: string[] = [];
			for (const question of params.questions) {
				const answer = await askOne(ui, {
					question: question.question,
					options: question.options.map((o) => ({
						label: o.label,
						...(o.description !== undefined ? { description: o.description } : {}),
					})),
					...(question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {}),
				});
				answers.push(answer ?? null);
				lines.push(`"${question.question}" → ${answer?.length ? answer.join(", ") : "(unanswered)"}`);
			}
			const answeredCount = answers.filter((a) => a !== null).length;
			const text =
				answeredCount === 0
					? "The user did not answer. Proceed with your best judgment or continue without this input."
					: `User answers:\n${lines.join("\n")}`;
			return { content: [{ type: "text", text }], details: { answers } };
		},
	};
}
