/** Shadow-git snapshot + rewind tests using a real git binary in temp dirs. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SessionManager } from "../src/session/manager.ts";
import { listRewindTargets, rewindSession } from "../src/session/rewind.ts";
import { SnapshotManager } from "../src/session/snapshot.ts";
import type { AgentMessage } from "../src/types.ts";

let workspace: string;
let snapshotsRoot: string;
let snapshots: SnapshotManager;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "arbor-snap-ws-"));
	snapshotsRoot = await mkdtemp(path.join(os.tmpdir(), "arbor-snap-git-"));
	snapshots = new SnapshotManager(workspace, { snapshotsRoot });
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	await rm(snapshotsRoot, { recursive: true, force: true });
});

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

async function exists(p: string): Promise<boolean> {
	return stat(p).then(
		() => true,
		() => false,
	);
}

describe("SnapshotManager", () => {
	it("tracks workspace state and returns a commit hash", async () => {
		await writeFile(path.join(workspace, "a.txt"), "v1");
		const commit = await snapshots.track();
		assert.match(commit, /^[0-9a-f]{40}$/);
	});

	it("returns a new commit when content changes", async () => {
		await writeFile(path.join(workspace, "a.txt"), "v1");
		const c1 = await snapshots.track();
		await writeFile(path.join(workspace, "a.txt"), "v2");
		const c2 = await snapshots.track();
		assert.notEqual(c1, c2);
	});

	it("reuses HEAD when nothing changed", async () => {
		await writeFile(path.join(workspace, "a.txt"), "v1");
		const c1 = await snapshots.track();
		const c2 = await snapshots.track();
		assert.equal(c1, c2);
	});

	it("restores modified files to the snapshot state", async () => {
		await writeFile(path.join(workspace, "a.txt"), "original");
		const commit = await snapshots.track();
		await writeFile(path.join(workspace, "a.txt"), "modified");
		await snapshots.restore(commit);
		assert.equal(await readFile(path.join(workspace, "a.txt"), "utf-8"), "original");
	});

	it("removes files created after the snapshot", async () => {
		await writeFile(path.join(workspace, "a.txt"), "keep");
		const commit = await snapshots.track();
		await writeFile(path.join(workspace, "new-file.txt"), "should disappear");
		await snapshots.track();
		await snapshots.restore(commit);
		assert.equal(await exists(path.join(workspace, "new-file.txt")), false);
		assert.equal(await readFile(path.join(workspace, "a.txt"), "utf-8"), "keep");
	});

	it("restores deleted files", async () => {
		await writeFile(path.join(workspace, "victim.txt"), "restore me");
		const commit = await snapshots.track();
		await rm(path.join(workspace, "victim.txt"));
		await snapshots.restore(commit);
		assert.equal(await readFile(path.join(workspace, "victim.txt"), "utf-8"), "restore me");
	});

	it("does not touch the user's own git repository", async () => {
		await writeFile(path.join(workspace, "a.txt"), "v1");
		await snapshots.track();
		// The shadow git dir lives outside the workspace; no .git in the workspace.
		assert.equal(await exists(path.join(workspace, ".git")), false);
	});

	it("keeps snapshots working after a restore (branch continues)", async () => {
		await writeFile(path.join(workspace, "a.txt"), "v1");
		const c1 = await snapshots.track();
		await writeFile(path.join(workspace, "a.txt"), "v2");
		await snapshots.track();
		await snapshots.restore(c1);
		await writeFile(path.join(workspace, "a.txt"), "v3");
		const c3 = await snapshots.track();
		assert.notEqual(c3, c1);
		await snapshots.restore(c1);
		assert.equal(await readFile(path.join(workspace, "a.txt"), "utf-8"), "v1");
	});

	it("reports changed files against a snapshot", async () => {
		await writeFile(path.join(workspace, "a.txt"), "v1");
		const commit = await snapshots.track();
		await writeFile(path.join(workspace, "a.txt"), "changed");
		const changed = await snapshots.changedFiles(commit);
		assert.deepEqual(changed, ["a.txt"]);
	});
});

describe("rewindSession", () => {
	it("moves conversation and files back together", async () => {
		const session = SessionManager.inMemory(workspace);

		// Turn 1: snapshot, user asks, file gets created.
		await writeFile(path.join(workspace, "app.ts"), "console.log(1);\n");
		const snap1 = await snapshots.track();
		session.appendSnapshot(snap1);
		const turn1 = session.appendMessage(user("create the app"));

		// Turn 2: snapshot, user asks again, file gets broken.
		const snap2 = await snapshots.track();
		session.appendSnapshot(snap2);
		session.appendMessage(user("now refactor it"));
		await writeFile(path.join(workspace, "app.ts"), "BROKEN CONTENT");
		await snapshots.track();

		// Rewind to turn 1: conversation loses turn 2, file content restored.
		const result = await rewindSession(session, snapshots, turn1.id);
		assert.equal(result.filesRestored, true);
		assert.equal(result.snapshotCommit, snap1);
		assert.equal(session.leaf, turn1.id);
		assert.equal(await readFile(path.join(workspace, "app.ts"), "utf-8"), "console.log(1);\n");
		const contents = session.buildContextMessages().map((m) => (m as { content: string }).content);
		assert.ok(contents.includes("create the app"));
		assert.ok(!contents.includes("now refactor it"));
	});

	it("rewinds conversation-only when no snapshot manager is provided", async () => {
		const session = SessionManager.inMemory(workspace);
		const a = session.appendMessage(user("a"));
		session.appendMessage(user("b"));
		const result = await rewindSession(session, null, a.id);
		assert.equal(result.filesRestored, false);
		assert.equal(session.leaf, a.id);
	});

	it("lists user messages as rewind targets", () => {
		const session = SessionManager.inMemory(workspace);
		session.appendSnapshot("c0ffee");
		session.appendMessage(user("first request"));
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "reply" }],
			api: "x",
			provider: "faux",
			model: "m",
			usage: {} as never,
			stopReason: "stop",
			timestamp: Date.now(),
		});
		session.appendMessage(user("second request"));

		const targets = listRewindTargets(session);
		assert.equal(targets.length, 2);
		assert.equal(targets[0]?.label, "first request");
		assert.equal(targets[1]?.label, "second request");
	});
});
