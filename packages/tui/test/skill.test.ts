import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentSession, SessionManager, type Skill, type StreamFn } from "@arbor-space/core";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { expandSkillInvocation } from "../src/app.ts";

let workspace: string;

async function setup() {
	workspace = await mkdtemp(path.join(os.tmpdir(), "arbor-skill-ws-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const streamFn: StreamFn = (m, c, o) => models.streamSimple(m, c as never, o as never);

	// Write a SKILL.md.
	const skillDir = path.join(workspace, ".arbor", "skills", "websearch");
	await mkdir(skillDir, { recursive: true });
	const skillPath = path.join(skillDir, "SKILL.md");
	await writeFile(
		skillPath,
		"---\nname: websearch\ndescription: Search the web\n---\nSteps to search the web.\n",
	);
	const skill: Skill = {
		name: "websearch",
		description: "Search the web",
		path: skillPath,
		dir: skillDir,
		disableModelInvocation: false,
	};

	const session = new AgentSession({
		cwd: workspace,
		model: faux.getModel(),
		streamFn,
		systemPrompt: "You are Arbor.",
		tools: [],
		sessionManager: SessionManager.inMemory(workspace),
		skills: [skill],
	});
	return { session, skill };
}

describe("skill invocation expansion", () => {
	it("expands /skill:<name> <args> to the skill body + args", async () => {
		const { session } = await setup();
		try {
			const expanded = await expandSkillInvocation("/skill:websearch climate news", session);
			assert.ok(expanded, "should expand a known skill");
			assert.match(expanded, /Steps to search the web\./);
			assert.match(expanded, /climate news/);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("returns null for an unknown skill", async () => {
		const { session } = await setup();
		try {
			assert.equal(await expandSkillInvocation("/skill:nope do thing", session), null);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("returns null for non-skill text", async () => {
		const { session } = await setup();
		try {
			assert.equal(await expandSkillInvocation("/mode plan", session), null);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});
