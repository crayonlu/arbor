import type { AgentTool } from "@arbor-space/core";
import {
	AgentSession,
	BackgroundJobs,
	type ExtensionUi,
	type SessionManager,
	SnapshotManager,
} from "@arbor-space/core";
import { readConfig, readModelsToml, registerCustomProviders } from "@arbor-space/core/config";
import { createCodingTools } from "@arbor-space/core/tools";
import type { Model, MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AppMode } from "./app-mode.ts";
import type { Args } from "./args.ts";

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

export async function buildSession(input: BuildSessionInput): Promise<BuiltSession> {
	const { cwd, args, sessionManager } = input;

	const models = builtinModels();
	const modelsToml = readModelsToml();
	await registerCustomProviders(models, modelsToml);

	const model = resolveModel(args, models, modelsToml.default_model);
	const streamFn = (m: Model<any>, context: unknown, options: unknown) =>
		models.streamSimple(m, context as never, options as never);

	const config = readConfig();
	const jobs = new BackgroundJobs();

	const holder: { session: AgentSession | null } = { session: null };
	const tools = createCodingTools(cwd, {
		bash: {
			jobs,
			autoBackground: {
				steeringPending: () => holder.session?.hasPendingSteering() ?? false,
				...(config.bash?.auto_background_threshold_ms !== undefined
					? { thresholdMs: config.bash.auto_background_threshold_ms }
					: {}),
			},
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
		...(input.ui ? { ui: input.ui } : {}),
		...(args.noContextFiles ? { contextFiles: false as const } : {}),
	});
	holder.session = session;

	return { session, models, jobs };
}

function resolveModel(args: Args, models: MutableModels, defaultModel: string): Model<any> {
	const raw = args.model ?? process.env.ARBOR_MODEL ?? defaultModel;
	if (!raw) {
		const all = models.getModels();
		const sensible = all.find(
			(m) => m.provider === "anthropic" || m.provider === "openai" || m.provider === "deepseek",
		);
		if (sensible) return sensible;
		if (all[0]) return all[0];
		throw new Error("No model configured. Type /model select to choose a model.");
	}
	let provider = args.provider;
	let modelId = raw;
	const slash = raw.indexOf("/");
	if (slash !== -1) {
		provider = raw.slice(0, slash);
		modelId = raw.slice(slash + 1);
	}
	if (!provider) {
		throw new Error("No provider. Use --model <provider/id> or set ARBOR_MODEL env var.");
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
