/**
 * @arbor-space/tui — OpenTUI-based interactive terminal UI for Arbor.
 *
 * Consumes an AgentSession's event stream and renders it with @opentui/core's
 * imperative renderables. Runs under Bun (OpenTUI's native FFI needs
 * Bun.dlopen; Node lacks node:ffi). The CLI lazy-imports this package only for
 * interactive mode so headless modes never load the native addon.
 */
export {
	createTuiApp,
	expandSkillInvocation,
	runTui,
	type TuiActions,
	type TuiApp,
	type TuiCommandHook,
	type TuiExit,
	type TuiOptions,
} from "./app.ts";
export type { TuiCommandInfo } from "./components/command-palette.ts";
export { type Item, SessionModel, type SessionModelState } from "./event-bridge.ts";
export { icons } from "./icons.ts";
export { type ArborTheme, buildSyntaxStyle, darkTheme } from "./theme.ts";
export { createTuiExtensionUi, type TuiExtensionUi } from "./ui-context.ts";

export const TUI_VERSION = "0.1.0";
