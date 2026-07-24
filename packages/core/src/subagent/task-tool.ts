/**
 * task tool: spawn a subagent in a child process and return its result.
 *
 * The child is another arbor process speaking the SubagentEvent JSONL
 * protocol on stdout. Foreground (default): progress streams to the parent
 * via onUpdate and the child's final text becomes the tool result.
 * Background (`background: true`, requires a BackgroundJobs registry):
 * returns immediately with a job id; events append to a disk log and
 * completion is announced via the registry.
 *
 * Agent definitions (custom subagent types) are markdown files with
 * frontmatter discovered from .arbor/agents/ and ~/.arbor/agents/.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { createJobLog } from "../jobs/log-store.ts";
import type { BackgroundJobs } from "../jobs/registry.ts";
import { parseFrontmatter } from "../skills.ts";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "../types.ts";
import { createJsonlDecoder, type SubagentConfig, type SubagentEvent } from "./protocol.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface AgentDefinition {
	name: string;
	description: string;
	/** System prompt override for this agent type. */
	prompt: string;
	/** Tool restriction, if any. */
	tools?: string[];
	/** Mode restriction (e.g. read-only scouts run in plan mode). */
	mode?: "build" | "plan";
}

/** Discover agent definitions from ~/.arbor/agents and <cwd>/.arbor/agents. */
export async function discoverAgentDefinitions(
	cwd: string,
	homeDir = os.homedir(),
): Promise<AgentDefinition[]> {
	const byName = new Map<string, AgentDefinition>();
	for (const dir of [path.join(homeDir, ".arbor", "agents"), path.join(cwd, ".arbor", "agents")]) {
		const isDir = await stat(dir).then(
			(s) => s.isDirectory(),
			() => false,
		);
		if (!isDir) continue;
		const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
		for (const file of files) {
			const content = await readFile(path.join(dir, file), "utf-8").catch(() => null);
			if (content === null) continue;
			const { frontmatter, body } = parseFrontmatter(content);
			const name = frontmatter.name ?? path.basename(file, ".md");
			byName.set(name, {
				name,
				description: frontmatter.description ?? "",
				prompt: body.trim(),
				...(frontmatter.tools !== undefined
					? { tools: frontmatter.tools.split(",").map((t) => t.trim()) }
					: {}),
				...(frontmatter.mode === "plan" ? { mode: "plan" as const } : {}),
			});
		}
	}
	return [...byName.values()];
}

export interface TaskToolOptions {
	cwd: string;
	provider: string;
	modelId: string;
	/** Discovered agent definitions (adds `agent` parameter values). */
	agents?: AgentDefinition[];
	/** Node entry for the subagent child. Default: the bundled entry.ts. */
	entryPath?: string;
	timeoutMs?: number;
	/** Enables the `background` parameter when provided. */
	jobs?: BackgroundJobs;
	/** Root directory for background job logs. Default: ~/.arbor/tasks */
	logsRoot?: string;
}

const baseProperties = {
	prompt: Type.String({
		description:
			"The task for the subagent. Be specific: include the goal, relevant paths, and what the final report must contain.",
	}),
	agent: Type.Optional(
		Type.String({
			description: "Named agent type to use (see tool description for available types)",
		}),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("build"), Type.Literal("plan")], {
			description: "'plan' restricts the subagent to read-only tools",
		}),
	),
};

const foregroundParameters = Type.Object(baseProperties);
const backgroundParameters = Type.Object({
	...baseProperties,
	background: Type.Optional(
		Type.Boolean({
			description:
				"Launch the subagent in the background and return immediately with a job id. " +
				"Use for independent work that can run while you continue elsewhere. " +
				"You will be notified when it completes — do not poll. Manage with the jobs tool.",
		}),
	),
});

export type TaskToolInput = Static<typeof backgroundParameters>;

/**
 * One step in a subagent's transcript, surfaced live to the parent so a UI can
 * render a switchable per-agent view while the subagent runs.
 */
export interface SubagentThreadItem {
	type: "text" | "tool";
	/** Accumulated assistant text (text items only). */
	text?: string;
	toolName?: string;
	summary?: string;
	isError?: boolean;
}

export interface TaskToolDetails {
	agent?: string;
	messageCount: number;
	toolSummaries: string[];
	/** Ordered subagent transcript for live UI rendering. */
	thread: SubagentThreadItem[];
	/** Latest assistant text the subagent produced (for a streaming tail). */
	streamingText: string;
	exitCode: number | null;
	/** Set when the subagent was started as a background job. */
	jobId?: string;
	logPath?: string;
}

function defaultEntryPath(): string {
	return fileURLToPath(new URL("./entry.ts", import.meta.url));
}

function buildConfig(
	options: TaskToolOptions,
	params: TaskToolInput,
	agentDef: AgentDefinition | undefined,
): SubagentConfig {
	return {
		cwd: options.cwd,
		provider: options.provider,
		modelId: options.modelId,
		prompt: params.prompt,
		...(agentDef?.prompt ? { systemPrompt: agentDef.prompt } : {}),
		...(agentDef?.tools ? { tools: agentDef.tools } : {}),
		mode: params.mode ?? agentDef?.mode ?? "build",
	};
}

function spawnSubagent(options: TaskToolOptions, config: SubagentConfig): ChildProcess {
	const entry = options.entryPath ?? defaultEntryPath();
	return spawn(process.execPath, [entry, JSON.stringify(config)], {
		cwd: options.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});
}

/** Foreground execution: block until the child reports its result. */
function executeForeground(
	options: TaskToolOptions,
	params: TaskToolInput,
	agentDef: AgentDefinition | undefined,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined,
): Promise<AgentToolResult<TaskToolDetails>> {
	const config = buildConfig(options, params, agentDef);
	return new Promise((resolve, reject) => {
		const child = spawnSubagent(options, config);

		const toolSummaries: string[] = [];
		const thread: SubagentThreadItem[] = [];
		let resultEvent: Extract<SubagentEvent, { type: "result" }> | null = null;
		let fatalError: string | null = null;
		let lastText = "";
		let settled = false;

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort, { once: true });

		const agentField = params.agent !== undefined ? { agent: params.agent } : {};
		const liveDetails = (): TaskToolDetails => ({
			...agentField,
			messageCount: 0,
			toolSummaries: [...toolSummaries],
			thread: thread.map((it) => ({ ...it })),
			streamingText: lastText,
			exitCode: null,
		});

		const decode = createJsonlDecoder((event) => {
			switch (event.type) {
				case "text":
					lastText = event.text;
					thread.push({ type: "text", text: event.text });
					onUpdate?.({
						content: [{ type: "text", text: event.text }],
						details: liveDetails(),
					});
					break;
				case "tool":
					toolSummaries.push(`${event.toolName}: ${event.summary}`);
					thread.push({
						type: "tool",
						toolName: event.toolName,
						summary: event.summary,
						...(event.isError ? { isError: true } : {}),
					});
					onUpdate?.({
						content: [{ type: "text", text: `[${event.toolName}] ${event.summary}` }],
						details: liveDetails(),
					});
					break;
				case "result":
					resultEvent = event;
					break;
				case "fatal":
					fatalError = event.error;
					break;
				default:
					break;
			}
		});
		child.stdout?.on("data", (chunk: Buffer) => decode(chunk.toString("utf-8")));
		let stderrTail = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrTail = (stderrTail + chunk.toString("utf-8")).slice(-2000);
		});

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			fn();
		};

		child.on("error", (error) =>
			settle(() => reject(new Error(`Failed to spawn subagent: ${error.message}`))),
		);
		child.on("close", (code) => {
			settle(() => {
				if (fatalError) {
					reject(new Error(`Subagent failed: ${fatalError}`));
					return;
				}
				if (signal?.aborted) {
					reject(new Error("Subagent aborted."));
					return;
				}
				const final: Extract<SubagentEvent, { type: "result" }> | null = resultEvent;
				const text = final?.text || lastText;
				if (!text) {
					reject(
						new Error(
							`Subagent produced no result (exit ${code}).${stderrTail ? ` stderr: ${stderrTail}` : ""}`,
						),
					);
					return;
				}
				resolve({
					content: [{ type: "text", text }],
					details: {
						...agentField,
						messageCount: final?.messageCount ?? 0,
						toolSummaries,
						thread: thread.map((it) => ({ ...it })),
						streamingText: lastText,
						exitCode: code,
					},
				});
			});
		});
	});
}

/** Background execution: register a job, stream events to disk, return immediately. */
function executeBackground(
	options: TaskToolOptions,
	params: TaskToolInput,
	agentDef: AgentDefinition | undefined,
	jobs: BackgroundJobs,
): AgentToolResult<TaskToolDetails> {
	const config = buildConfig(options, params, agentDef);
	const child = spawnSubagent(options, config);
	const title = params.agent ? `[${params.agent}] ${params.prompt}` : params.prompt;
	const handle = jobs.start({
		type: "task",
		title,
		kill: () => child.kill("SIGKILL"),
	});
	const log = createJobLog(handle.id, options.logsRoot);
	jobs.setLogPath(handle.id, log.path);

	let resultText = "";
	let fatalError: string | null = null;
	const decode = createJsonlDecoder((event) => {
		switch (event.type) {
			case "text":
				resultText = event.text;
				log.append(`${event.text}\n`);
				break;
			case "tool":
				log.append(`[${event.toolName}] ${event.summary}\n`);
				break;
			case "result":
				if (event.text) {
					resultText = event.text;
					log.append(`${event.text}\n`);
				}
				break;
			case "fatal":
				fatalError = event.error;
				log.append(`FATAL: ${event.error}\n`);
				break;
			default:
				break;
		}
	});
	child.stdout?.on("data", (chunk: Buffer) => decode(chunk.toString("utf-8")));
	child.stderr?.on("data", (chunk: Buffer) => log.append(chunk));

	const timer = setTimeout(() => jobs.kill(handle.id), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	timer.unref?.();

	child.on("error", (error) => {
		clearTimeout(timer);
		void log.close();
		handle.fail(`Failed to spawn subagent: ${error.message}`);
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		void log.close();
		if (handle.isSettled) return;
		if (fatalError) {
			handle.fail(fatalError, code);
		} else if (code === 0 && resultText) {
			handle.complete(0);
		} else {
			handle.fail(resultText ? `Exited with code ${code}` : `No result (exit ${code})`, code);
		}
	});

	return {
		content: [
			{
				type: "text",
				text: `Started background subagent ${handle.id}.\nOutput file: ${log.path}\nYou will be notified when it completes — do not poll. Continue with other work.`,
			},
		],
		details: {
			...(params.agent !== undefined ? { agent: params.agent } : {}),
			messageCount: 0,
			toolSummaries: [],
			thread: [],
			streamingText: "",
			exitCode: null,
			jobId: handle.id,
			logPath: log.path,
		},
	};
}

export function createTaskTool(
	options: TaskToolOptions,
): AgentTool<typeof backgroundParameters, TaskToolDetails> {
	const agents = options.agents ?? [];
	const { jobs } = options;
	const agentList =
		agents.length > 0
			? `\n\nAvailable agent types:\n${agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")}`
			: "";
	const backgroundHint = jobs
		? " Set background=true for independent work that can run while you continue elsewhere."
		: "";

	return {
		name: "task",
		label: "Task",
		mutates: true,
		description:
			"Launch a subagent in a separate process to handle a self-contained task. " +
			"The subagent works with its own context and tools, and returns its final report. " +
			`Use for parallelizable or context-heavy work (broad searches, independent subtasks).${backgroundHint}` +
			agentList,
		// Without a registry the schema omits `background` (optional there anyway),
		// so exposing the wider type to callers is safe.
		parameters: jobs ? backgroundParameters : (foregroundParameters as typeof backgroundParameters),
		async execute(
			_id,
			params: TaskToolInput,
			signal,
			onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		): Promise<AgentToolResult<TaskToolDetails>> {
			const agentDef = params.agent ? agents.find((a) => a.name === params.agent) : undefined;
			if (params.agent && !agentDef) {
				throw new Error(
					`Unknown agent type: ${params.agent}. Available: ${agents.map((a) => a.name).join(", ") || "(none)"}`,
				);
			}
			if (params.background && jobs) {
				return executeBackground(options, params, agentDef, jobs);
			}
			return executeForeground(options, params, agentDef, signal, onUpdate);
		},
	};
}
