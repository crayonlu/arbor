/** Skills and prompt template tests. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	discoverSkills,
	loadSkillBody,
	loadSkillFile,
	parseFrontmatter,
	skillsPromptSection,
} from "../src/skills.ts";
import { discoverTemplates, expandTemplate, splitArguments } from "../src/templates.ts";

let tmp: string;
let home: string;
let cwd: string;

before(async () => {
	tmp = await mkdtemp(path.join(os.tmpdir(), "arbor-skills-"));
	home = path.join(tmp, "home");
	cwd = path.join(tmp, "project");

	// Global skill.
	await mkdir(path.join(home, ".arbor", "skills", "web-search"), { recursive: true });
	await writeFile(
		path.join(home, ".arbor", "skills", "web-search", "SKILL.md"),
		`---\nname: web-search\ndescription: Search the web for current information.\n---\n\n# Web Search\n\nRun scripts/search.sh <query>.`,
	);
	// Project skill (nested one level).
	await mkdir(path.join(cwd, ".agents", "skills", "group", "deploy"), { recursive: true });
	await writeFile(
		path.join(cwd, ".agents", "skills", "group", "deploy", "SKILL.md"),
		`---\nname: deploy\ndescription: Deploy the service to staging.\ndisable-model-invocation: true\n---\n\nDeploy instructions here.`,
	);
	// Claude-compat location.
	await mkdir(path.join(home, ".claude", "skills", "pdf"), { recursive: true });
	await writeFile(
		path.join(home, ".claude", "skills", "pdf", "SKILL.md"),
		`---\nname: pdf\ndescription: Extract text from PDF files.\n---\n\nPDF instructions.`,
	);
	// Invalid skill (missing description).
	await mkdir(path.join(home, ".arbor", "skills", "broken"), { recursive: true });
	await writeFile(path.join(home, ".arbor", "skills", "broken", "SKILL.md"), `---\nname: broken\n---\nbody`);

	// Templates.
	await mkdir(path.join(home, ".arbor", "prompts"), { recursive: true });
	await writeFile(
		path.join(home, ".arbor", "prompts", "review.md"),
		`---\ndescription: Review staged changes\n---\nReview the staged changes carefully.`,
	);
	await mkdir(path.join(cwd, ".arbor", "prompts"), { recursive: true });
	await writeFile(
		path.join(cwd, ".arbor", "prompts", "component.md"),
		`---\ndescription: Create a component\nargument-hint: "<name> [description]"\n---\nCreate a component named $1. Purpose: \${@:2}. Fallback: \${1:-Widget}`,
	);
	// Project template overriding a global one.
	await writeFile(path.join(cwd, ".arbor", "prompts", "review.md"), `Project-specific review.`);
});

after(async () => {
	await rm(tmp, { recursive: true, force: true });
});

describe("parseFrontmatter", () => {
	it("parses key: value pairs and strips quotes", () => {
		const { frontmatter, body } = parseFrontmatter(`---\nname: x\ndesc: "quoted"\n---\nbody text`);
		assert.equal(frontmatter.name, "x");
		assert.equal(frontmatter.desc, "quoted");
		assert.equal(body, "body text");
	});

	it("returns the whole content as body without frontmatter", () => {
		const { frontmatter, body } = parseFrontmatter("just text");
		assert.deepEqual(frontmatter, {});
		assert.equal(body, "just text");
	});
});

describe("skills discovery", () => {
	it("discovers skills across global/project/claude locations", async () => {
		const { skills, warnings } = await discoverSkills({ cwd, homeDir: home });
		const names = skills.map((s) => s.name).sort();
		assert.deepEqual(names, ["deploy", "pdf", "web-search"]);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]?.message ?? "", /missing required frontmatter/);
	});

	it("hides disable-model-invocation skills from the prompt section", async () => {
		const { skills } = await discoverSkills({ cwd, homeDir: home });
		const section = skillsPromptSection(skills);
		assert.match(section, /web-search/);
		assert.match(section, /<location>/);
		assert.doesNotMatch(section, /deploy/);
	});

	it("returns empty prompt section without skills", () => {
		assert.equal(skillsPromptSection([]), "");
	});

	it("rejects invalid skill names", async () => {
		const file = path.join(tmp, "SKILL.md");
		await writeFile(file, `---\nname: Bad_Name\ndescription: x\n---\nbody`);
		const result = await loadSkillFile(file);
		assert.ok("message" in result);
		assert.match(result.message, /invalid skill name/);
	});

	it("loadSkillBody includes base dir and appends args", async () => {
		const { skills } = await discoverSkills({ cwd, homeDir: home });
		const webSearch = skills.find((s) => s.name === "web-search");
		assert.ok(webSearch);
		const body = await loadSkillBody(webSearch, "climate news");
		assert.match(body, /base directory/);
		assert.match(body, /User: climate news/);
	});
});

describe("prompt templates", () => {
	it("discovers templates with project overriding global", async () => {
		const templates = await discoverTemplates({ cwd, homeDir: home });
		const review = templates.find((t) => t.name === "review");
		assert.ok(review);
		assert.match(review.body, /Project-specific/);
		const component = templates.find((t) => t.name === "component");
		assert.equal(component?.argumentHint, "<name> [description]");
	});

	it("splitArguments respects quotes", () => {
		assert.deepEqual(splitArguments(`Button "click handler" third`), ["Button", "click handler", "third"]);
	});

	it("expands positional args, slices, and defaults", () => {
		const body = "Name: $1. Rest: ${@:2}. All: $@. Def: ${2:-fallback}";
		assert.equal(
			expandTemplate(body, "Button primary secondary"),
			"Name: Button. Rest: primary secondary. All: Button primary secondary. Def: primary",
		);
		assert.equal(expandTemplate(body, "Solo"), "Name: Solo. Rest: . All: Solo. Def: fallback");
	});

	it("expands ${@:N:L} windows and $ARGUMENTS", () => {
		assert.equal(expandTemplate("${@:2:2}", "a b c d"), "b c");
		assert.equal(expandTemplate("$ARGUMENTS", "x y"), "x y");
		assert.equal(expandTemplate("${ARGUMENTS:-none}", ""), "none");
	});
});
