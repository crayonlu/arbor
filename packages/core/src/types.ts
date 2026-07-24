/**
 * Core types for the Arbor agent harness.
 *
 * The design principle: AgentMessage is the unit of session state. It is a
 * superset of the LLM Message type — apps and extensions can add their own
 * message roles via declaration merging on {@link CustomAgentMessages}. The
 * loop transforms AgentMessage[] to Message[] only at the LLM call boundary.
 */
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";

/**
 * Stream function used by the agent loop. `Models.streamSimple` satisfies this.
 *
 * Contract: must not throw for request/model/runtime failures. Failures are
 * encoded in the returned stream as an `error` event carrying a final
 * AssistantMessage with stopReason "error" or "aborted".
 */
export type StreamFn = (
	model: Model<any>,
	context: LlmContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** Context shape sent to the LLM (pi-ai's Context). */
export interface LlmContext {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

/**
 * Extensible interface for custom app messages. Extend via declaration merging:
 *
 * ```typescript
 * declare module "@arbor-space/core" {
 *   interface CustomAgentMessages {
 *     notification: { role: "notification"; text: string; timestamp: number };
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: extension point via declaration merging
export interface CustomAgentMessages {}

/** Union of LLM messages and app-defined custom messages. */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/** A tool call content block from an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/** Result produced by a tool execution. */
export interface AgentToolResult<TDetails = unknown> {
	/** Content returned to the model. */
	content: (TextContent | ImageContent)[];
	/** Structured details for logs, UI rendering, and session persistence. */
	details: TDetails;
	/** Usage from nested LLM work performed by the tool itself, if any. */
	usage?: Usage;
	/**
	 * Hint that the agent should stop after the current tool batch. Early
	 * termination happens only when every result in the batch sets this.
	 */
	terminate?: boolean;
}

/** Callback used by tools to stream partial execution updates. */
export type AgentToolUpdateCallback<TDetails = unknown> = (partialResult: AgentToolResult<TDetails>) => void;

/** Tool definition used by the agent runtime. */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	/** Human-readable label for UI display. */
	label: string;
	/**
	 * If true, this tool is hidden from the model in read-only modes (plan mode).
	 * Tools that mutate the workspace or run arbitrary code must set this.
	 */
	mutates?: boolean;
	/** Execute the tool call. Throw on failure instead of encoding errors in content. */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
}

/** Context snapshot passed into the agent loop. */
export interface AgentContext {
	systemPrompt: string;
	messages: AgentMessage[];
	tools: AgentTool<any>[];
}

/** Result of a `beforeToolCall` interception. */
export interface BeforeToolCallResult {
	/** Prevent the tool from executing; an error tool result is emitted instead. */
	block?: boolean;
	/** Text shown in the blocked tool result. */
	reason?: string;
	/** Replacement for the validated tool arguments. */
	args?: unknown;
}

/** Partial override returned from `afterToolCall`. Field-by-field replacement, no deep merge. */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	usage?: Usage;
	terminate?: boolean;
}

export interface BeforeToolCallContext {
	assistantMessage: AssistantMessage;
	toolCall: AgentToolCall;
	/** Validated tool arguments. */
	args: unknown;
	context: AgentContext;
}

export interface AfterToolCallContext extends BeforeToolCallContext {
	/** The executed result before overrides are applied. */
	result: AgentToolResult;
	isError: boolean;
}

export interface TurnEndContext {
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
	context: AgentContext;
	/** Messages produced so far by this loop run. */
	newMessages: AgentMessage[];
}

/** Retry policy for transient provider errors (delegated to pi-ai's retryAssistantCall). */
export interface LoopRetryPolicy {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

/** Configuration for a single agent loop run. */
export interface AgentLoopConfig {
	model: Model<any>;
	/** Options forwarded to the provider stream call (thinking level, caching, etc.). */
	streamOptions?: SimpleStreamOptions;
	/**
	 * Converts AgentMessage[] to LLM Message[] before each LLM call. Custom
	 * messages must be converted or filtered out. Contract: must not throw.
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/**
	 * Transform applied to the full message list before `convertToLlm` on every
	 * turn. This is the compaction / context-management hook. Contract: must not throw.
	 */
	transformContext?: (
		messages: AgentMessage[],
		signal?: AbortSignal,
	) => AgentMessage[] | Promise<AgentMessage[]>;
	/** Intercept a tool call after validation, before execution. */
	beforeToolCall?: (
		ctx: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;
	/** Intercept a tool result before it is finalized and emitted. */
	afterToolCall?: (
		ctx: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;
	/**
	 * Steering messages injected after the current turn's tool calls finish,
	 * before the next LLM call. Contract: must not throw; return [] when empty.
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]> | AgentMessage[];
	/**
	 * Follow-up messages processed when the agent would otherwise stop. If any
	 * are returned the loop continues with another turn.
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]> | AgentMessage[];
	/** Stop the loop after the current turn when it returns true. */
	shouldStopAfterTurn?: (ctx: TurnEndContext) => boolean | Promise<boolean>;
	/**
	 * Called when the provider reports context overflow. Return a replacement
	 * message list (e.g. after compaction) to retry the turn once, or undefined
	 * to give up and surface the error.
	 */
	onOverflow?: (
		messages: AgentMessage[],
		signal?: AbortSignal,
	) => Promise<AgentMessage[] | undefined> | AgentMessage[] | undefined;
	/** Retry policy for transient provider errors. Default: 3 retries, 2s base delay. */
	retry?: LoopRetryPolicy;
}

/**
 * Events emitted by the agent loop.
 *
 * `agent_end` is always the final event of a run, including error and abort runs.
 */
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: AgentToolResult;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult;
			isError: boolean;
	  }
	| { type: "retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	/**
	 * A background job settled or emitted a notice while the agent was idle.
	 * Not emitted by the loop itself — AgentSession forwards it to listeners so
	 * frontends can surface the notification and trigger a continuation.
	 */
	| { type: "job_notification"; text: string }
	/**
	 * Session usage totals changed. Emitted by AgentSession after each prompt
	 * (not by the loop); `totals` is the session-lifetime aggregate.
	 */
	| { type: "usage_update"; totals: import("./usage.ts").UsageTotals };
