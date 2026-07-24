/**
 * Large tool output persistence: results over a size threshold are written
 * to disk and replaced with a head preview plus the file path, so oversized
 * outputs never flood the context. The model reads the full file with the
 * read tool when needed.
 *
 * Built-in tools already tail-truncate, so this mainly protects MCP and
 * extension tools, which have no internal limits.
 */
import { mkdirSync } from "node:fs";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "../types.ts";

export interface OutputPersistenceOptions {
	/** Directory for persisted outputs. */
	root: string;
	/** Size threshold in bytes. Default 50 KiB. */
	thresholdBytes?: number;
	/** Preview size in bytes kept in the conversation. Default 2 KiB. */
	previewBytes?: number;
}

export const DEFAULT_PERSIST_THRESHOLD_BYTES = 50 * 1024;
export const DEFAULT_PERSIST_PREVIEW_BYTES = 2 * 1024;

export function defaultToolOutputsRoot(): string {
	return path.join(os.homedir(), ".arbor", "tool-outputs");
}

function totalTextBytes(content: AgentToolResult["content"]): number | null {
	let total = 0;
	for (const block of content) {
		if (block.type !== "text") return null; // image blocks are never persisted
		total += Buffer.byteLength(block.text, "utf-8");
	}
	return total;
}

/**
 * Persist an oversized text result and build the replacement message.
 * Uses the `wx` flag: a tool call id is unique, so an existing file means
 * this result was already persisted (idempotent across retries).
 */
async function persistResult(
	result: AgentToolResult,
	toolCallId: string,
	options: Required<OutputPersistenceOptions>,
): Promise<AgentToolResult> {
	const full = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	const filePath = path.join(options.root, `${toolCallId}.txt`);
	mkdirSync(options.root, { recursive: true });
	try {
		await writeFile(filePath, full, { encoding: "utf-8", flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			return result; // Persistence failure must not break the tool result.
		}
	}
	const preview = full.slice(0, options.previewBytes);
	const text = [
		`[Output too large (${Math.round(full.length / 1024)}KB). Full output saved to: ${filePath} — read it with the read tool.]`,
		"",
		`Preview (first ${Math.round(options.previewBytes / 1024)}KB):`,
		preview,
		"…",
	].join("\n");
	return {
		...result,
		content: [{ type: "text", text }],
		details: { ...(result.details as object), persistedPath: filePath },
	};
}

/** Wrap one tool so oversized text results are persisted to disk. */
export function withOutputPersistence<T extends AgentTool<any, any>>(
	tool: T,
	options: OutputPersistenceOptions,
): T {
	const resolved: Required<OutputPersistenceOptions> = {
		root: options.root,
		thresholdBytes: options.thresholdBytes ?? DEFAULT_PERSIST_THRESHOLD_BYTES,
		previewBytes: options.previewBytes ?? DEFAULT_PERSIST_PREVIEW_BYTES,
	};
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate) {
			const result = await tool.execute(toolCallId, params, signal, onUpdate);
			const size = totalTextBytes(result.content);
			if (size === null || size <= resolved.thresholdBytes) return result;
			return persistResult(result, toolCallId, resolved);
		},
	};
}

/** Wrap a tool list with output persistence. */
export function persistLargeOutputs(
	tools: AgentTool<any>[],
	options: OutputPersistenceOptions,
): AgentTool<any>[] {
	return tools.map((tool) => withOutputPersistence(tool, options));
}

/** Delete persisted outputs older than `maxAgeDays` to bound disk usage. */
export async function pruneToolOutputs(root?: string, maxAgeDays = 7): Promise<number> {
	const dir = root ?? defaultToolOutputsRoot();
	const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
	const files = await readdir(dir).catch(() => []);
	let removed = 0;
	for (const file of files) {
		if (!file.endsWith(".txt")) continue;
		const filePath = path.join(dir, file);
		const fileStat = await stat(filePath).catch(() => null);
		if (fileStat?.isFile() && fileStat.mtimeMs < cutoff) {
			await rm(filePath, { force: true });
			removed++;
		}
	}
	return removed;
}
