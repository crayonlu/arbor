/**
 * Extension API types.
 *
 * Extensions are TypeScript modules exporting a default factory that receives
 * an {@link ExtensionAPI}. One mechanism covers what other harnesses split
 * into hooks / plugins / custom tools: event subscription (with block/modify
 * power), tool registration, command registration, and session persistence.
 */
import type { AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool, AgentToolCall } from "../types.ts";

/** Context passed to every extension handler. */
export interface ExtensionContext {
	/** Workspace directory. */
	cwd: string;
	/** Current model, when a session is active. */
	model?: Model<any>;
	/** Interact with the user. Headless runners may auto-answer or reject. */
	ui: ExtensionUi;
	/** Persist extension state to the session (replayed on load via `custom_entry`). */
	appendEntry: (customType: string, data: unknown) => void;
	/** Ask the current agent run to stop after the in-flight turn. */
	requestStop: () => void;
}

/** UI surface available to extensions. Implementations vary by frontend. */
export interface ExtensionUi {
	/** Fire-and-forget notification. */
	notify(message: string, level?: "info" | "warn" | "error"): void;
	/** Yes/no confirmation. Headless default: false. */
	confirm(title: string, message: string): Promise<boolean>;
	/** Free-text input. Headless default: undefined. */
	input(title: string, placeholder?: string): Promise<string | undefined>;
	/** Pick one of several options. Headless default: undefined. */
	select(title: string, options: string[]): Promise<string | undefined>;
	/**
	 * Rich multiple-choice question (used by the ask tool). Returns the chosen
	 * option labels, or undefined when the user dismisses the question.
	 * Frontends that don't implement it fall back to `select`.
	 */
	ask?(question: AskUiQuestion): Promise<string[] | undefined>;
}

/** A single question posed to the user via {@link ExtensionUi.ask}. */
export interface AskUiQuestion {
	question: string;
	options: { label: string; description?: string }[];
	multiSelect?: boolean;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface SessionStartEvent {
	type: "session_start";
	reason: "startup" | "new" | "resume" | "fork";
	sessionId: string;
}

export interface SessionShutdownEvent {
	type: "session_shutdown";
	sessionId: string;
}

export interface AgentStartEvent {
	type: "agent_start";
}

export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
}

export interface TurnStartEvent {
	type: "turn_start";
}

export interface TurnEndEvent {
	type: "turn_end";
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
}

/** Fired before a validated tool call executes. Return `{ block }` or `{ args }` to intervene. */
export interface ToolCallEvent {
	type: "tool_call";
	toolName: string;
	toolCall: AgentToolCall;
	/** Validated arguments. */
	input: any;
}

export interface ToolCallEventResult {
	block?: boolean;
	reason?: string;
	/** Replacement arguments. */
	args?: unknown;
}

/** Fired after a tool executes, before the result is finalized. */
export interface ToolResultEvent {
	type: "tool_result";
	toolName: string;
	toolCall: AgentToolCall;
	input: any;
	result: { content: unknown[]; details: unknown };
	isError: boolean;
}

export interface ToolResultEventResult {
	/** Replacement content array. */
	content?: any[];
	details?: unknown;
	isError?: boolean;
}

/** Fired before each LLM call. Return replacement messages to modify context. */
export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

export interface ContextEventResult {
	messages?: AgentMessage[];
}

/** Fired when auto-compaction is about to run. An extension may take over. */
export interface CompactionEvent {
	type: "compaction";
	messages: AgentMessage[];
	/** Estimated tokens currently in context. */
	estimatedTokens: number;
}

export interface CompactionEventResult {
	/** Extension-provided summary; suppresses the built-in compactor. */
	summary?: string;
	/** Messages to keep after the summary. Defaults to the built-in tail selection. */
	keepMessages?: AgentMessage[];
}

export interface UserPromptEvent {
	type: "user_prompt";
	text: string;
}

export interface UserPromptEventResult {
	/** Replace the prompt text. */
	text?: string;
	/** Swallow the prompt entirely (extension handled it). */
	handled?: boolean;
}

export type ExtensionEventMap = {
	session_start: { event: SessionStartEvent; result: undefined };
	session_shutdown: { event: SessionShutdownEvent; result: undefined };
	agent_start: { event: AgentStartEvent; result: undefined };
	agent_end: { event: AgentEndEvent; result: undefined };
	turn_start: { event: TurnStartEvent; result: undefined };
	turn_end: { event: TurnEndEvent; result: undefined };
	tool_call: { event: ToolCallEvent; result: ToolCallEventResult | undefined };
	tool_result: { event: ToolResultEvent; result: ToolResultEventResult | undefined };
	context: { event: ContextEvent; result: ContextEventResult | undefined };
	compaction: { event: CompactionEvent; result: CompactionEventResult | undefined };
	user_prompt: { event: UserPromptEvent; result: UserPromptEventResult | undefined };
};

export type ExtensionEventName = keyof ExtensionEventMap;

export type ExtensionEventHandler<K extends ExtensionEventName> = (
	event: ExtensionEventMap[K]["event"],
	ctx: ExtensionContext,
	// biome-ignore lint/suspicious/noConfusingVoidType: void allows plain notification handlers with no return
) => ExtensionEventMap[K]["result"] | void | Promise<ExtensionEventMap[K]["result"] | void>;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface ExtensionCommand {
	description: string;
	handler: (args: string, ctx: ExtensionContext) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// API given to extension factories
// ---------------------------------------------------------------------------

export interface ExtensionAPI {
	/** Subscribe to a lifecycle or interception event. */
	on<K extends ExtensionEventName>(event: K, handler: ExtensionEventHandler<K>): void;
	/** Register a tool callable by the model. */
	registerTool(tool: AgentTool<any>): void;
	/** Register a /command. */
	registerCommand(name: string, command: ExtensionCommand): void;
}

/** An extension module's default export. */
export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;
