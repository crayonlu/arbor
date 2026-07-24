/**
 * edit tool: exact-string replacements against the original file content.
 *
 * Multiple edits are matched against the original content (not incrementally)
 * so their spans must not overlap. Line endings are normalized to LF for
 * matching and restored on write. A unified diff is produced for the result.
 */
import { readFile, writeFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { displayPath, resolveToCwd } from "./paths.ts";

const editSchema = Type.Object({
	oldText: Type.String({
		description:
			"Exact text to replace. Must appear exactly once in the file and must not overlap other edits in the same call.",
	}),
	newText: Type.String({ description: "Replacement text." }),
});

const parameters = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(editSchema, {
		description:
			"One or more exact-string replacements. Each edit is matched against the original file content, not incrementally.",
		minItems: 1,
	}),
});

export type EditToolInput = Static<typeof parameters>;

export interface EditToolDetails {
	path: string;
	editCount: number;
	/** Unified diff of the change. */
	diff: string;
	firstChangedLine: number;
}

interface MatchedEdit {
	start: number;
	end: number;
	newText: string;
}

export function detectLineEnding(content: string): "\n" | "\r\n" {
	const crlf = (content.match(/\r\n/g) ?? []).length;
	const lf = (content.match(/(?<!\r)\n/g) ?? []).length;
	return crlf > lf ? "\r\n" : "\n";
}

export function normalizeToLF(content: string): string {
	return content.replaceAll("\r\n", "\n");
}

/**
 * Locate each edit in the original content. Throws with a model-actionable
 * message when an oldText is missing, ambiguous, or overlaps another edit.
 */
export function matchEdits(content: string, edits: { oldText: string; newText: string }[]): MatchedEdit[] {
	const matched: MatchedEdit[] = [];
	for (const [index, edit] of edits.entries()) {
		if (edit.oldText.length === 0) {
			throw new Error(`edits[${index}].oldText is empty. Provide the exact text to replace.`);
		}
		if (edit.oldText === edit.newText) {
			throw new Error(`edits[${index}] oldText and newText are identical; nothing to change.`);
		}
		const first = content.indexOf(edit.oldText);
		if (first === -1) {
			throw new Error(
				`edits[${index}].oldText not found in the file. Ensure the text matches exactly, including whitespace and indentation.`,
			);
		}
		if (content.indexOf(edit.oldText, first + 1) !== -1) {
			throw new Error(
				`edits[${index}].oldText matches multiple locations. Add surrounding context to make it unique.`,
			);
		}
		matched.push({ start: first, end: first + edit.oldText.length, newText: edit.newText });
	}

	matched.sort((a, b) => a.start - b.start);
	for (let i = 1; i < matched.length; i++) {
		const prev = matched[i - 1] as MatchedEdit;
		const curr = matched[i] as MatchedEdit;
		if (curr.start < prev.end) {
			throw new Error(
				"Two edits overlap in the file. Merge overlapping or adjacent changes into a single edit.",
			);
		}
	}
	return matched;
}

/** Apply non-overlapping, sorted matched edits to the content. */
export function applyMatchedEdits(content: string, matched: MatchedEdit[]): string {
	let result = "";
	let cursor = 0;
	for (const edit of matched) {
		result += content.slice(cursor, edit.start) + edit.newText;
		cursor = edit.end;
	}
	return result + content.slice(cursor);
}

/** Minimal unified diff between two texts (no external deps). */
export function unifiedDiff(
	oldText: string,
	newText: string,
	filePath: string,
): {
	diff: string;
	firstChangedLine: number;
} {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");

	// Trim common prefix/suffix for a compact single-hunk diff.
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix++;
	}

	const removed = oldLines.slice(prefix, oldLines.length - suffix);
	const added = newLines.slice(prefix, newLines.length - suffix);
	const contextBefore = oldLines.slice(Math.max(0, prefix - 3), prefix);
	const contextAfter = oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + 3);

	const oldStart = Math.max(1, prefix - 3 + 1);
	const newStart = oldStart;
	const oldCount = contextBefore.length + removed.length + contextAfter.length;
	const newCount = contextBefore.length + added.length + contextAfter.length;

	const lines = [
		`--- a/${filePath}`,
		`+++ b/${filePath}`,
		`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
		...contextBefore.map((l) => ` ${l}`),
		...removed.map((l) => `-${l}`),
		...added.map((l) => `+${l}`),
		...contextAfter.map((l) => ` ${l}`),
	];
	return { diff: `${lines.join("\n")}\n`, firstChangedLine: prefix + 1 };
}

export function createEditTool(cwd: string): AgentTool<typeof parameters, EditToolDetails> {
	return {
		name: "edit",
		label: "Edit",
		mutates: true,
		description:
			"Edit a file with one or more exact-string replacements. Each oldText must match exactly once in the original file; add surrounding context to disambiguate. Edits must not overlap.",
		parameters,
		async execute(_id, params): Promise<AgentToolResult<EditToolDetails>> {
			const absolutePath = resolveToCwd(params.path, cwd);
			const raw = await readFile(absolutePath, "utf-8").catch(() => {
				throw new Error(`File not found: ${displayPath(absolutePath, cwd)}`);
			});

			const lineEnding = detectLineEnding(raw);
			const normalized = normalizeToLF(raw);
			const normalizedEdits = params.edits.map((e) => ({
				oldText: normalizeToLF(e.oldText),
				newText: normalizeToLF(e.newText),
			}));

			const matched = matchEdits(normalized, normalizedEdits);
			const updated = applyMatchedEdits(normalized, matched);
			const output = lineEnding === "\r\n" ? updated.replaceAll("\n", "\r\n") : updated;
			await writeFile(absolutePath, output, "utf-8");

			const rel = displayPath(absolutePath, cwd);
			const { diff, firstChangedLine } = unifiedDiff(normalized, updated, rel);
			return {
				content: [
					{
						type: "text",
						text: `Applied ${params.edits.length} edit${params.edits.length > 1 ? "s" : ""} to ${rel}:\n${diff}`,
					},
				],
				details: { path: absolutePath, editCount: params.edits.length, diff, firstChangedLine },
			};
		},
	};
}
