/**
 * grep tool: regex search across workspace files using the shared walker.
 * Prefers ripgrep when available on PATH; falls back to a pure-JS scan.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { globToRegex } from "./glob.ts";
import { resolveToCwd } from "./paths.ts";
import { truncateHead, truncationNotice } from "./truncate.ts";
import { looksBinary, walkFiles } from "./walker.ts";

const MAX_LINE_LENGTH = 500;
const DEFAULT_LIMIT = 100;

const parameters = Type.Object({
	pattern: Type.String({ description: "Regular expression to search for (Rust/JS regex syntax)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: workspace root)" })),
	glob: Type.Optional(Type.String({ description: 'Filter files by glob, e.g. "*.ts" or "src/**/*.py"' })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
	context: Type.Optional(
		Type.Number({ description: "Lines of context around each match", minimum: 0, maximum: 10 }),
	),
	limit: Type.Optional(
		Type.Number({ description: `Maximum matches to return (default ${DEFAULT_LIMIT})`, minimum: 1 }),
	),
});

export type GrepToolInput = Static<typeof parameters>;

export interface GrepToolDetails {
	pattern: string;
	matchCount: number;
	limitHit: boolean;
	engine: "ripgrep" | "js";
}

let ripgrepAvailable: boolean | undefined;

async function hasRipgrep(): Promise<boolean> {
	if (ripgrepAvailable !== undefined) return ripgrepAvailable;
	ripgrepAvailable = await new Promise<boolean>((resolve) => {
		const child = spawn("rg", ["--version"], { stdio: "ignore" });
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});
	return ripgrepAvailable;
}

function clampLine(line: string): string {
	return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
}

interface GrepArgs {
	pattern: string;
	searchPath: string;
	glob?: string;
	ignoreCase?: boolean;
	context?: number;
	limit: number;
}

async function runRipgrep(
	args: GrepArgs,
	signal?: AbortSignal,
): Promise<{ output: string; matchCount: number }> {
	const rgArgs = ["--line-number", "--no-heading", "--color=never", `--max-count=${args.limit}`];
	if (args.ignoreCase) rgArgs.push("--ignore-case");
	if (args.context) rgArgs.push(`--context=${args.context}`);
	if (args.glob) rgArgs.push("--glob", args.glob.includes("/") ? args.glob : `**/${args.glob}`);
	rgArgs.push("--regexp", args.pattern, args.searchPath);

	return new Promise((resolve, reject) => {
		const child = spawn("rg", rgArgs, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c: Buffer) => {
			stdout += c.toString("utf-8");
		});
		child.stderr.on("data", (c: Buffer) => {
			stderr += c.toString("utf-8");
		});
		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (error) => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			if (code === 0 || code === 1) {
				const matchCount =
					stdout.length === 0
						? 0
						: stdout
								.trimEnd()
								.split("\n")
								.filter((l) => /:\d+:/.test(l)).length;
				resolve({ output: stdout, matchCount });
			} else {
				reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
			}
		});
	});
}

async function runJsGrep(
	args: GrepArgs,
	signal?: AbortSignal,
): Promise<{ output: string; matchCount: number }> {
	const regex = new RegExp(args.pattern, args.ignoreCase ? "i" : "");
	const globRegex = args.glob ? globToRegex(args.glob) : undefined;
	const lines: string[] = [];
	let matchCount = 0;

	const files = walkFiles(args.searchPath, { signal: signal as AbortSignal });
	for await (const file of files) {
		if (matchCount >= args.limit) break;
		if (globRegex && !globRegex.test(file.relativePath)) continue;
		const buffer = await readFile(file.absolutePath).catch(() => null);
		if (!buffer || looksBinary(buffer)) continue;
		const fileLines = buffer.toString("utf-8").split("\n");
		for (let i = 0; i < fileLines.length && matchCount < args.limit; i++) {
			const line = fileLines[i] as string;
			if (!regex.test(line)) continue;
			matchCount++;
			const ctx = args.context ?? 0;
			for (let j = Math.max(0, i - ctx); j <= Math.min(fileLines.length - 1, i + ctx); j++) {
				const sep = j === i ? ":" : "-";
				lines.push(`${file.relativePath}${sep}${j + 1}${sep}${clampLine(fileLines[j] as string)}`);
			}
		}
	}
	return { output: lines.length > 0 ? `${lines.join("\n")}\n` : "", matchCount };
}

export function createGrepTool(cwd: string): AgentTool<typeof parameters, GrepToolDetails> {
	return {
		name: "grep",
		label: "Grep",
		description:
			"Search file contents with a regular expression. Returns file:line:content matches. " +
			"Use glob to filter files and context to include surrounding lines.",
		parameters,
		async execute(_id, params, signal): Promise<AgentToolResult<GrepToolDetails>> {
			const searchPath = resolveToCwd(params.path ?? ".", cwd);
			const limit = params.limit ?? DEFAULT_LIMIT;
			const args: GrepArgs = {
				pattern: params.pattern,
				searchPath,
				limit,
				...(params.glob !== undefined ? { glob: params.glob } : {}),
				...(params.ignoreCase !== undefined ? { ignoreCase: params.ignoreCase } : {}),
				...(params.context !== undefined ? { context: params.context } : {}),
			};

			const engine: GrepToolDetails["engine"] = (await hasRipgrep()) ? "ripgrep" : "js";
			const { output, matchCount } =
				engine === "ripgrep" ? await runRipgrep(args, signal) : await runJsGrep(args, signal);

			if (matchCount === 0) {
				return {
					content: [{ type: "text", text: "No matches found." }],
					details: { pattern: params.pattern, matchCount: 0, limitHit: false, engine },
				};
			}

			const truncation = truncateHead(output);
			const limitHit = matchCount >= limit;
			let text = truncation.truncated ? `${truncation.content}${truncationNotice(truncation)}` : output;
			if (limitHit) {
				text += `\n[Match limit ${limit} reached; refine the pattern or raise limit.]`;
			}
			return {
				content: [{ type: "text", text }],
				details: { pattern: params.pattern, matchCount, limitHit, engine },
			};
		},
	};
}
