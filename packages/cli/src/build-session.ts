/**
 * Translate parsed CLI args into a fully-wired AgentSession.
 *
 * Model resolution goes through pi-ai's `builtinModels()`; the stream function
 * is `models.streamSimple`. Tools come from `createCodingTools` with the
 * background-jobs registry wired in (auto-background yields to steering). The
 * UI is supplied by the caller — headless for print, roundtrip for rpc, the
 * TUI bridge for interactive — so this module stays UI-agnostic.
 */

import type { AgentTool } from "@arbor-space/core";
import {
	AgentSession,
	BackgroundJobs,
	type ExtensionUi,
	type SessionManager,
	SnapshotManager,
} from "@arbor-space/core";
import { createCodingTools } from "@arbor-space/core/tools";
import type { Model, MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AppMode } from "./app-mode.ts";
import type { Args } from "./args.ts";

/** Headless UI: notifications are dropped, prompts decline/dismiss. */
export const HEADLESS_UI: ExtensionUi = {
	notify: () => {},
	confirm: async () => false,
	input: async () => undefined,
	select: async () => undefined,
};

export interface BuildSessionInput {
	cwd: string;
	args: Args;
	sessionManager: SessionManager;
	mode: AppMode;
	/** UI bridge. Defaults to headless (print); rpc/interactive supply their own. */
	ui?: ExtensionUi;
}

export interface BuiltSession {
	session: AgentSession;
	models: MutableModels;
	jobs: BackgroundJobs;
}

const DEFAULT_SYSTEM_PROMPT = [
	"You are Arbor, an autonomous coding agent operating in a terminal.",
	"You can read, search, edit, and write files, run bash commands, and manage background jobs.",
	"Work step by step, verify your changes, and prefer minimal, targeted edits.",
].join(" ");

export function buildSession(input: BuildSessionInput): BuiltSession {
	const { cwd, args, sessionManager } = input;

	const models = builtinModels();
	const model = resolveModel(args, models);
	const streamFn = (m: Model<any>, context: unknown, options: unknown) =>
		models.streamSimple(m, context as never, options as never);

	const jobs = new BackgroundJobs();

	// The session is created after tools (tools are a constructor argument),
	// but auto-background needs to ask the session about pending steering —
	// wire it through a holder that is filled once the session exists.
	const holder: { session: AgentSession | null } = { session: null };
	const tools = createCodingTools(cwd, {
		bash: {
			jobs,
			autoBackground: { steeringPending: () => holder.session?.hasPendingSteering() ?? false },
		},
	});
	const filtered = applyToolFilter(tools, args.tools, args.excludeTools);

	const session = new AgentSession({
		cwd,
		model,
		streamFn,
		systemPrompt: buildSystemPrompt(args),
		tools: filtered,
		sessionManager,
		snapshots: new SnapshotManager(cwd),
		jobs,
		// Only pass a UI for interactive/rpc — a real UI enables the ask tool.
		// Print mode omits it so AgentSession uses its internal headless UI and
		// the ask tool is not injected.
		...(input.ui ? { ui: input.ui } : {}),
		...(args.noContextFiles ? { contextFiles: false as const } : {}),
	});
	holder.session = session;

	return { session, models, jobs };
}

function resolveModel(args: Args, models: MutableModels): Model<any> {
	const raw = args.model;
	if (!raw) {
		throw new Error(
			"No model specified. Use --model <provider/id> (e.g. --model anthropic/claude-opus-4-8).",
		);
	}
	let provider = args.provider;
	let modelId = raw;
	const slash = raw.indexOf("/");
	if (slash !== -1) {
		provider = raw.slice(0, slash);
		modelId = raw.slice(slash + 1);
	}
	if (!provider) {
		throw new Error("No provider. Use --provider <name> or --model <provider/id>.");
	}
	const model = models.getModel(provider, modelId);
	if (!model) {
		throw new Error(`Model not found: ${provider}/${modelId}`);
	}
	return model;
}

function buildSystemPrompt(args: Args): string {
	const parts = [args.systemPrompt ?? DEFAULT_SYSTEM_PROMPT];
	if (args.appendSystemPrompt) parts.push(...args.appendSystemPrompt);
	return parts.join("\n\n");
}

function applyToolFilter(tools: AgentTool<any>[], allow?: string[], deny?: string[]): AgentTool<any>[] {
	let result = tools;
	if (allow) {
		const set = new Set(allow);
		result = result.filter((t: AgentTool<any>) => set.has(t.name));
	}
	if (deny) {
		const set = new Set(deny);
		result = result.filter((t: AgentTool<any>) => !set.has(t.name));
	}
	return result;
}
