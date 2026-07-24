import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	createProvider,
	envApiKeyAuth,
	type MutableModels,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { parse, stringify, type TomlPrimitive } from "smol-toml";

const ARBOR_DIR = `${homedir()}/.arbor`;

export interface ArborConfig {
	ui?: {
		diff_view?: "auto" | "split" | "unified";
		syntax_highlighting?: boolean;
	};
	bash?: {
		default_timeout_ms?: number;
		max_timeout_ms?: number;
		auto_background_threshold_ms?: number;
	};
}

export const DEFAULT_CONFIG: ArborConfig = {
	ui: { diff_view: "auto", syntax_highlighting: true },
	bash: { default_timeout_ms: 120_000, max_timeout_ms: 600_000, auto_background_threshold_ms: 60_000 },
};

export interface TomlModel {
	id: string;
	name: string;
	reasoning?: boolean;
	context_window?: number;
	max_tokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
	input_modalities?: ("text" | "image")[];
	thinking_levels?: string[];
}

export interface TomlProvider {
	name: string;
	api_type: string;
	base_url: string;
	auth_env?: string;
	headers?: Record<string, string>;
	models: TomlModel[];
}

export interface ModelsToml {
	default_model: string;
	provider?: Record<string, Partial<TomlProvider>>;
}

const CONFIG_HEADER =
	"#:schema https://raw.githubusercontent.com/crayonlu/arbor/main/schemas/config.schema.json\n";
const MODELS_HEADER =
	"#:schema https://raw.githubusercontent.com/crayonlu/arbor/main/schemas/models.schema.json\n";

const API_TYPE_IMPORTS: Record<string, () => Promise<ProviderStreams>> = {
	"openai-completions": () =>
		import("@earendil-works/pi-ai/api/openai-completions.lazy").then((m) => m.openAICompletionsApi()),
	"openai-responses": () =>
		import("@earendil-works/pi-ai/api/openai-responses.lazy").then((m) => m.openAIResponsesApi()),
	"openai-codex-responses": () =>
		import("@earendil-works/pi-ai/api/openai-codex-responses.lazy").then((m) => m.openAICodexResponsesApi()),
	"azure-openai-responses": () =>
		import("@earendil-works/pi-ai/api/azure-openai-responses.lazy").then((m) => m.azureOpenAIResponsesApi()),
	"anthropic-messages": () =>
		import("@earendil-works/pi-ai/api/anthropic-messages.lazy").then((m) => m.anthropicMessagesApi()),
	"google-generative-ai": () =>
		import("@earendil-works/pi-ai/api/google-generative-ai.lazy").then((m) => m.googleGenerativeAIApi()),
	"bedrock-converse-stream": () =>
		import("@earendil-works/pi-ai/api/bedrock-converse-stream.lazy").then((m) =>
			m.bedrockConverseStreamApi(),
		),
};

export function arborDir(): string {
	return ARBOR_DIR;
}

function ensureDir(filePath: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
}

function readToml<T>(filePath: string, fallback: T): T {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const firstNewline = raw.indexOf("\n");
		const content = firstNewline >= 0 && raw.startsWith("#:schema") ? raw.slice(firstNewline + 1) : raw;
		return parse(content) as T;
	} catch {
		return fallback;
	}
}

function writeToml<T extends Record<string, unknown>>(filePath: string, header: string, data: T): void {
	ensureDir(filePath);
	writeFileSync(filePath, header + stringify(data as Record<string, TomlPrimitive>));
}

export function readConfig(): ArborConfig {
	const path = `${ARBOR_DIR}/config.toml`;
	const config = readToml<ArborConfig>(path, {});
	return { ...DEFAULT_CONFIG, ...config };
}

export function ensureConfigFile(): void {
	const path = `${ARBOR_DIR}/config.toml`;
	try {
		readFileSync(path);
	} catch {
		writeToml(path, CONFIG_HEADER, DEFAULT_CONFIG as Record<string, unknown>);
	}
}

export function writeConfig(config: ArborConfig): void {
	const path = `${ARBOR_DIR}/config.toml`;
	writeToml(path, CONFIG_HEADER, { ...DEFAULT_CONFIG, ...config } as Record<string, unknown>);
}

export function readModelsToml(): ModelsToml {
	const path = `${ARBOR_DIR}/models.toml`;
	return readToml<ModelsToml>(path, { default_model: "" });
}

export function ensureModelsToml(): void {
	const path = `${ARBOR_DIR}/models.toml`;
	try {
		readFileSync(path);
	} catch {
		const content = `${MODELS_HEADER}
default_model = ""

# Built-in providers from pi-ai are always available.
# Add custom providers below as [provider.<id>] blocks.
`;
		ensureDir(path);
		writeFileSync(path, content);
	}
}

export function writeModelsToml(toml: ModelsToml): void {
	const path = `${ARBOR_DIR}/models.toml`;
	const header = MODELS_HEADER;
	const content = `${header}
default_model = "${toml.default_model}"

# Built-in providers from pi-ai are always available.
# Add custom providers below as [provider.<id>] blocks.
`;
	ensureDir(path);
	writeFileSync(path, content);
	for (const [id, provider] of Object.entries(toml.provider ?? {})) {
		if (!provider) continue;
		writeProviderToml(path, id, provider);
	}
}

function writeProviderToml(filePath: string, id: string, provider: Partial<TomlProvider>): void {
	let block = `\n[provider.${id}]\nname = "${provider.name ?? id}"\napi_type = "${provider.api_type ?? "openai-completions"}"\nbase_url = "${provider.base_url ?? ""}"\n`;
	if (provider.auth_env) block += `auth_env = "${provider.auth_env}"\n`;
	if (provider.headers) {
		for (const [k, v] of Object.entries(provider.headers)) {
			block += `\n[provider.${id}.headers]\n${k} = "${v}"\n`;
		}
	}
	for (const model of provider.models ?? []) {
		block += `\n[[provider.${id}.models]]\nid = "${model.id}"\nname = "${model.name}"\n`;
		if (model.reasoning) block += "reasoning = true\n";
		if (model.context_window) block += `context_window = ${model.context_window}\n`;
		if (model.max_tokens) block += `max_tokens = ${model.max_tokens}\n`;
		if (model.cost) {
			block += `\n[provider.${id}.models.cost]\n`;
			if (model.cost.input !== undefined) block += `input = ${model.cost.input}\n`;
			if (model.cost.output !== undefined) block += `output = ${model.cost.output}\n`;
			if (model.cost.cache_read !== undefined) block += `cache_read = ${model.cost.cache_read}\n`;
			if (model.cost.cache_write !== undefined) block += `cache_write = ${model.cost.cache_write}\n`;
		}
		if (model.input_modalities?.length)
			block += `input_modalities = [${model.input_modalities.map((m) => `"${m}"`).join(", ")}]\n`;
		if (model.thinking_levels?.length)
			block += `thinking_levels = [${model.thinking_levels.map((l) => `"${l}"`).join(", ")}]\n`;
	}
	writeFileSync(filePath, block, { flag: "a" });
}

function toPiModel(providerId: string, baseUrl: string, api: Api, model: TomlModel): Model<Api> {
	return {
		id: model.id,
		name: model.name,
		api: api as never,
		provider: providerId as never,
		baseUrl,
		reasoning: model.reasoning ?? false,
		input: model.input_modalities ?? ["text"],
		cost: {
			input: model.cost?.input ?? 0,
			output: model.cost?.output ?? 0,
			cacheRead: model.cost?.cache_read ?? 0,
			cacheWrite: model.cost?.cache_write ?? 0,
		},
		contextWindow: model.context_window ?? 200_000,
		maxTokens: model.max_tokens ?? 8_192,
	};
}

export async function registerCustomProviders(models: MutableModels, toml: ModelsToml): Promise<void> {
	for (const [id, provider] of Object.entries(toml.provider ?? {})) {
		if (!provider?.models?.length) continue;
		const apiType = provider.api_type ?? "openai-completions";
		const loadApi = API_TYPE_IMPORTS[apiType];
		if (!loadApi) continue;
		const baseUrl = provider.base_url ?? "";
		const api: Api = apiType as Api;

		const piModels: Model<Api>[] = provider.models.map((m) => toPiModel(id, baseUrl, api, m));

		const authEnv = provider.auth_env;
		const providerObj = createProvider({
			id,
			name: provider.name ?? id,
			baseUrl,
			auth: {
				apiKey: authEnv
					? envApiKeyAuth(`${provider.name ?? id} API key`, [authEnv])
					: envApiKeyAuth(`${provider.name ?? id} API key`, []),
			},
			models: piModels,
			api: await loadApi(),
		});

		models.setProvider(providerObj);
	}
}
