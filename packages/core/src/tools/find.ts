/**
 * find tool: locate files by glob pattern using the shared walker.
 */
import { type Static, Type } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { globToRegex } from "./glob.ts";
import { resolveToCwd } from "./paths.ts";
import { truncateHead, truncationNotice } from "./truncate.ts";
import { walkFiles } from "./walker.ts";

const DEFAULT_LIMIT = 500;

const parameters = Type.Object({
	pattern: Type.String({
		description: 'Glob pattern to match file paths, e.g. "*.ts", "src/**/*.test.ts", "**/README.md"',
	}),
	path: Type.Optional(Type.String({ description: "Directory to search (default: workspace root)" })),
	limit: Type.Optional(
		Type.Number({ description: `Maximum results (default ${DEFAULT_LIMIT})`, minimum: 1 }),
	),
});

export type FindToolInput = Static<typeof parameters>;

export interface FindToolDetails {
	pattern: string;
	matchCount: number;
	limitHit: boolean;
}

export function createFindTool(cwd: string): AgentTool<typeof parameters, FindToolDetails> {
	return {
		name: "find",
		label: "Find",
		description:
			"Find files by glob pattern. Bare patterns like *.ts match at any depth; path patterns like src/**/*.ts are anchored to the search root. Results are sorted.",
		parameters,
		async execute(_id, params, signal): Promise<AgentToolResult<FindToolDetails>> {
			const searchPath = resolveToCwd(params.path ?? ".", cwd);
			const limit = params.limit ?? DEFAULT_LIMIT;
			const regex = globToRegex(params.pattern);

			const matches: string[] = [];
			let limitHit = false;
			for await (const file of walkFiles(searchPath, signal ? { signal } : {})) {
				if (regex.test(file.relativePath)) {
					matches.push(file.relativePath);
					if (matches.length >= limit) {
						limitHit = true;
						break;
					}
				}
			}

			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: `No files matching "${params.pattern}".` }],
					details: { pattern: params.pattern, matchCount: 0, limitHit: false },
				};
			}

			const output = `${matches.join("\n")}\n`;
			const truncation = truncateHead(output);
			let text = truncation.truncated ? `${truncation.content}${truncationNotice(truncation)}` : output;
			if (limitHit) {
				text += `[Result limit ${limit} reached; narrow the pattern or raise limit.]`;
			}
			return {
				content: [{ type: "text", text }],
				details: { pattern: params.pattern, matchCount: matches.length, limitHit },
			};
		},
	};
}
