/**
 * Skills: on-demand capability packages per the Agent Skills standard.
 *
 * A skill is a directory containing SKILL.md with `name` and `description`
 * frontmatter. Discovery collects names + descriptions for the system prompt
 * (progressive disclosure); the model loads the full SKILL.md with `read`
 * when a task matches.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface Skill {
	name: string;
	description: string;
	/** Absolute path to the SKILL.md file. */
	path: string;
	/** Directory containing the skill. */
	dir: string;
	/** Hidden from the system prompt; only invokable via /skill:name. */
	disableModelInvocation: boolean;
}

export interface SkillDiscoveryOptions {
	cwd: string;
	/** Extra skill files or directories (settings `skills[]`, CLI --skill). */
	extraPaths?: string[];
	/** Disable default-location discovery (extraPaths still load). */
	noDiscovery?: boolean;
	/** Override the home directory (tests). */
	homeDir?: string;
}

export interface SkillWarning {
	path: string;
	message: string;
}

/** Minimal YAML frontmatter parser: `key: value` lines between --- fences. */
export function parseFrontmatter(content: string): {
	frontmatter: Record<string, string>;
	body: string;
} {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { frontmatter: {}, body: content };
	const frontmatter: Record<string, string> = {};
	for (const line of (match[1] as string).split("\n")) {
		const sep = line.indexOf(":");
		if (sep === -1) continue;
		const key = line.slice(0, sep).trim();
		let value = line.slice(sep + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (key.length > 0) frontmatter[key] = value;
	}
	return { frontmatter, body: content.slice(match[0].length) };
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Parse one SKILL.md file into a Skill, or a warning when invalid. */
export async function loadSkillFile(filePath: string): Promise<Skill | SkillWarning> {
	const content = await readFile(filePath, "utf-8").catch(() => null);
	if (content === null) return { path: filePath, message: "unreadable" };
	const { frontmatter } = parseFrontmatter(content);
	const name = frontmatter.name;
	const description = frontmatter.description;
	if (!name || !description) {
		return { path: filePath, message: "missing required frontmatter: name and description" };
	}
	if (!NAME_PATTERN.test(name) || name.length > 64) {
		return { path: filePath, message: `invalid skill name: ${name}` };
	}
	if (description.length > 1024) {
		return { path: filePath, message: "description exceeds 1024 characters" };
	}
	return {
		name,
		description,
		path: filePath,
		dir: path.dirname(filePath),
		disableModelInvocation: frontmatter["disable-model-invocation"] === "true",
	};
}

async function isDirectory(p: string): Promise<boolean> {
	return stat(p).then(
		(s) => s.isDirectory(),
		() => false,
	);
}

/** Recursively find SKILL.md files under a root (depth-limited). */
async function findSkillFiles(root: string, depth = 0): Promise<string[]> {
	if (depth > 4 || !(await isDirectory(root))) return [];
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const files: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const full = path.join(root, entry.name);
		if (entry.isFile() && entry.name === "SKILL.md") {
			files.push(full);
		} else if (entry.isDirectory() && !entry.name.startsWith(".")) {
			files.push(...(await findSkillFiles(full, depth + 1)));
		}
	}
	return files;
}

/**
 * Discover skills. Locations (first occurrence of a name wins):
 * - ~/.arbor/skills/ and ~/.agents/skills/ (global)
 * - <cwd>/.arbor/skills/ and <cwd>/.agents/skills/ (project)
 * - ~/.claude/skills/ (compatibility with the Claude Code ecosystem)
 * - extraPaths from settings/CLI
 */
export async function discoverSkills(
	options: SkillDiscoveryOptions,
): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
	const home = options.homeDir ?? os.homedir();
	const roots: string[] = [];
	if (!options.noDiscovery) {
		roots.push(
			path.join(home, ".arbor", "skills"),
			path.join(home, ".agents", "skills"),
			path.join(options.cwd, ".arbor", "skills"),
			path.join(options.cwd, ".agents", "skills"),
			path.join(home, ".claude", "skills"),
		);
	}

	const files: string[] = [];
	for (const root of roots) {
		files.push(...(await findSkillFiles(root)));
	}
	for (const extra of options.extraPaths ?? []) {
		const resolved = path.resolve(options.cwd, extra);
		if (await isDirectory(resolved)) {
			files.push(...(await findSkillFiles(resolved)));
		} else if (resolved.endsWith(".md")) {
			files.push(resolved);
		}
	}

	const skills: Skill[] = [];
	const warnings: SkillWarning[] = [];
	const seen = new Set<string>();
	for (const file of [...new Set(files)]) {
		const result = await loadSkillFile(file);
		if ("message" in result) {
			warnings.push(result);
		} else if (!seen.has(result.name)) {
			seen.add(result.name);
			skills.push(result);
		}
	}
	return { skills, warnings };
}

/**
 * System prompt section listing available skills, per the Agent Skills
 * integration format. Empty string when no skills are visible.
 */
export function skillsPromptSection(skills: Skill[]): string {
	const visible = skills.filter((s) => !s.disableModelInvocation);
	if (visible.length === 0) return "";
	const entries = visible
		.map(
			(s) =>
				`  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.path}</location>\n  </skill>`,
		)
		.join("\n");
	return `# Skills

Specialized capability packages are available. When a task matches a skill's description, read its SKILL.md at the listed location and follow the instructions there.

<available_skills>
${entries}
</available_skills>`;
}

/** Load the full body of a skill for /skill:name invocation. */
export async function loadSkillBody(skill: Skill, args?: string): Promise<string> {
	const content = await readFile(skill.path, "utf-8");
	const { body } = parseFrontmatter(content);
	const withHeader = `[Skill: ${skill.name} — base directory: ${skill.dir}]\n\n${body.trim()}`;
	return args && args.trim().length > 0 ? `${withHeader}\n\nUser: ${args.trim()}` : withHeader;
}
