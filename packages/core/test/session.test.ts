/** Session tree tests: JSONL persistence, branching, fork, context rebuild. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { SessionManager } from "../src/session/manager.ts";
import type { AgentMessage } from "../src/types.ts";

let root: string;
const cwd = "/tmp/fake-project";

before(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "arbor-sessions-"));
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

describe("SessionManager", () => {
	it("persists a header line and appends entries as JSONL", async () => {
		const session = SessionManager.create(cwd, { sessionsRoot: root });
		session.appendMessage(user("hello"));
		assert.ok(session.filePath);
		const lines = (await readFile(session.filePath as string, "utf-8")).trim().split("\n");
		assert.equal(lines.length, 2);
		const header = JSON.parse(lines[0] as string);
		assert.equal(header.type, "session");
		assert.equal(header.cwd, cwd);
		const entry = JSON.parse(lines[1] as string);
		assert.equal(entry.type, "message");
		assert.equal(entry.parentId, null);
	});

	it("links entries into a chain via parentId", () => {
		const session = SessionManager.inMemory(cwd);
		const first = session.appendMessage(user("one"));
		const second = session.appendMessage(user("two"));
		assert.equal(first.parentId, null);
		assert.equal(second.parentId, first.id);
		assert.equal(session.leaf, second.id);
	});

	it("round-trips through load with the leaf at the last entry", () => {
		const session = SessionManager.create(cwd, { sessionsRoot: root });
		session.appendMessage(user("persisted"));
		const loaded = SessionManager.load(session.filePath as string);
		assert.equal(loaded.sessionId, session.sessionId);
		assert.equal(loaded.getAllEntries().length, 1);
		assert.equal(loaded.leaf, session.leaf);
	});

	it("getActivePath follows the leaf, not append order", () => {
		const session = SessionManager.inMemory(cwd);
		const a = session.appendMessage(user("a"));
		session.appendMessage(user("b (will be abandoned)"));
		// Rewind to a, then continue on a new branch.
		session.rewindTo(a.id, false);
		const c = session.appendMessage(user("c (new branch)"));
		const path_ = session.getActivePath();
		assert.deepEqual(
			path_.map((e) => e.id),
			[a.id, c.id],
		);
	});

	it("rewind survives reload via the rewind marker", () => {
		const session = SessionManager.create(cwd, { sessionsRoot: root });
		const a = session.appendMessage(user("a"));
		session.appendMessage(user("b"));
		session.rewindTo(a.id, false);

		const loaded = SessionManager.load(session.filePath as string);
		assert.equal(loaded.leaf, a.id);
		// The abandoned entry is still in the tree (append-only).
		assert.equal(loaded.getAllEntries().filter((e) => e.type === "message").length, 2);
	});

	it("buildContextMessages applies the newest compaction on the path", () => {
		const session = SessionManager.inMemory(cwd);
		session.appendMessage(user("old message 1"));
		session.appendMessage(user("old message 2"));
		session.appendCompaction({ summary: "SUMMARY OF OLD", tokensBefore: 1000 });
		session.appendMessage(user("recent"));

		const messages = session.buildContextMessages();
		assert.equal(messages.length, 2);
		const first = messages[0] as { role: string; content: string };
		assert.match(first.content, /SUMMARY OF OLD/);
		const last = messages[1] as { role: string; content: string };
		assert.equal(last.content, "recent");
	});

	it("includes branch summaries in rebuilt context", () => {
		const session = SessionManager.inMemory(cwd);
		const a = session.appendMessage(user("a"));
		const b = session.appendMessage(user("abandoned"));
		session.rewindTo(a.id, false);
		session.appendBranchSummary(b.id, "Explored X, did not work");
		session.appendMessage(user("retry"));

		const messages = session.buildContextMessages();
		const contents = messages.map((m) => (m as { content: string }).content);
		assert.ok(contents.some((c) => /Explored X/.test(c)));
		assert.ok(contents.includes("retry"));
		assert.ok(!contents.includes("abandoned"));
	});

	it("findNearestSnapshot walks up the tree", () => {
		const session = SessionManager.inMemory(cwd);
		session.appendMessage(user("before snapshot"));
		const snap = session.appendSnapshot("abc123");
		const after1 = session.appendMessage(user("after snapshot"));
		assert.equal(session.findNearestSnapshot(after1.id)?.commit, "abc123");
		assert.equal(session.findNearestSnapshot(snap.id)?.commit, "abc123");
	});

	it("fork copies all entries into a new file with lineage", async () => {
		const original = SessionManager.create(cwd, { sessionsRoot: root });
		original.appendMessage(user("shared history"));
		const forked = SessionManager.fork(original.filePath as string, { sessionsRoot: root });

		assert.notEqual(forked.sessionId, original.sessionId);
		assert.equal(forked.getAllEntries().length, 1);
		assert.equal(forked.leaf, original.leaf);
		// Divergence: appending to the fork does not touch the original.
		forked.appendMessage(user("fork only"));
		assert.equal(original.getAllEntries().length, 1);
		const originalContent = await readFile(original.filePath as string, "utf-8");
		assert.doesNotMatch(originalContent, /fork only/);
	});

	it("lists sessions for a cwd, newest first", async () => {
		const listCwd = "/tmp/list-project";
		const s1 = SessionManager.create(listCwd, { sessionsRoot: root });
		s1.appendMessage(user("s1"));
		await new Promise((r) => setTimeout(r, 10));
		const s2 = SessionManager.create(listCwd, { sessionsRoot: root });
		s2.appendMessage(user("s2"));
		s2.appendMessage(user("s2 again"));

		const infos = await SessionManager.list(listCwd, root);
		assert.equal(infos.length, 2);
		assert.equal(infos[0]?.id, s2.sessionId);
		assert.equal(infos[0]?.messageCount, 2);
	});

	it("custom entries persist extension data", () => {
		const session = SessionManager.create(cwd, { sessionsRoot: root });
		session.appendCustom("todo-list", { items: ["a", "b"] });
		const loaded = SessionManager.load(session.filePath as string);
		const custom = loaded.getAllEntries().find((e) => e.type === "custom");
		assert.ok(custom && custom.type === "custom");
		assert.equal(custom.customType, "todo-list");
		assert.deepEqual(custom.data, { items: ["a", "b"] });
	});

	it("ephemeral sessions never write to disk", () => {
		const session = SessionManager.inMemory(cwd);
		session.appendMessage(user("never persisted"));
		assert.equal(session.filePath, null);
	});
});
