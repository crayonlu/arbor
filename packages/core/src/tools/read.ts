/**
 * read tool: text files with offset/limit, images returned as image content.
 */
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { type Static, Type } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { displayPath, resolveToCwd } from "./paths.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, truncationNotice } from "./truncate.ts";

const IMAGE_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

const parameters = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(
		Type.Number({ description: "1-based line number to start reading from", minimum: 1 }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read", minimum: 1 })),
});

export type ReadToolInput = Static<typeof parameters>;

export interface ReadToolDetails {
	path: string;
	truncated: boolean;
	totalLines?: number;
	mimeType?: string;
}

export function createReadTool(cwd: string): AgentTool<typeof parameters, ReadToolDetails> {
	return {
		name: "read",
		label: "Read",
		description:
			"Read a file. Returns text content with an optional offset/limit line window. Images (png/jpg/gif/webp) are returned as viewable images. Output is truncated at " +
			`${DEFAULT_MAX_LINES} lines or 50KB; use offset/limit to page through large files.`,
		parameters,
		async execute(_id, params): Promise<AgentToolResult<ReadToolDetails>> {
			const absolutePath = resolveToCwd(params.path, cwd);
			const fileStat = await stat(absolutePath).catch(() => {
				throw new Error(`File not found: ${displayPath(absolutePath, cwd)}`);
			});
			if (fileStat.isDirectory()) {
				throw new Error(`${displayPath(absolutePath, cwd)} is a directory. Use ls instead.`);
			}

			const mimeType = IMAGE_MIME_TYPES[path.extname(absolutePath).toLowerCase()];
			if (mimeType) {
				const data = await readFile(absolutePath);
				return {
					content: [{ type: "image", data: data.toString("base64"), mimeType }],
					details: { path: absolutePath, truncated: false, mimeType },
				};
			}

			const raw = await readFile(absolutePath, "utf-8");
			let text = raw;
			let totalLines = raw.length === 0 ? 0 : raw.split("\n").length;
			if (params.offset !== undefined || params.limit !== undefined) {
				const lines = raw.split("\n");
				totalLines = lines.length;
				const start = (params.offset ?? 1) - 1;
				if (start >= lines.length) {
					throw new Error(`Offset ${params.offset} is beyond the end of the file (${totalLines} lines).`);
				}
				const end = params.limit !== undefined ? start + params.limit : lines.length;
				text = lines.slice(start, end).join("\n");
			}

			const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES });
			const notice = truncationNotice(truncation, "Use offset/limit to read more.");
			return {
				content: [{ type: "text", text: truncation.truncated ? `${truncation.content}${notice}` : text }],
				details: { path: absolutePath, truncated: truncation.truncated, totalLines },
			};
		},
	};
}
