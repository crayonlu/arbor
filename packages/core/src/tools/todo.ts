/**
 * todo tool: a session-scoped task list the model maintains.
 *
 * The full list is replaced on each call (simplest protocol for models);
 * every write persists a `custom` session entry so the list survives
 * resume/rewind and is visible to UIs via details.
 */
import { type Static, Type } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";

export const TODO_CUSTOM_TYPE = "arbor:todos";

const todoItemSchema = Type.Object({
	text: Type.String({ description: "The task description" }),
	status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
		description: "Task status",
	}),
});

const parameters = Type.Object({
	todos: Type.Array(todoItemSchema, {
		description: "The complete updated todo list (replaces the previous list)",
	}),
});

export type TodoItem = Static<typeof todoItemSchema>;
export type TodoToolInput = Static<typeof parameters>;

export interface TodoToolDetails {
	todos: TodoItem[];
}

export interface TodoStore {
	get(): TodoItem[];
	set(todos: TodoItem[]): void;
}

/** In-memory store; the harness persists via session custom entries. */
export function createTodoStore(onChange?: (todos: TodoItem[]) => void): TodoStore {
	let items: TodoItem[] = [];
	return {
		get: () => [...items],
		set: (todos) => {
			items = [...todos];
			onChange?.(items);
		},
	};
}

function renderTodos(todos: TodoItem[]): string {
	if (todos.length === 0) return "(todo list is empty)";
	const marker = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
	return todos.map((t) => `${marker[t.status]} ${t.text}`).join("\n");
}

export function createTodoTool(store: TodoStore): AgentTool<typeof parameters, TodoToolDetails> {
	return {
		name: "todo",
		label: "Todo",
		description:
			"Maintain the session todo list. Pass the complete updated list each time; it replaces the previous one. " +
			"Use it to plan multi-step work and mark progress (pending / in_progress / completed). " +
			"Keep at most one task in_progress at a time.",
		parameters,
		async execute(_id, params): Promise<AgentToolResult<TodoToolDetails>> {
			store.set(params.todos);
			return {
				content: [{ type: "text", text: renderTodos(params.todos) }],
				details: { todos: params.todos },
			};
		},
	};
}
