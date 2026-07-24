import type { AgentSession } from "@arbor-space/core";
import type { TodoItem } from "@arbor-space/core/tools";
import {
	BoxRenderable,
	type CliRenderer,
	type ColorInput,
	createCliRenderer,
	DiffRenderable,
	extToFiletype,
	getTreeSitterClient,
	InputRenderable,
	InputRenderableEvents,
	MarkdownRenderable,
	type MarkdownRenderable as MarkdownRenderableType,
	type Renderable,
	ScrollBoxRenderable,
	type SyntaxStyle,
	TextRenderable,
	type TreeSitterClient,
} from "@opentui/core";
import {
	type CommandPalette,
	createCommandPalette,
	type TuiCommandInfo,
} from "./components/command-palette.ts";
import { createStatusBar } from "./components/status.ts";
import {
	createSubagentBlock,
	createSubagentThreadView,
	type SubagentThreadView,
} from "./components/subagent.ts";
import { createThinkingTail, type ThinkingTail } from "./components/thinking.ts";
import { createTodoPanel } from "./components/todo-panel.ts";
import { createToolBlock, type ToolBlock, updateToolHeader } from "./components/tool-block.ts";
import { type Item, SessionModel } from "./event-bridge.ts";
import { icons } from "./icons.ts";
import { type ArborTheme, buildSyntaxStyle, darkTheme } from "./theme.ts";
import type { TuiExtensionUi } from "./ui-context.ts";

export interface TuiCommandHook {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warn" | "error"): void;
}

/** Actions the TUI exposes to interactive command handlers. */
export interface TuiActions {
	restart: (mode: "new" | "resume" | "fork", target?: string) => void;
	setInput: (text: string) => void;
}

/** Why the TUI session ended — `restart` lets the caller swap sessions. */
export type TuiExit =
	| { kind: "quit" }
	| { kind: "restart"; mode: "new" | "resume" | "fork"; target?: string };

export interface TuiOptions {
	theme?: ArborTheme;
	treeSitterClient?: TreeSitterClient;
	/** Called when the user quits or requests a session swap. */
	onExit?: (exit: TuiExit) => void;
	/** Categorized slash commands for the `/` palette. */
	commands?: TuiCommandInfo[];
	/** Run a `/<category> <name> [args]` string; returns a status message. */
	runCommand?: (text: string, hook: TuiCommandHook, actions: TuiActions) => Promise<string | undefined>;
	/** Interactive UI bridge (mounted onto the renderer). */
	extensionUi?: TuiExtensionUi;
}

export interface TuiApp {
	destroy: () => void;
}

interface LineSpec {
	text: string;
	fg: ColorInput;
	bg?: ColorInput;
}

function lineFor(item: Item, theme: ArborTheme): LineSpec {
	switch (item.kind) {
		case "user":
			return { text: `${icons.prompt} ${item.text}`, fg: theme.text, bg: theme.bgUser };
		case "assistant":
			return { text: item.text, fg: theme.text };
		case "thinking":
			return { text: item.text, fg: theme.dim };
		case "sys":
			return { text: item.text, fg: theme.dim };
		case "job":
			return { text: item.text, fg: theme.info };
		case "tool":
			return { text: `${item.toolName}  ${item.args}`, fg: theme.text };
	}
}

type TaskItem = Extract<Item, { kind: "tool" }>;

/** Tool blocks that clamp verbose output (bash). */
function isClampable(item: Extract<Item, { kind: "tool" }>): boolean {
	return item.toolName === "bash";
}

export function createTuiApp(renderer: CliRenderer, session: AgentSession, opts: TuiOptions = {}): TuiApp {
	const theme = opts.theme ?? darkTheme;
	const model = new SessionModel();
	const syntaxStyle: SyntaxStyle = buildSyntaxStyle(theme);
	const treeSitter = opts.treeSitterClient;
	const extensionUi = opts.extensionUi ?? null;
	if (extensionUi) extensionUi.mount(renderer, theme);

	const column = new BoxRenderable(renderer, {
		flexDirection: "column",
		flexGrow: 1,
		width: "100%",
		height: "100%",
	});
	renderer.root.add(column);

	const scroll = new ScrollBoxRenderable(renderer, {
		flexGrow: 1,
		stickyScroll: true,
		stickyStart: "bottom",
		paddingLeft: 1,
		paddingRight: 1,
	});
	const todo = createTodoPanel(renderer, theme);
	const input = new InputRenderable(renderer, {
		placeholder: "Message arbor…",
		textColor: theme.text,
		placeholderColor: theme.dim,
	});
	const queuedLine = new TextRenderable(renderer, { content: "", fg: theme.warn });
	const status = createStatusBar(renderer, theme);
	column.add(scroll);
	column.add(todo.container);
	column.add(input);
	column.add(queuedLine);
	column.add(status.node);

	// -- interaction state -------------------------------------------------
	let queued: string | null = null;
	let justSent: { text: string; entryId: string | null } | null = null;
	let pendingRewind: { text: string; entryId: string | null } | null = null;
	let palette: CommandPalette | null = null;
	let diffView: "auto" | "split" | "unified" = "auto";
	let expandAll = false;

	// Actions exposed to interactive slash commands (session swap, input prefill).
	const actions: TuiActions = {
		restart: (mode, target) => {
			session.abort();
			opts.onExit?.({ kind: "restart", mode, ...(target ? { target } : {}) });
		},
		setInput: (text) => {
			input.value = text;
			input.focusable = true;
			input.focus();
			render();
		},
	};

	function submit(): void {
		const text = input.value;
		if (!text.trim()) {
			if (model.get().running) session.abort();
			return;
		}
		input.value = "";
		if (text.startsWith("/")) {
			void dispatchSlash(text).catch(() => {});
			return;
		}
		if (model.get().running) {
			queued = text;
			void session.prompt(text);
		} else {
			justSent = { text, entryId: null };
			void session.prompt(text);
		}
		render();
	}
	input.onSubmit = () => submit();

	// -- main-view renderables --------------------------------------------
	const nodes = new Map<string, Renderable>();
	const toolBlocks = new Map<string, ToolBlock>();
	const subagentBlocks = new Map<string, ReturnType<typeof createSubagentBlock>>();
	const thinkingTails = new Map<string, ThinkingTail>();
	let subagentView: { view: SubagentThreadView; id: string } | null = null;
	let lastView: string = "main";

	function createDiffNode(item: Extract<Item, { kind: "tool" }>): DiffRenderable {
		const ext = item.filePath?.split(".").pop() ?? "";
		const filetype = ext ? (extToFiletype(ext) ?? ext) : undefined;
		const width = renderer.width;
		const split = diffView === "split" || (diffView === "auto" && width >= 100);
		const compact = width < 60; // phone/SSH: drop line numbers, force unified
		return new DiffRenderable(renderer, {
			diff: item.diff ?? "",
			view: split ? "split" : "unified",
			syncScroll: split,
			syntaxStyle,
			fg: theme.text,
			...(filetype ? { filetype } : {}),
			showLineNumbers: !compact,
			lineNumberFg: theme.dim,
			addedLineNumberBg: theme.addBg,
			removedLineNumberBg: theme.delBg,
			contextBg: theme.codeBg,
			addedBg: theme.addBg,
			removedBg: theme.delBg,
			addedSignColor: theme.addFg,
			removedSignColor: theme.delFg,
			conceal: true,
			...(treeSitter ? { treeSitterClient: treeSitter } : {}),
		});
	}

	/** Mount the diff inside a thin bordered box (design: diffs keep a border). */
	function mountDiff(tb: ToolBlock, item: Extract<Item, { kind: "tool" }>): void {
		if (tb.outputNode) {
			tb.body.remove(tb.outputNode);
			tb.outputNode = null;
		}
		if (tb.diffBox) {
			tb.body.remove(tb.diffBox);
			tb.diffBox = null;
		}
		const diff = createDiffNode(item);
		const box = new BoxRenderable(renderer, {
			flexDirection: "column",
			width: "100%",
			border: true,
			borderColor: theme.borderDim,
			borderStyle: "single",
		});
		box.add(diff);
		tb.body.add(box);
		tb.diffNode = diff;
		tb.diffBox = box;
	}

	/** Rebuild every mounted diff (used when the view style changes). */
	function rebuildDiffs(): void {
		const items = model.get().items;
		for (const [id, tb] of toolBlocks) {
			const item = items.find((i) => i.id === id);
			if (item && item.kind === "tool" && item.diff) mountDiff(tb, item);
		}
		render();
	}

	function createNode(item: Item): Renderable {
		if (item.kind === "assistant") {
			return new MarkdownRenderable(renderer, {
				content: "",
				syntaxStyle,
				fg: theme.text,
				streaming: true,
				...(treeSitter ? { treeSitterClient: treeSitter } : {}),
			});
		}
		if (item.kind === "tool") {
			if (item.toolName === "task") {
				const block = createSubagentBlock(renderer, theme, item);
				subagentBlocks.set(item.id, block);
				return block.container;
			}
			const block = createToolBlock(renderer, theme, item);
			toolBlocks.set(item.id, block);
			if (item.diff) {
				mountDiff(block, item);
			} else {
				const out = new TextRenderable(renderer, { content: clampOutput(item), fg: theme.muted });
				block.body.add(out);
				block.outputNode = out;
			}
			return block.container;
		}
		const line = lineFor(item, theme);
		return new TextRenderable(renderer, {
			content: line.text,
			fg: line.fg,
			...(line.bg ? { bg: line.bg } : {}),
		});
	}

	function clampOutput(item: Extract<Item, { kind: "tool" }>): string {
		if (!isClampable(item) || expandAll) return item.output;
		const lines = item.output.split("\n");
		const MAX = 8;
		if (lines.length <= MAX) return item.output;
		return `… (+${lines.length - MAX} lines, Ctrl+O expand)\n${lines.slice(lines.length - MAX).join("\n")}`;
	}

	function updateNode(node: Renderable, item: Item): void {
		if (item.kind === "assistant") {
			const md = node as MarkdownRenderableType;
			md.content = item.text;
			if (!item.streaming && treeSitter) md.streaming = false;
			// Thinking tail for this assistant turn.
			if (item.thinking) {
				let tail = thinkingTails.get(item.id);
				if (!tail) {
					tail = createThinkingTail(renderer, theme, { width: renderer.width - 2 });
					thinkingTails.set(item.id, tail);
					scroll.content.insertBefore(tail.container, node);
				}
				tail.update(item.thinking, item.streaming);
			}
			return;
		}
		if (item.kind === "tool") {
			if (item.toolName === "task") {
				const block = subagentBlocks.get(item.id);
				block?.update(item);
				return;
			}
			const tb = toolBlocks.get(item.id);
			if (!tb) return;
			updateToolHeader(tb, item);
			if (item.diff) {
				if (!tb.diffNode) mountDiff(tb, item);
				else tb.diffNode.diff = item.diff;
			} else if (tb.outputNode) {
				tb.outputNode.content = clampOutput(item);
			}
			return;
		}
		(node as TextRenderable).content = lineFor(item, theme).text;
	}

	function clearMainNodes(): void {
		for (const node of nodes.values()) scroll.content.remove(node);
		for (const tail of thinkingTails.values()) scroll.content.remove(tail.container);
		nodes.clear();
		toolBlocks.clear();
		subagentBlocks.clear();
		thinkingTails.clear();
	}

	function renderMain(items: Item[]): void {
		const seen = new Set<string>();
		for (const item of items) {
			if (item.kind === "assistant" && !item.text) {
				// Still render the thinking tail even before text arrives.
				if (!item.thinking) continue;
			}
			seen.add(item.id);
			const existing = nodes.get(item.id);
			if (existing) {
				updateNode(existing, item);
			} else {
				const node = createNode(item);
				nodes.set(item.id, node);
				scroll.content.add(node);
				updateNode(node, item);
			}
		}
		for (const [id, node] of nodes) {
			if (!seen.has(id)) {
				scroll.content.remove(node);
				nodes.delete(id);
				toolBlocks.delete(id);
				subagentBlocks.delete(id);
				const tail = thinkingTails.get(id);
				if (tail) {
					scroll.content.remove(tail.container);
					thinkingTails.delete(id);
				}
			}
		}
	}

	function renderSubagent(item: TaskItem): void {
		if (!subagentView || subagentView.id !== item.id) {
			if (subagentView) scroll.content.remove(subagentView.view.container);
			const view = createSubagentThreadView(renderer, theme, item);
			scroll.content.add(view.container);
			subagentView = { view, id: item.id };
		}
		subagentView.view.update(item);
	}

	function render(): void {
		extensionUi?.sync();
		const state = model.get();
		const viewKey = state.view === "main" ? "main" : `sub:${(state.view as { subagent: string }).subagent}`;
		if (viewKey !== lastView) {
			clearMainNodes();
			if (subagentView) {
				scroll.content.remove(subagentView.view.container);
				subagentView = null;
			}
			lastView = viewKey;
		}

		if (state.view === "main") {
			renderMain(state.items);
		} else {
			const target = state.items.find(
				(i): i is TaskItem => i.kind === "tool" && i.id === (state.view as { subagent: string }).subagent,
			);
			if (target) renderSubagent(target);
		}

		// Subagent views are read-only: hide the input/queue/todo while inside one.
		const inSubagent = state.view !== "main";
		input.visible = !inSubagent;
		queuedLine.visible = !inSubagent;
		todo.container.visible = !inSubagent;

		// Resolve a pending rewind / queued chip once the run settles.
		if (!state.running) {
			if (pendingRewind) {
				const rewindText = pendingRewind.text;
				const rewindId = pendingRewind.entryId;
				pendingRewind = null;
				if (rewindId) void session.rewind(rewindId).catch(() => {});
				input.value = rewindText;
			}
			if (queued) queued = null;
		}

		// Todos: pinned, live from the session store.
		todo.update(readTodos());

		queuedLine.content = queued ? `${icons.prompt} queued: ${queued}  Esc withdraw` : "";
		const modelId = (session.model as { id?: string } | undefined)?.id ?? "arbor";
		const viewLabel =
			state.view === "main"
				? "main"
				: `agent:${subagentLabel((state.view as { subagent: string }).subagent)}`;
		status.update({
			modelId,
			mode: session.mode,
			view: viewLabel,
			running: state.running,
			usage: state.usage,
			queued: queued !== null,
			jobsActive: session.jobs ? countActiveJobs(session.jobs) : 0,
		});
		renderer.requestRender();
	}

	function subagentLabel(id: string): string {
		const item = model.get().items.find((i) => i.id === id);
		if (item && item.kind === "tool") return item.agent ?? "task";
		return "task";
	}

	function readTodos(): TodoItem[] {
		try {
			return session.todos.get();
		} catch {
			return [];
		}
	}

	async function dispatchSlash(text: string): Promise<void> {
		const trimmed = text.trim();
		// `/skill:<name> [args]` expands to the skill body and sends as a prompt.
		// Unlike pi, selection only fills the input — the user reviews/edits and
		// sends deliberately (no auto-send).
		if (trimmed.startsWith("/skill:")) {
			const expanded = await expandSkillInvocation(trimmed, session);
			if (expanded !== null) {
				input.value = "";
				if (model.get().running) queued = expanded;
				void session.prompt(expanded);
				render();
				return;
			}
		}
		// Display toggles are TUI-local concerns.
		if (trimmed === "/display diff") {
			// Cycle auto → split → unified → auto.
			diffView = diffView === "auto" ? "split" : diffView === "split" ? "unified" : "auto";
			rebuildDiffs();
			return;
		}
		if (trimmed === "/display diff split") {
			diffView = "split";
			rebuildDiffs();
			return;
		}
		if (trimmed === "/display diff unified") {
			diffView = "unified";
			rebuildDiffs();
			return;
		}
		if (trimmed === "/display expand") {
			expandAll = !expandAll;
			render();
			return;
		}
		if (trimmed === "/help quit" || trimmed === "/quit") {
			session.abort();
			opts.onExit?.({ kind: "quit" });
			return;
		}
		if (opts.runCommand) {
			const hook: TuiCommandHook = extensionUi ?? fallbackHook;
			const msg = await opts.runCommand(trimmed, hook, actions);
			if (msg) {
				model.handle({
					type: "job_notification",
					text: msg,
				} as never);
			}
			render();
		}
	}

	const unsubModel = model.subscribe(render);
	const unsubSession = session.subscribe((e) => {
		model.handle(e);
		if (e.type === "message_start") {
			const role = (e.message as { role?: string }).role;
			if (role === "user" && justSent && justSent.entryId === null) {
				justSent.entryId = session.session.leaf;
			} else if (role === "assistant") {
				justSent = null;
			}
		}
	});

	// `/` opens the palette (when commands are available).
	if (opts.commands && opts.commands.length > 0) {
		input.on(InputRenderableEvents.CHANGE, () => {
			if (palette) return;
			if (input.value === "/") {
				input.value = "";
				openPalette();
			}
		});
	}

	function openPalette(): void {
		if (palette || !opts.commands) return;
		input.focusable = false;
		palette = createCommandPalette(renderer, theme, opts.commands, {
			width: renderer.width - 2,
			maxHeight: Math.min(12, opts.commands.length),
		});
		palette.setQuery("");
		column.add(palette.container);
		render();
	}

	function closePalette(): void {
		if (!palette) return;
		column.remove(palette.container);
		palette = null;
		input.focusable = true;
		input.focus();
		render();
	}

	function cycleView(): void {
		const threads = model.subagentThreads();
		const current = model.get().view;
		if (current === "main") {
			const first = threads[0];
			if (first) model.setView({ subagent: first.id });
			return;
		}
		const curId = (current as { subagent: string }).subagent;
		const idx = threads.findIndex((t) => t.id === curId);
		if (idx === -1 || idx === threads.length - 1) model.setView("main");
		else {
			const next = threads[idx + 1];
			if (next) model.setView({ subagent: next.id });
		}
	}

	function toggleExpand(): void {
		expandAll = !expandAll;
		render();
	}

	const onKey = (key: { name: string; ctrl: boolean; shift: boolean; sequence?: string }): void => {
		// Modal prompts take precedence.
		if (extensionUi?.active()) {
			extensionUi.handleKey(key);
			render();
			return;
		}
		// Palette owns input while open.
		if (palette) {
			handlePaletteKey(key);
			return;
		}
		if (key.ctrl && key.name === "c") {
			session.abort();
			opts.onExit?.({ kind: "quit" });
			return;
		}
		if (key.ctrl && key.name === "t") {
			cycleView();
			return;
		}
		if (key.ctrl && key.name === "o") {
			toggleExpand();
			return;
		}
		if (key.name === "escape") {
			if (queued) {
				session.clearSteering();
				queued = null;
				render();
				return;
			}
			if (justSent && model.get().running) {
				pendingRewind = justSent;
				justSent = null;
				session.abort();
				return;
			}
			input.value = "";
		}
	};

	function handlePaletteKey(key: { name: string; sequence?: string }): void {
		if (!palette) return;
		if (key.name === "escape") {
			closePalette();
			return;
		}
		if (key.name === "return") {
			const text = palette.selectedText();
			closePalette();
			if (text) void dispatchSlash(text).catch(() => {});
			return;
		}
		if (key.name === "up") {
			palette.move(-1);
			render();
			return;
		}
		if (key.name === "down") {
			palette.move(1);
			render();
			return;
		}
		if (key.name === "backspace") {
			const q = palette.query().slice(0, -1);
			palette.setQuery(q);
			render();
			return;
		}
		// Printable char: extend the query.
		const ch = key.sequence;
		if (ch && ch.length === 1 && ch >= " " && ch !== "/") {
			palette.setQuery(palette.query() + ch);
			render();
		}
	}

	renderer.keyInput.on("keypress", onKey);
	render();

	return {
		destroy: () => {
			renderer.keyInput.off("keypress", onKey);
			unsubSession();
			unsubModel();
		},
	};
}

const fallbackHook: TuiCommandHook = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
};

function countActiveJobs(jobs: { list?: () => unknown[]; active?: unknown[] }): number {
	const anyJobs = jobs as { active?: unknown[]; list?: () => unknown[] };
	if (Array.isArray(anyJobs.active)) return anyJobs.active.length;
	try {
		const list = anyJobs.list?.();
		return Array.isArray(list) ? list.length : 0;
	} catch {
		return 0;
	}
}

export async function runTui(session: AgentSession, opts: TuiOptions = {}): Promise<TuiExit> {
	const renderer = await createCliRenderer({
		exitOnCtrlC: false,
		useMouse: false,
		backgroundColor: darkTheme.bg,
	});
	let treeSitter: TreeSitterClient | undefined;
	try {
		treeSitter = getTreeSitterClient();
		await treeSitter.initialize();
	} catch {
		treeSitter = undefined;
	}
	return new Promise<TuiExit>((resolve) => {
		const app = createTuiApp(renderer, session, {
			...opts,
			...(treeSitter ? { treeSitterClient: treeSitter } : {}),
			onExit: (exit) => {
				app.destroy();
				renderer.destroy();
				resolve(exit);
			},
		});
	});
}

/**
 * Expand `/skill:<name> [args]` to the skill body (via loadSkillBody). Returns
 * null when the skill is unknown so the caller can treat it as a normal command.
 */
export async function expandSkillInvocation(text: string, session: AgentSession): Promise<string | null> {
	const stripped = text.startsWith("/") ? text.slice(1) : text;
	const space = stripped.indexOf(" ");
	const token = space === -1 ? stripped : stripped.slice(0, space);
	const args = space === -1 ? "" : stripped.slice(space + 1).trim();
	if (!token.startsWith("skill:")) return null;
	const name = token.slice("skill:".length);
	const skill = session.skills.find((s) => s.name === name);
	if (!skill) return null;
	const { loadSkillBody } = await import("@arbor-space/core");
	return loadSkillBody(skill, args);
}
