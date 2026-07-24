/**
 * Prompt templates: markdown files that expand into full prompts via
 * /name commands. Filename (minus .md) is the command name. Supports
 * positional arguments: $1..$n, $@ / $ARGUMENTS, ${1:-default}, ${@:N},
 * ${@:N:L}.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "./skills.ts";

export interface PromptTemplate {
	name: string;
	description: string;
	argumentHint?: string;
	/** Template body with argument placeholders. */
	body: string;
	path: string;
}

export interface TemplateDiscoveryOptions {
	cwd: string;
	extraPaths?: string[];
	noDiscovery?: boolean;
	homeDir?: string;
}

async function isDirectory(p: string): Promise<boolean> {
	return stat(p).then(
		(s) => s.isDirectory(),
		() => false,
	);
}

async function loadTemplateFile(filePath: string): Promise<PromptTemplate | null> {
	const content = await readFile(filePath, "utf-8").catch(() => null);
	if (content === null) return null;
	const { frontmatter, body } = parseFrontmatter(content);
	const trimmed = body.trim();
	const description =
		frontmatter.description ??
		trimmed
			.split("\n")
			.find((l) => l.trim().length > 0)
			?.trim() ??
		"";
	const name = path.basename(filePath, ".md");
	return {
		name,
		description,
		...(frontmatter["argument-hint"] !== undefined ? { argumentHint: frontmatter["argument-hint"] } : {}),
		body: trimmed,
		path: filePath,
	};
}

async function collectTemplates(dir: string): Promise<PromptTemplate[]> {
	if (!(await isDirectory(dir))) return [];
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const templates: PromptTemplate[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isFile() && entry.name.endsWith(".md")) {
			const template = await loadTemplateFile(path.join(dir, entry.name));
			if (template) templates.push(template);
		}
	}
	return templates;
}

/**
 * Discover templates: ~/.arbor/prompts (global), <cwd>/.arbor/prompts
 * (project), extraPaths. First occurrence of a name wins, so project
 * templates can be shadowed by global only if global loads first — we load
 * project last to let it override.
 */
export async function discoverTemplates(options: TemplateDiscoveryOptions): Promise<PromptTemplate[]> {
	const home = options.homeDir ?? os.homedir();
	const byName = new Map<string, PromptTemplate>();
	const dirs: string[] = [];
	if (!options.noDiscovery) {
		dirs.push(path.join(home, ".arbor", "prompts"), path.join(options.cwd, ".arbor", "prompts"));
	}
	for (const dir of dirs) {
		for (const template of await collectTemplates(dir)) {
			byName.set(template.name, template); // later dirs (project) override
		}
	}
	for (const extra of options.extraPaths ?? []) {
		const resolved = path.resolve(options.cwd, extra);
		if (await isDirectory(resolved)) {
			for (const template of await collectTemplates(resolved)) {
				byName.set(template.name, template);
			}
		} else if (resolved.endsWith(".md")) {
			const template = await loadTemplateFile(resolved);
			if (template) byName.set(template.name, template);
		}
	}
	return [...byName.values()];
}

/** Split an argument string into shell-like words (quotes respected). */
export function splitArguments(input: string): string[] {
	const args: string[] = [];
	const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match = regex.exec(input);
	while (match !== null) {
		args.push(match[1] ?? match[2] ?? (match[3] as string));
		match = regex.exec(input);
	}
	return args;
}

/**
 * Expand argument placeholders in a template body.
 * Supported: $1..$n, $@, $ARGUMENTS, ${1:-default}, ${@:-d}, ${ARGUMENTS:-d},
 * ${@:N}, ${@:N:L}.
 */
export function expandTemplate(body: string, argsInput: string): string {
	const args = splitArguments(argsInput);
	const all = args.join(" ");

	return (
		body
			// ${@:N:L} and ${@:N}
			.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_m, start: string, len?: string) => {
				const from = Number.parseInt(start, 10) - 1;
				const slice =
					len !== undefined ? args.slice(from, from + Number.parseInt(len, 10)) : args.slice(from);
				return slice.join(" ");
			})
			// ${@:-default} / ${ARGUMENTS:-default}
			.replace(/\$\{(?:@|ARGUMENTS):-([^}]*)\}/g, (_m, def: string) => (all.length > 0 ? all : def))
			// ${N:-default}
			.replace(/\$\{(\d+):-([^}]*)\}/g, (_m, n: string, def: string) => {
				const value = args[Number.parseInt(n, 10) - 1];
				return value !== undefined && value.length > 0 ? value : def;
			})
			// $ARGUMENTS / $@
			.replace(/\$ARGUMENTS|\$@/g, all)
			// $N
			.replace(/\$(\d+)/g, (_m, n: string) => args[Number.parseInt(n, 10) - 1] ?? "")
	);
}
