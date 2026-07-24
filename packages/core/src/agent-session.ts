/**
 * AgentSession: the assembled harness.
 *
 * Wires together the loop, session tree, shadow-git snapshots, extensions,
 * compaction, modes, goal, skills, and tools into a promptable session.
 * Frontends (CLI, TUI, SDK, subagent entry) consume this instead of wiring
 * the pieces themselves.
 */
import type { Model, Usage } from "@earendil-works/pi-ai";
import { type ContextFile, contextFilesPromptSection, loadContextFiles } from "./context-files.ts";
import { ExtensionRunner } from "./extensions/runner.ts";
import type { ExtensionContext, ExtensionUi } from "./extensions/types.ts";
import { createGoalState, type GoalState, goalPromptSection } from "./goal.ts";
import { createJobsTool } from "./jobs/jobs-tool.ts";
import { tailJobLog } from "./jobs/log-store.ts";
import type { BackgroundJobs, JobNotification } from "./jobs/registry.ts";
import type { AgentEventSink } from "./loop.ts";
import { runAgentLoop } from "./loop.ts";
import type { AgentMode } from "./modes.ts";
import { createExitPlanTool, filterToolsForMode, modePromptSection } from "./modes.ts";
import { type CompactionSettings, compactMessages, shouldCompact } from "./session/compaction.ts";
import { SessionManager } from "./session/manager.ts";
import { rewindSession } from "./session/rewind.ts";
import type { SnapshotManager } from "./session/snapshot.ts";
import { generateSessionTitle } from "./session/title.ts";
import type { Skill } from "./skills.ts";
import { skillsPromptSection } from "./skills.ts";
import { createAskTool } from "./tools/ask.ts";
import {
	defaultToolOutputsRoot,
	type OutputPersistenceOptions,
	persistLargeOutputs,
} from "./tools/persist.ts";
import { createTodoStore, createTodoTool, TODO_CUSTOM_TYPE, type TodoStore } from "./tools/todo.ts";
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from "./types.ts";
import { addUsage, computeUsageTotals, type UsageTotals } from "./usage.ts";

export interface AgentSessionOptions {
	cwd: string;
	model: Model<any>;
	streamFn: StreamFn;
	/** Base system prompt (identity + workspace instructions). */
	systemPrompt: string;
	/** Workspace tools (read/bash/edit/...). */
	tools: AgentTool<any>[];
	sessionManager?: SessionManager;
	/** Snapshot manager; null disables file snapshots/rewind restore. */
	snapshots?: SnapshotManager | null;
	extensions?: ExtensionRunner;
	skills?: Skill[];
	compaction?: CompactionSettings;
	/** UI bridge for extensions. Defaults to a headless no-op UI. */
	ui?: ExtensionUi;
	mode?: AgentMode;
	/**
	 * Background job registry. When provided, the jobs tool is exposed to the
	 * model and job notifications (completion, stall warnings) are injected as
	 * follow-up messages between turns. Share one registry between this session
	 * and the tools created with it (createBashTool/createTaskTool).
	 */
	jobs?: BackgroundJobs;
	/**
	 * Project context files (AGENTS.md/CLAUDE.md) appended to the system
	 * prompt. Default: discovered from ~/.arbor and the cwd's ancestors.
	 * Pass an explicit list to override, or `false` to disable.
	 */
	contextFiles?: ContextFile[] | false;
	/**
	 * Large tool output persistence. Oversized text results are written to
	 * disk and replaced with a preview + path. Default: enabled, rooted at
	 * ~/.arbor/tool-outputs/<sessionId>. Pass `false` to disable.
	 */
	outputPersistence?: Partial<OutputPersistenceOptions> | false;
	/**
	 * Generate a session title from the first prompt (small LLM call after
	 * the first successful turn). Default: enabled for persisted sessions.
	 */
	autoTitle?: boolean;
}

export type SessionEventListener = (event: AgentEvent) => void | Promise<void>;

const HEADLESS_UI: ExtensionUi = {
	notify: () => {},
	confirm: async () => false,
	input: async () => undefined,
	select: async () => undefined,
};

export class AgentSession {
	readonly cwd: string;
	readonly session: SessionManager;
	readonly snapshots: SnapshotManager | null;
	readonly extensions: ExtensionRunner;
	readonly todos: TodoStore;
	readonly goal: GoalState;
	readonly jobs: BackgroundJobs | null;
	model: Model<any>;
	mode: AgentMode;

	private readonly streamFn: StreamFn;
	private readonly baseSystemPrompt: string;
	private readonly workspaceTools: AgentTool<any>[];
	private readonly skills: Skill[];
	private readonly compactionSettings: CompactionSettings;
	private readonly ui: ExtensionUi;
	/** True when the caller provided a real UI (enables the ask tool). */
	private readonly hasInteractiveUi: boolean;
	private readonly listeners = new Set<SessionEventListener>();
	private messages: AgentMessage[] = [];
	private steeringQueue: AgentMessage[] = [];
	private followUpQueue: AgentMessage[] = [];
	private contextFiles: ContextFile[];
	private usageTotals: UsageTotals;
	private readonly outputPersistence: OutputPersistenceOptions | null;
	private readonly autoTitle: boolean;
	private titlePending: Promise<string | null> | null = null;
	private stopRequested = false;
	private running = false;
	private abortController: AbortController | null = null;
	private pendingPlan: string | null = null;

	constructor(options: AgentSessionOptions) {
		this.cwd = options.cwd;
		this.model = options.model;
		this.streamFn = options.streamFn;
		this.baseSystemPrompt = options.systemPrompt;
		this.workspaceTools = options.tools;
		this.session = options.sessionManager ?? SessionManager.create(options.cwd);
		this.snapshots = options.snapshots === undefined ? null : options.snapshots;
		this.extensions = options.extensions ?? new ExtensionRunner();
		this.skills = options.skills ?? [];
		this.compactionSettings = options.compaction ?? {};
		this.ui = options.ui ?? HEADLESS_UI;
		this.hasInteractiveUi = options.ui !== undefined;
		this.mode = options.mode ?? "build";
		this.todos = createTodoStore((todos) => {
			this.session.appendCustom(TODO_CUSTOM_TYPE, todos);
		});
		this.goal = createGoalState();
		this.contextFiles =
			options.contextFiles === false ? [] : (options.contextFiles ?? loadContextFiles(options.cwd));
		this.outputPersistence =
			options.outputPersistence === false
				? null
				: {
						root: options.outputPersistence?.root ?? `${defaultToolOutputsRoot()}/${this.session.sessionId}`,
						...(options.outputPersistence?.thresholdBytes !== undefined
							? { thresholdBytes: options.outputPersistence.thresholdBytes }
							: {}),
						...(options.outputPersistence?.previewBytes !== undefined
							? { previewBytes: options.outputPersistence.previewBytes }
							: {}),
					};
		this.jobs = options.jobs ?? null;
		if (this.jobs) {
			this.jobs.subscribe((notification) => {
				void this.onJobNotification(notification);
			});
		}
		// Rebuild in-memory context from the session's active path (resume).
		this.messages = this.session.buildContextMessages();
		this.usageTotals = computeUsageTotals(this.messages);
		this.autoTitle = options.autoTitle ?? this.session.filePath !== null;
	}

	/**
	 * Generate and persist a session title from the given (or first) user
	 * prompt. Skips when the session is already named. Returns the title,
	 * or null when generation fails or is skipped.
	 */
	async generateTitle(fromText?: string): Promise<string | null> {
		if (this.session.name) return null;
		const source =
			fromText ??
			(this.messages.find((m) => (m as { role?: string }).role === "user") as
				| { content?: unknown }
				| undefined);
		const text =
			typeof source === "string"
				? source
				: typeof (source as { content?: unknown })?.content === "string"
					? ((source as { content: string }).content as string)
					: null;
		if (!text) return null;
		const title = await generateSessionTitle(this.streamFn, this.model, text);
		if (title && !this.session.name) {
			this.session.setName(title);
		}
		return title;
	}

	private maybeScheduleAutoTitle(promptText: string): void {
		if (!this.autoTitle || this.session.name || this.titlePending) return;
		// Fire-and-forget: title generation must never block or fail the turn.
		this.titlePending = this.generateTitle(promptText).catch(() => null);
	}

	/** Resolves when any in-flight auto-title attempt finishes (test/CLI hook). */
	async titleSettled(): Promise<void> {
		await this.titlePending;
	}

	// -- background jobs -------------------------------------------------------

	/**
	 * Queue a job notification as a follow-up message so the running loop picks
	 * it up between turns. When the agent is idle, additionally emit a
	 * job_notification event so the frontend can trigger a continuation.
	 */
	private async onJobNotification(notification: JobNotification): Promise<void> {
		const text = await buildJobNotificationText(notification);
		this.followUpQueue.push({ role: "user", content: text, timestamp: Date.now() });
		if (!this.running) {
			await this.emitToListeners({ type: "job_notification", text });
		}
	}

	// -- events --------------------------------------------------------------

	subscribe(listener: SessionEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emitToListeners: AgentEventSink = async (event) => {
		for (const listener of this.listeners) {
			await listener(event);
		}
	};

	// -- state ---------------------------------------------------------------

	get isRunning(): boolean {
		return this.running;
	}

	getMessages(): AgentMessage[] {
		return [...this.messages];
	}

	/** Session-lifetime usage totals (tokens and cost). Returns a copy. */
	getUsageTotals(): UsageTotals {
		return { ...this.usageTotals, cost: { ...this.usageTotals.cost } };
	}

	/** Plan produced by the last plan-mode run, if any. */
	takePendingPlan(): string | null {
		const plan = this.pendingPlan;
		this.pendingPlan = null;
		return plan;
	}

	/** Queue a message to inject between turns of the running loop. */
	steer(text: string): void {
		this.steeringQueue.push({ role: "user", content: text, timestamp: Date.now() });
	}

	/**
	 * True when a steering message is queued and waiting to inject. Wire this
	 * into `createBashTool`'s autoBackground.steeringPending so long-running
	 * foreground commands yield to user input.
	 */
	hasPendingSteering(): boolean {
		return this.steeringQueue.length > 0;
	}

	/**
	 * Withdraw queued steering messages (e.g. the user pressed Esc to cancel a
	 * message queued while the agent was running). Returns the withdrawn count.
	 */
	clearSteering(): number {
		const count = this.steeringQueue.length;
		this.steeringQueue = [];
		return count;
	}

	/** Ask the running loop to stop after the current turn. */
	requestStop(): void {
		this.stopRequested = true;
	}

	/** Abort the running loop immediately. */
	abort(): void {
		this.abortController?.abort();
	}

	private extensionContext(): ExtensionContext {
		return {
			cwd: this.cwd,
			model: this.model,
			ui: this.ui,
			appendEntry: (customType, data) => this.session.appendCustom(customType, data),
			requestStop: () => this.requestStop(),
		};
	}

	/**
	 * Invoke an extension-registered slash command by name. Returns false when
	 * no command with that name is registered. Used by the CLI/TUI slash
	 * dispatcher so extension commands share the ExtensionContext the session
	 * already builds for lifecycle events.
	 */
	async invokeExtensionCommand(name: string, args: string): Promise<boolean> {
		const command = this.extensions.getCommands().get(name);
		if (!command) return false;
		await command.handler(args, this.extensionContext());
		return true;
	}

	// -- prompt --------------------------------------------------------------

	private buildSystemPrompt(): string {
		const sections = [
			this.baseSystemPrompt,
			contextFilesPromptSection(this.contextFiles),
			modePromptSection(this.mode),
			goalPromptSection(this.goal.get()),
			skillsPromptSection(this.skills),
		].filter((s) => s.length > 0);
		return sections.join("\n\n");
	}

	/** Re-discover context files from disk (e.g. after the user edits AGENTS.md). */
	reloadContextFiles(): void {
		this.contextFiles = loadContextFiles(this.cwd);
	}

	private buildTools(): AgentTool<any>[] {
		const tools = [...this.workspaceTools, createTodoTool(this.todos), ...this.extensions.getTools()];
		if (this.jobs) {
			tools.push(createJobsTool(this.jobs));
		}
		if (this.hasInteractiveUi) {
			tools.push(createAskTool(this.ui));
		}
		let filtered = filterToolsForMode(tools, this.mode);
		if (this.outputPersistence) {
			filtered = persistLargeOutputs(filtered, this.outputPersistence);
		}
		if (this.mode === "plan") {
			filtered.push(
				createExitPlanTool((plan) => {
					this.pendingPlan = plan;
				}),
			);
		}
		return filtered;
	}

	/**
	 * Run one prompt through the agent loop. Resolves when the loop settles.
	 * Events stream to subscribers; new messages persist to the session tree.
	 */
	async prompt(text: string, signal?: AbortSignal): Promise<AgentMessage[]> {
		if (this.running) {
			// A second prompt while running becomes steering input.
			this.steer(text);
			return [];
		}
		this.running = true;
		this.stopRequested = false;
		this.abortController = new AbortController();
		const abortSignal = signal
			? AbortSignal.any([signal, this.abortController.signal])
			: this.abortController.signal;
		const extCtx = this.extensionContext();

		try {
			// Extension user_prompt interception.
			const promptResult = await this.extensions.emitUserPrompt({ type: "user_prompt", text }, extCtx);
			if (promptResult?.handled) return [];
			const finalText = promptResult?.text ?? text;

			// Snapshot the workspace before the turn (rewind anchor).
			if (this.snapshots) {
				try {
					const commit = await this.snapshots.track();
					this.session.appendSnapshot(commit);
				} catch {
					// Snapshot failure must not block the conversation.
				}
			}

			await this.extensions.emit("agent_start", { type: "agent_start" }, extCtx);

			const promptMessage: AgentMessage = {
				role: "user",
				content: finalText,
				timestamp: Date.now(),
			};
			// Notifications queued while idle (e.g. background jobs that settled
			// between prompts) ride along with the new prompt instead of waiting
			// for the loop's follow-up drain at the end of the run.
			const pendingNotifications = this.followUpQueue.splice(0);

			const persistedCountBefore = this.messages.length;
			const newMessages = await runAgentLoop(
				[...pendingNotifications, promptMessage],
				{
					systemPrompt: this.buildSystemPrompt(),
					messages: this.messages,
					tools: this.buildTools(),
				},
				{
					model: this.model,
					convertToLlm: (messages) => messages as never,
					transformContext: async (messages, sig) => {
						// Extension context transform, then compaction check.
						const extResult = await this.extensions.emitContext({ type: "context", messages }, extCtx);
						let current = extResult?.messages ?? messages;
						if (shouldCompact(current, this.model.contextWindow, this.compactionSettings)) {
							current = await this.runCompaction(current, sig);
						}
						return current;
					},
					beforeToolCall: async (ctx) => {
						const result = await this.extensions.emitToolCall(
							{
								type: "tool_call",
								toolName: ctx.toolCall.name,
								toolCall: ctx.toolCall,
								input: ctx.args,
							},
							extCtx,
						);
						if (result?.block) return { block: true, ...(result.reason ? { reason: result.reason } : {}) };
						if (result?.args !== undefined) return { args: result.args };
						return undefined;
					},
					afterToolCall: async (ctx) => {
						const result = await this.extensions.emitToolResult(
							{
								type: "tool_result",
								toolName: ctx.toolCall.name,
								toolCall: ctx.toolCall,
								input: ctx.args,
								result: { content: ctx.result.content, details: ctx.result.details },
								isError: ctx.isError,
							},
							extCtx,
						);
						if (!result) return undefined;
						return {
							...(result.content !== undefined ? { content: result.content as never } : {}),
							...(result.details !== undefined ? { details: result.details } : {}),
							...(result.isError !== undefined ? { isError: result.isError } : {}),
						};
					},
					getSteeringMessages: () => {
						const queued = this.steeringQueue;
						this.steeringQueue = [];
						return queued;
					},
					getFollowUpMessages: () => {
						const queued = this.followUpQueue;
						this.followUpQueue = [];
						return queued;
					},
					shouldStopAfterTurn: async (ctx) => {
						await this.extensions.emit(
							"turn_end",
							{ type: "turn_end", message: ctx.message, toolResults: ctx.toolResults },
							extCtx,
						);
						return this.stopRequested;
					},
					onOverflow: (messages, sig) => this.runCompaction(messages, sig),
				},
				this.streamFn,
				this.emitToListeners,
				abortSignal,
			);

			// The loop worked on a copy; adopt its context and persist new messages.
			this.messages = [...this.messages.slice(0, persistedCountBefore), ...newMessages];
			for (const message of newMessages) {
				this.session.appendMessage(message);
				const assistant = message as { role?: string; usage?: Usage };
				if (assistant.role === "assistant" && assistant.usage) {
					addUsage(this.usageTotals, assistant.usage);
				}
			}
			await this.emitToListeners({ type: "usage_update", totals: this.getUsageTotals() });
			await this.extensions.emit("agent_end", { type: "agent_end", messages: newMessages }, extCtx);
			this.maybeScheduleAutoTitle(finalText);
			return newMessages;
		} finally {
			this.running = false;
			this.abortController = null;
		}
	}

	/** Compaction path shared by threshold trigger, overflow recovery, and /compact. */
	private async runCompaction(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
		const extResult = await this.extensions.emitCompaction(
			{
				type: "compaction",
				messages,
				estimatedTokens: 0,
			},
			this.extensionContext(),
		);
		if (extResult?.summary !== undefined) {
			const keep = extResult.keepMessages ?? [];
			this.session.appendCompaction({
				summary: extResult.summary,
				tokensBefore: 0,
				fromExtension: true,
			});
			return [
				{
					role: "user",
					content: `[Conversation summary from earlier context]\n\n${extResult.summary}`,
					timestamp: Date.now(),
				},
				...keep,
			];
		}

		const result = await compactMessages(
			messages,
			this.model,
			this.streamFn,
			this.compactionSettings,
			undefined,
			signal,
		);
		this.session.appendCompaction({
			summary: result.summary,
			tokensBefore: result.tokensBefore,
			...(result.usage ? { usage: result.usage } : {}),
		});
		return [
			{
				role: "user",
				content: `[Conversation summary from earlier context]\n\n${result.summary}`,
				timestamp: Date.now(),
			},
			...result.keepMessages,
		];
	}

	/** Manual compaction (/compact). */
	async compactNow(signal?: AbortSignal): Promise<void> {
		this.messages = await this.runCompaction(this.messages, signal);
	}

	/** Rewind conversation and workspace to a session entry. */
	async rewind(targetEntryId: string): Promise<void> {
		if (this.running) {
			throw new Error("Cannot rewind while the agent is running");
		}
		await rewindSession(this.session, this.snapshots, targetEntryId);
		this.messages = this.session.buildContextMessages();
	}
}

const NOTIFICATION_TAIL_BYTES = 512;

/** Render a job notification as plain text for injection into the conversation. */
async function buildJobNotificationText(notification: JobNotification): Promise<string> {
	const { info } = notification;
	if (notification.kind === "notice") {
		return `[background job ${info.id} notice] ${info.type} "${info.title}"\n${notification.text}`;
	}
	const exit = info.exitCode !== undefined && info.exitCode !== null ? ` (exit ${info.exitCode})` : "";
	const lines = [`[background job ${info.id} ${info.status}${exit}] ${info.type} "${info.title}" finished.`];
	if (info.error) {
		lines.push(`Error: ${info.error}`);
	}
	if (info.logPath) {
		lines.push(`Output file: ${info.logPath} — read it with the read tool if you need the full output.`);
		const tail = await tailJobLog(info.logPath, NOTIFICATION_TAIL_BYTES).catch(() => "");
		if (tail.trim().length > 0) {
			lines.push("Tail:", tail.trimEnd());
		}
	}
	return lines.join("\n");
}
