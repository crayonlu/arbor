/**
 * Todo panel: the session's live todo list, pinned between the scrollback and
 * the input so it stays visible while the agent works. Reads from the
 * AgentSession's TodoStore on every update.
 */

import type { TodoItem } from "@arbor-space/core/tools";
import { BoxRenderable, type CliRenderer, type ColorInput, TextRenderable } from "@opentui/core";
import { icons } from "../icons.ts";
import type { ArborTheme } from "../theme.ts";

export interface TodoPanel {
	container: BoxRenderable;
	update: (todos: TodoItem[]) => void;
}

const marker: Record<TodoItem["status"], string> = {
	pending: "○",
	in_progress: "●",
	completed: "✓",
};

function colorFor(status: TodoItem["status"], theme: ArborTheme): ColorInput {
	return status === "completed" ? theme.success : status === "in_progress" ? theme.accent : theme.dim;
}

export function createTodoPanel(renderer: CliRenderer, theme: ArborTheme): TodoPanel {
	const container = new BoxRenderable(renderer, {
		flexDirection: "column",
		width: "100%",
		paddingLeft: 1,
		paddingRight: 1,
	});
	const header = new TextRenderable(renderer, { content: "", fg: theme.muted });
	const body = new BoxRenderable(renderer, { flexDirection: "column", width: "100%" });
	container.add(header);
	container.add(body);
	const rows: TextRenderable[] = [];

	function ensureRows(count: number): void {
		while (rows.length < count) {
			const row = new TextRenderable(renderer, { content: "", fg: theme.text });
			body.add(row);
			rows.push(row);
		}
		while (rows.length > count) {
			const row = rows.pop();
			if (row) body.remove(row);
		}
	}

	return {
		container,
		update(todos: TodoItem[]): void {
			if (todos.length === 0) {
				header.content = "";
				ensureRows(0);
				return;
			}
			const done = todos.filter((t) => t.status === "completed").length;
			header.content = `${icons.bullet} todos  ${done}/${todos.length}`;
			ensureRows(todos.length);
			for (let i = 0; i < todos.length; i++) {
				const t = todos[i] as TodoItem;
				const row = rows[i];
				if (!row) continue;
				row.content = `${marker[t.status]} ${t.text}`;
				row.fg = colorFor(t.status, theme);
			}
		},
	};
}
