/**
 * Project context files: AGENTS.md / CLAUDE.md discovery and loading.
 *
 * Follows the convention shared by pi, opencode, and Claude Code: a global
 * context file in the agent home directory applies first, then ancestor
 * directories from the filesystem root down to the cwd — closer files come
 * later so they carry more weight with the model.
 */
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ContextFile {
	path: string;
	content: string;
}

export interface ContextFileOptions {
	/** Agent home directory holding the global context file. Default: ~/.arbor */
	homeDir?: string;
	/** Candidate filenames, first match per directory wins. */
	filenames?: string[];
}

const DEFAULT_FILENAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function loadFromDir(dir: string, filenames: string[]): ContextFile | null {
	for (const filename of filenames) {
		const filePath = path.join(dir, filename);
		try {
			const content = readFileSync(filePath, "utf-8");
			return { path: filePath, content };
		} catch {
			// Missing or unreadable — try the next candidate.
		}
	}
	return null;
}

/**
 * Load context files for a workspace: global (~/.arbor/AGENTS.md) first,
 * then ancestors of cwd ordered root → cwd. Duplicate paths are skipped.
 */
export function loadContextFiles(cwd: string, options: ContextFileOptions = {}): ContextFile[] {
	const filenames = options.filenames ?? DEFAULT_FILENAMES;
	const homeDir = options.homeDir ?? path.join(os.homedir(), ".arbor");
	const resolvedCwd = path.resolve(cwd);

	const files: ContextFile[] = [];
	const seen = new Set<string>();

	const global = loadFromDir(homeDir, filenames);
	if (global) {
		files.push(global);
		seen.add(global.path);
	}

	const ancestors: ContextFile[] = [];
	let current = resolvedCwd;
	while (true) {
		const file = loadFromDir(current, filenames);
		if (file && !seen.has(file.path)) {
			ancestors.unshift(file);
			seen.add(file.path);
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	files.push(...ancestors);
	return files;
}

/** Render context files as a system prompt section. Empty input → empty string. */
export function contextFilesPromptSection(files: ContextFile[]): string {
	if (files.length === 0) return "";
	const sections = files.map((file) => `## Context from ${file.path}\n\n${file.content.trim()}`);
	return `# Project context\n\n${sections.join("\n\n")}`;
}
