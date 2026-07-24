/** Extension subsystem: single in-process API covering hooks/plugins/tools. */
export type { DiscoverOptions } from "./loader.ts";
export { discoverExtensionPaths, loadExtensions } from "./loader.ts";
export type { ExtensionLoadError } from "./runner.ts";
export { ExtensionRunner } from "./runner.ts";
export type {
	AgentEndEvent,
	AgentStartEvent,
	AskUiQuestion,
	CompactionEvent,
	CompactionEventResult,
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
	ExtensionCommand,
	ExtensionContext,
	ExtensionEventHandler,
	ExtensionEventMap,
	ExtensionEventName,
	ExtensionFactory,
	ExtensionUi,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
	TurnStartEvent,
	UserPromptEvent,
	UserPromptEventResult,
} from "./types.ts";
