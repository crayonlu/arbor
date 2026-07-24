/**
 * ls tool: list a directory with type and size annotations.
 */
import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { type Static, Type } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { displayPath, resolveToCwd } from "./paths.ts";
import { formatSize, truncateHead, truncationNotice } from "./truncate.ts";

const parameters = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: workspace root)" })),
	all: Type.Optional(Type.Boolean({ description: "Include dotfiles (default: false)" })),
});

export type LsToolInput = Static<typeof parameters>;

export interface LsToolDetails {
	path: string;
	entryCount: number;
}

export function createLsTool(cwd: string): AgentTool<typeof parameters, LsToolDetails> {
	return {
		name: "ls",
		label: "List",
		description:
			"List a directory. Directories are suffixed with / and files annotated with size. Dotfiles are hidden unless all=true.",
		parameters,
		async execute(_id, params): Promise<AgentToolResult<LsToolDetails>> {
			const absolutePath = resolveToCwd(params.path ?? ".", cwd);
			const dirStat = await stat(absolutePath).catch(() => {
				throw new Error(`Directory not found: ${displayPath(absolutePath, cwd)}`);
			});
			if (!dirStat.isDirectory()) {
				throw new Error(`${displayPath(absolutePath, cwd)} is a file. Use read instead.`);
			}

			const entries = await readdir(absolutePath, { withFileTypes: true });
			entries.sort((a, b) => {
				// Directories first, then files, each alphabetically.
				if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
				return a.name.localeCompare(b.name);
			});

			const lines: string[] = [];
			for (const entry of entries) {
				if (!params.all && entry.name.startsWith(".")) continue;
				if (entry.isDirectory()) {
					lines.push(`${entry.name}/`);
				} else {
					const fileStat = await stat(path.join(absolutePath, entry.name)).catch(() => null);
					lines.push(fileStat ? `${entry.name} (${formatSize(fileStat.size)})` : entry.name);
				}
			}

			if (lines.length === 0) {
				return {
					content: [{ type: "text", text: "(empty directory)" }],
					details: { path: absolutePath, entryCount: 0 },
				};
			}

			const output = `${lines.join("\n")}\n`;
			const truncation = truncateHead(output);
			const text = truncation.truncated ? `${truncation.content}${truncationNotice(truncation)}` : output;
			return {
				content: [{ type: "text", text }],
				details: { path: absolutePath, entryCount: lines.length },
			};
		},
	};
}
