/**
 * Subagent child entry: run one prompt headlessly and stream SubagentEvents
 * as JSONL on stdout. Invoked as:
 *
 *   node --experimental-strip-types entry.ts '<SubagentConfig JSON>'
 *
 * The task tool spawns this; the CLI's `--json -p` mode reuses the same
 * event emission so every arbor process speaks the same protocol.
 */
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { contextFilesPromptSection, loadContextFiles } from "../context-files.ts";
import { agentLoop } from "../loop.ts";
import { filterToolsForMode, modePromptSection } from "../modes.ts";
import { createCodingTools } from "../tools/index.ts";
import type { AgentMessage, AgentTool, StreamFn } from "../types.ts";
import { encodeEvent, type SubagentConfig, type SubagentEvent } from "./protocol.ts";

function write(event: SubagentEvent): void {
	process.stdout.write(encodeEvent(event));
}

function summarizeToolResult(result: { content: { type: string; text?: string }[] }): string {
	const text = result.content
		.map((c) => (c.type === "text" ? (c.text ?? "") : "[image]"))
		.join(" ")
		.replaceAll("\n", " ");
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export async function runSubagent(config: SubagentConfig): Promise<void> {
	const models = builtinModels();
	const model = models.getModel(config.provider, config.modelId);
	if (!model) {
		write({ type: "fatal", error: `Unknown model: ${config.provider}/${config.modelId}` });
		process.exitCode = 1;
		return;
	}

	const streamFn: StreamFn = (m, context, options) => models.streamSimple(m, context, options);
	let tools: AgentTool<any>[] = createCodingTools(config.cwd);
	if (config.tools) {
		const allowed = new Set(config.tools);
		tools = tools.filter((t) => allowed.has(t.name));
	}
	const mode = config.mode ?? "build";
	tools = filterToolsForMode(tools, mode);

	const systemPrompt = [
		config.systemPrompt ??
			`You are a focused subagent working in ${config.cwd}. Complete the task and report your findings as your final message. Your final text IS the result returned to the caller — make it complete and self-contained.`,
		contextFilesPromptSection(loadContextFiles(config.cwd)),
		modePromptSection(mode),
	]
		.filter((s) => s.length > 0)
		.join("\n\n");

	write({ type: "ready" });

	const prompt: AgentMessage = { role: "user", content: config.prompt, timestamp: Date.now() };
	const stream = agentLoop(
		[prompt],
		{ systemPrompt, messages: [], tools },
		{ model, convertToLlm: (messages) => messages as never },
		streamFn,
	);

	let finalText = "";
	let isError = false;
	let messageCount = 0;

	for await (const event of stream) {
		switch (event.type) {
			case "message_end": {
				messageCount++;
				const message = event.message as { role?: string; content?: unknown; stopReason?: string };
				if (message.role === "assistant") {
					const blocks = message.content as { type: string; text?: string }[];
					const text = blocks
						.filter((b) => b.type === "text")
						.map((b) => b.text ?? "")
						.join("\n");
					if (text.length > 0) {
						finalText = text;
						write({ type: "text", text });
					}
					if (message.stopReason === "error" || message.stopReason === "aborted") {
						isError = true;
					}
				}
				break;
			}
			case "tool_execution_end":
				write({
					type: "tool",
					toolName: event.toolName,
					summary: summarizeToolResult(event.result as never),
					isError: event.isError,
				});
				break;
			default:
				break;
		}
	}

	await stream.result();
	write({ type: "result", text: finalText, messageCount, isError });
	if (isError) process.exitCode = 1;
}

// Direct invocation: config JSON is argv[2].
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").at(-1) ?? "");
if (isMain && process.argv[2]) {
	let config: SubagentConfig;
	try {
		config = JSON.parse(process.argv[2]) as SubagentConfig;
	} catch (error) {
		write({ type: "fatal", error: `Invalid config JSON: ${error instanceof Error ? error.message : error}` });
		process.exit(1);
	}
	runSubagent(config).catch((error) => {
		write({ type: "fatal", error: error instanceof Error ? error.message : String(error) });
		process.exit(1);
	});
}
