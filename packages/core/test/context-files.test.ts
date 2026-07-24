/** Context file (AGENTS.md/CLAUDE.md) discovery tests. */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { contextFilesPromptSection, loadContextFiles } from "../src/context-files.ts";

let root: string;

before(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "arbor-ctx-"));
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("context files", () => {
	it("finds files in ancestors ordered root-first, cwd last", async () => {
		const project = path.join(root, "order", "repo");
		const nested = path.join(project, "packages", "core");
		await mkdir(nested, { recursive: true });
		await writeFile(path.join(root, "order", "AGENTS.md"), "outer rules");
		await writeFile(path.join(project, "AGENTS.md"), "repo rules");
		await writeFile(path.join(nested, "AGENTS.md"), "package rules");

		const files = loadContextFiles(nested, { homeDir: path.join(root, "no-home") });
		const contents = files.map((f) => f.content);
		assert.deepEqual(contents, ["outer rules", "repo rules", "package rules"]);
	});

	it("global home file comes first", async () => {
		const home = path.join(root, "home", ".arbor");
		const project = path.join(root, "home", "project");
		await mkdir(home, { recursive: true });
		await mkdir(project, { recursive: true });
		await writeFile(path.join(home, "AGENTS.md"), "global rules");
		await writeFile(path.join(project, "AGENTS.md"), "project rules");

		const files = loadContextFiles(project, { homeDir: home });
		assert.deepEqual(
			files.map((f) => f.content),
			["global rules", "project rules"],
		);
	});

	it("first matching candidate name wins per directory", async () => {
		const dir = path.join(root, "candidates");
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "AGENTS.md"), "agents file");
		await writeFile(path.join(dir, "CLAUDE.md"), "claude file");

		const files = loadContextFiles(dir, { homeDir: path.join(root, "no-home") });
		assert.equal(files.length, 1);
		assert.equal(files[0]?.content, "agents file");
	});

	it("falls back to CLAUDE.md when AGENTS.md is absent", async () => {
		const dir = path.join(root, "fallback");
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "CLAUDE.md"), "claude rules");

		const files = loadContextFiles(dir, { homeDir: path.join(root, "no-home") });
		assert.equal(files.length, 1);
		assert.match(files[0]?.path ?? "", /CLAUDE\.md$/);
	});

	it("deduplicates when home dir is an ancestor of cwd", async () => {
		const home = path.join(root, "dedup");
		await mkdir(home, { recursive: true });
		await writeFile(path.join(home, "AGENTS.md"), "same file");

		const files = loadContextFiles(home, { homeDir: home });
		assert.equal(files.length, 1);
	});

	it("skips unreadable files silently", async (t) => {
		if (process.getuid?.() === 0) {
			t.skip("running as root — chmod 000 still readable");
			return;
		}
		const dir = path.join(root, "unreadable", "inner");
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(root, "unreadable", "AGENTS.md"), "readable outer");
		const blocked = path.join(dir, "AGENTS.md");
		await writeFile(blocked, "secret");
		await chmod(blocked, 0o000);
		try {
			const files = loadContextFiles(dir, { homeDir: path.join(root, "no-home") });
			assert.deepEqual(
				files.map((f) => f.content),
				["readable outer"],
			);
		} finally {
			await chmod(blocked, 0o644);
		}
	});

	it("returns empty for a workspace without context files", async () => {
		const dir = path.join(root, "empty-ws");
		await mkdir(dir, { recursive: true });
		// Note: ancestors of tmpdir could theoretically contain context files,
		// but the test environment is expected to be clean.
		const files = loadContextFiles(dir, { homeDir: path.join(root, "no-home") });
		assert.deepEqual(files, []);
	});

	it("prompt section renders headers and trims content", () => {
		const section = contextFilesPromptSection([
			{ path: "/a/AGENTS.md", content: "rule one\n" },
			{ path: "/a/b/AGENTS.md", content: "rule two" },
		]);
		assert.match(section, /^# Project context/);
		assert.match(section, /## Context from \/a\/AGENTS\.md\n\nrule one\n/);
		assert.match(section, /## Context from \/a\/b\/AGENTS\.md\n\nrule two$/);
	});

	it("prompt section is empty for no files", () => {
		assert.equal(contextFilesPromptSection([]), "");
	});
});
