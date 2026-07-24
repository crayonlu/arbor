/**
 * write tool: create or overwrite a file, creating parent directories.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { type Static, Type } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { displayPath, resolveToCwd } from "./paths.ts";

const parameters = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Full content to write to the file" }),
});

export type WriteToolInput = Static<typeof parameters>;

export interface WriteToolDetails {
	path: string;
	created: boolean;
	bytes: number;
}

export function createWriteTool(cwd: string): AgentTool<typeof parameters, WriteToolDetails> {
	return {
		name: "write",
		label: "Write",
		mutates: true,
		description:
			"Write content to a file, overwriting it if it exists and creating parent directories as needed. For partial changes to existing files, prefer the edit tool.",
		parameters,
		async execute(_id, params): Promise<AgentToolResult<WriteToolDetails>> {
			const absolutePath = resolveToCwd(params.path, cwd);
			const existing = await stat(absolutePath).catch(() => null);
			if (existing?.isDirectory()) {
				throw new Error(`${displayPath(absolutePath, cwd)} is a directory.`);
			}
			await mkdir(path.dirname(absolutePath), { recursive: true });
			await writeFile(absolutePath, params.content, "utf-8");
			const bytes = Buffer.byteLength(params.content, "utf-8");
			return {
				content: [
					{
						type: "text",
						text: `${existing ? "Updated" : "Created"} ${displayPath(absolutePath, cwd)} (${bytes} bytes).`,
					},
				],
				details: { path: absolutePath, created: !existing, bytes },
			};
		},
	};
}
