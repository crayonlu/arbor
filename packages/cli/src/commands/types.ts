/**
 * Slash command model — two-level categorized, with a dual handler so the same
 * command works in the TUI, RPC, and print modes.
 *
 * - `handle`   : UI-agnostic (rpc/print/tui). Runs the pure action.
 * - `handleTui`: interactive-only override (selectors, palettes). Falls back to
 *                `handle` when absent. Added in M6.5.
 *
 * A handler returns `undefined`/`{consumed:true}` (handled, no further input)
 * or `{prompt}` (pass the text through as a new user message, e.g. `/force …`).
 */

export type SlashCategory =
	| "session"
	| "model"
	| "context"
	| "mode"
	| "tools"
	| "display"
	| "help"
	| "skill"
	| "extension";

export interface ParsedSlashCommand {
	/** First token: the category (session/model/context/mode/tools/display/help). */
	category: string;
	/** Second token: the command name within the category. */
	name: string;
	/** Remaining text after category + name. */
	args: string;
	/** Raw text after the leading `/`. */
	text: string;
}

/** What a `handle`/`handleTui` may return. */
export type SlashCommandResult = undefined | { consumed: true } | { prompt: string };

/** What `executeSlashCommand` resolves to for a caller (rpc/tui/print). */
export type SlashCommandOutcome =
	| { kind: "consumed" }
	| { kind: "prompt"; text: string }
	| { kind: "tui_only"; name: string }
	| { kind: "unknown"; name: string };

export interface TuiHook {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warn" | "error"): void;
}

/** Actions the TUI exposes to interactive command handlers. */
export interface TuiActions {
	/** Swap the running session: new / resume a stored one / fork the current. */
	restart: (mode: "new" | "resume" | "fork", target?: string) => void;
	/** Replace the input box text (does not send). */
	setInput: (text: string) => void;
}

export interface SlashCommandRuntime {
	cwd: string;
	session: import("@arbor-space/core").AgentSession;
	sessionManager: import("@arbor-space/core").SessionManager;
	output: (text: string) => void | Promise<void>;
	refreshCommands?: () => void | Promise<void>;
	/** Resolve a `provider/id` to a model (for `/model set`). */
	resolveModel?: (provider: string, modelId: string) => import("@earendil-works/pi-ai").Model<any> | null;
	/** List known models as `provider/id` (for `/model cycle`). */
	listModels?: () => string[];
}

/** Interactive context for `handleTui` (populated by the TUI). */
export interface TuiSlashCommandRuntime {
	runtime: SlashCommandRuntime;
	/** Interactive UI hook (selectors, prompts) wired by the TUI. */
	tui: TuiHook;
	/** TUI actions (session swap, input prefill) wired by the TUI. */
	actions: TuiActions;
}

export interface SlashCommandSpec {
	category: SlashCategory;
	name: string;
	aliases?: string[];
	description: string;
	argumentHint?: string;
	allowArgs?: boolean;
	handle?: (
		cmd: ParsedSlashCommand,
		runtime: SlashCommandRuntime,
	) => SlashCommandResult | Promise<SlashCommandResult>;
	handleTui?: (
		cmd: ParsedSlashCommand,
		runtime: TuiSlashCommandRuntime,
	) => SlashCommandResult | Promise<SlashCommandResult>;
}

export interface CommandInfo {
	category: SlashCategory;
	name: string;
	aliases?: string[];
	description: string;
	argumentHint?: string;
}

export const CATEGORY_ORDER: readonly SlashCategory[] = [
	"session",
	"model",
	"context",
	"mode",
	"tools",
	"display",
	"skill",
	"help",
	"extension",
];

export const CATEGORY_LABELS: Record<SlashCategory, string> = {
	session: "Session",
	model: "Model",
	context: "Context",
	mode: "Mode",
	tools: "Tools",
	display: "Display",
	skill: "Skill",
	help: "Help",
	extension: "Extension",
};

/**
 * Strip the leading `/` and split into category + name + args.
 *
 * Invocation is two-level: `/<category> <name> [args]` (e.g. `/mode plan`,
 * `/session rewind <id>`). A bare `/<category>` falls back to the command whose
 * name equals the category (so `/help` runs `help help`).
 */
export function parseSlashCommand(text: string): ParsedSlashCommand {
	const stripped = text.startsWith("/") ? text.slice(1) : text;
	const trimmed = stripped.trim();
	const tokens = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
	const category = tokens[0] ?? "";
	const name = tokens[1] ?? "";
	const args = tokens.slice(2).join(" ");
	return { category, name, args, text: trimmed };
}
