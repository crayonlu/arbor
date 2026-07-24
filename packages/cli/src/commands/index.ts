/** Slash command public surface (shared by TUI, RPC, and print). */

export { BUILTIN_COMMANDS, builtinCommandInfos, createRuntime, formatHelp } from "./builtin.ts";
export { createSlashRuntime, executeSlashCommand, executeSlashCommandTui } from "./dispatch.ts";
export { findBuiltin, listCommands } from "./registry.ts";
export {
	CATEGORY_LABELS,
	CATEGORY_ORDER,
	type CommandInfo,
	type ParsedSlashCommand,
	parseSlashCommand,
	type SlashCategory,
	type SlashCommandOutcome,
	type SlashCommandResult,
	type SlashCommandRuntime,
	type SlashCommandSpec,
	type TuiHook,
	type TuiSlashCommandRuntime,
} from "./types.ts";
