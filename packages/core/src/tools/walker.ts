/**
 * Filesystem walker shared by grep/find/ls: recursive traversal with default
 * ignores and .gitignore support (root-level patterns; no external deps).
 */
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

/** Directories never worth descending into. */
export const DEFAULT_IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	".hg",
	".svn",
	"__pycache__",
	".venv",
	"venv",
	".cache",
	"dist",
	"build",
	"target",
	".next",
	".turbo",
]);

export interface WalkOptions {
	/** Maximum number of entries to visit (guards runaway walks). */
	maxEntries?: number;
	/** Include ignored directories in traversal. */
	includeIgnored?: boolean;
	signal?: AbortSignal;
}

export interface WalkedFile {
	/** Absolute path. */
	absolutePath: string;
	/** Path relative to the walk root, using forward slashes. */
	relativePath: string;
}

interface GitignoreRule {
	regex: RegExp;
	negated: boolean;
	dirOnly: boolean;
}

/** Convert one .gitignore pattern line to a rule. Supports *, **, ?, anchoring, negation, dir-only. */
export function gitignorePatternToRule(line: string): GitignoreRule | null {
	let pattern = line.trim();
	if (pattern.length === 0 || pattern.startsWith("#")) return null;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	}
	let dirOnly = false;
	if (pattern.endsWith("/")) {
		dirOnly = true;
		pattern = pattern.slice(0, -1);
	}
	const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");
	if (pattern.startsWith("/")) pattern = pattern.slice(1);

	let regexStr = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				regexStr += ".*";
				i++;
				if (pattern[i + 1] === "/") i++;
			} else {
				regexStr += "[^/]*";
			}
		} else if (ch === "?") {
			regexStr += "[^/]";
		} else if (ch !== undefined && "\\^$.|+()[]{}".includes(ch)) {
			regexStr += `\\${ch}`;
		} else {
			regexStr += ch;
		}
	}
	const prefix = anchored ? "^" : "(^|/)";
	return { regex: new RegExp(`${prefix}${regexStr}($|/)`), negated, dirOnly };
}

async function loadGitignore(root: string): Promise<GitignoreRule[]> {
	const content = await readFile(path.join(root, ".gitignore"), "utf-8").catch(() => "");
	return content
		.split("\n")
		.map(gitignorePatternToRule)
		.filter((r): r is GitignoreRule => r !== null);
}

function isIgnoredByRules(relativePath: string, isDir: boolean, rules: GitignoreRule[]): boolean {
	let ignored = false;
	for (const rule of rules) {
		if (rule.dirOnly && !isDir) continue;
		if (rule.regex.test(relativePath)) {
			ignored = !rule.negated;
		}
	}
	return ignored;
}

/**
 * Walk files under `root` depth-first, respecting default ignores and the
 * root .gitignore. Yields files only (directories are traversal detail).
 */
export async function* walkFiles(root: string, options: WalkOptions = {}): AsyncGenerator<WalkedFile> {
	const maxEntries = options.maxEntries ?? 100_000;
	const rules = options.includeIgnored ? [] : await loadGitignore(root);
	let visited = 0;

	async function* walk(dir: string): AsyncGenerator<WalkedFile> {
		if (options.signal?.aborted) return;
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		// Sort for deterministic output: directories and files interleaved by name.
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (options.signal?.aborted || visited >= maxEntries) return;
			visited++;
			const absolutePath = path.join(dir, entry.name);
			const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
			if (entry.isDirectory()) {
				if (!options.includeIgnored && DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
				if (isIgnoredByRules(relativePath, true, rules)) continue;
				yield* walk(absolutePath);
			} else if (entry.isFile()) {
				if (isIgnoredByRules(relativePath, false, rules)) continue;
				yield { absolutePath, relativePath };
			}
		}
	}

	yield* walk(root);
}

/** Heuristic binary check: NUL byte in the first 8KB. */
export function looksBinary(buffer: Buffer): boolean {
	const probe = buffer.subarray(0, 8192);
	return probe.includes(0);
}
