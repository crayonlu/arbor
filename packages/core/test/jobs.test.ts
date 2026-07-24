/** Background jobs subsystem tests: registry, log store, watchdog, jobs tool. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createJobsTool } from "../src/jobs/jobs-tool.ts";
import { createJobLog, pruneJobLogs, tailJobLog } from "../src/jobs/log-store.ts";
import { BackgroundJobs, type JobNotification } from "../src/jobs/registry.ts";
import { looksLikePrompt, startStallWatchdog } from "../src/jobs/watchdog.ts";

let root: string;

before(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "arbor-jobs-"));
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function text(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((c) => c.text ?? "").join("");
}

describe("job registry", () => {
	it("starts a job as running and completes it", () => {
		const jobs = new BackgroundJobs();
		const handle = jobs.start({ type: "bash", title: "sleep 5" });
		const info = jobs.get(handle.id);
		assert.ok(info);
		assert.equal(info.status, "running");
		assert.equal(info.type, "bash");
		handle.complete(0);
		const done = jobs.get(handle.id);
		assert.equal(done?.status, "completed");
		assert.equal(done?.exitCode, 0);
		assert.ok(done?.completedAt);
		assert.equal(handle.isSettled, true);
	});

	it("fail records the error", () => {
		const jobs = new BackgroundJobs();
		const handle = jobs.start({ type: "bash", title: "boom" });
		handle.fail("Exited with code 2", 2);
		const info = jobs.get(handle.id);
		assert.equal(info?.status, "failed");
		assert.equal(info?.error, "Exited with code 2");
		assert.equal(info?.exitCode, 2);
	});

	it("settle is idempotent: second complete/fail is ignored", () => {
		const jobs = new BackgroundJobs();
		const notifications: JobNotification[] = [];
		jobs.subscribe((n) => notifications.push(n));
		const handle = jobs.start({ type: "bash", title: "x" });
		handle.complete(0);
		handle.fail("late failure");
		handle.complete(1);
		const info = jobs.get(handle.id);
		assert.equal(info?.status, "completed");
		assert.equal(info?.exitCode, 0);
		assert.equal(notifications.length, 1);
	});

	it("kill invokes the kill callback and settles as killed", () => {
		const jobs = new BackgroundJobs();
		let killed = false;
		const handle = jobs.start({
			type: "bash",
			title: "server",
			kill: () => {
				killed = true;
			},
		});
		const info = jobs.kill(handle.id);
		assert.equal(killed, true);
		assert.equal(info?.status, "killed");
		// A completed handle no longer flips the status.
		handle.complete(0);
		assert.equal(jobs.get(handle.id)?.status, "killed");
	});

	it("kill on an unknown or settled job is safe", () => {
		const jobs = new BackgroundJobs();
		assert.equal(jobs.kill("nope"), undefined);
		const handle = jobs.start({ type: "bash", title: "x" });
		handle.complete(0);
		assert.equal(jobs.kill(handle.id)?.status, "completed");
	});

	it("wait resolves when the job settles", async () => {
		const jobs = new BackgroundJobs();
		const handle = jobs.start({ type: "task", title: "research" });
		const waiting = jobs.wait(handle.id);
		handle.complete(0);
		const info = await waiting;
		assert.equal(info?.status, "completed");
	});

	it("wait with timeout resolves the running snapshot on expiry", async () => {
		const jobs = new BackgroundJobs();
		const handle = jobs.start({ type: "task", title: "slow" });
		const info = await jobs.wait(handle.id, 30);
		assert.equal(info?.status, "running");
		handle.complete(0);
	});

	it("wait on an already settled job resolves immediately", async () => {
		const jobs = new BackgroundJobs();
		const handle = jobs.start({ type: "bash", title: "x" });
		handle.complete(0);
		const info = await jobs.wait(handle.id);
		assert.equal(info?.status, "completed");
	});

	it("wait on an unknown job resolves undefined", async () => {
		const jobs = new BackgroundJobs();
		assert.equal(await jobs.wait("nope"), undefined);
	});

	it("settled notification fires exactly once, notices flow while running", () => {
		const jobs = new BackgroundJobs();
		const notifications: JobNotification[] = [];
		jobs.subscribe((n) => notifications.push(n));
		const handle = jobs.start({ type: "bash", title: "apt install" });
		jobs.notice(handle.id, "waiting for input");
		handle.complete(0);
		jobs.notice(handle.id, "ignored after settle");
		assert.equal(notifications.length, 2);
		assert.equal(notifications[0]?.kind, "notice");
		assert.equal(notifications[1]?.kind, "settled");
	});

	it("unsubscribe stops notifications", () => {
		const jobs = new BackgroundJobs();
		let count = 0;
		const unsubscribe = jobs.subscribe(() => count++);
		unsubscribe();
		jobs.start({ type: "bash", title: "x" }).complete(0);
		assert.equal(count, 0);
	});

	it("list returns jobs oldest first, titles truncated", () => {
		const jobs = new BackgroundJobs();
		const first = jobs.start({ type: "bash", title: "a".repeat(300) });
		const second = jobs.start({ type: "task", title: "b" });
		const list = jobs.list();
		assert.equal(list.length, 2);
		assert.equal(list[0]?.id, first.id);
		assert.equal(list[1]?.id, second.id);
		assert.ok((list[0]?.title.length ?? 0) <= 121);
		assert.equal(jobs.runningCount(), 2);
	});

	it("killAll settles every running job", () => {
		const jobs = new BackgroundJobs();
		jobs.start({ type: "bash", title: "one" });
		jobs.start({ type: "bash", title: "two" }).complete(0);
		jobs.start({ type: "bash", title: "three" });
		jobs.killAll();
		assert.equal(jobs.runningCount(), 0);
		const statuses = jobs.list().map((j) => j.status);
		assert.deepEqual(statuses.sort(), ["completed", "killed", "killed"]);
	});
});

describe("job log store", () => {
	it("appends chunks and reads the tail", async () => {
		const log = createJobLog("log-test-1", root);
		log.append("hello ");
		log.append(Buffer.from("world\n"));
		await log.close();
		const content = await readFile(log.path, "utf-8");
		assert.equal(content, "hello world\n");
		assert.equal(await tailJobLog(log.path, 6), "world\n");
		assert.equal(await tailJobLog(log.path, 4096), "hello world\n");
	});

	it("tail of a missing or empty file is empty", async () => {
		assert.equal(await tailJobLog(path.join(root, "missing.log")), "");
		const log = createJobLog("log-test-empty", root);
		await log.close();
		assert.equal(await tailJobLog(log.path), "");
	});

	it("append after close is a no-op", async () => {
		const log = createJobLog("log-test-closed", root);
		log.append("kept");
		await log.close();
		log.append("dropped");
		await delay(20);
		assert.equal(await readFile(log.path, "utf-8"), "kept");
	});

	it("prune removes only old logs", async () => {
		const pruneRoot = path.join(root, "prune");
		const oldLog = createJobLog("old-job", pruneRoot);
		oldLog.append("x");
		await oldLog.close();
		const newLog = createJobLog("new-job", pruneRoot);
		newLog.append("y");
		await newLog.close();
		await writeFile(path.join(pruneRoot, "not-a-log.txt"), "keep me");
		const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
		await utimes(oldLog.path, oldTime, oldTime);

		const removed = await pruneJobLogs(pruneRoot, 7);
		assert.equal(removed, 1);
		assert.equal(
			await stat(oldLog.path).then(
				() => true,
				() => false,
			),
			false,
		);
		assert.equal(
			await stat(newLog.path).then(
				() => true,
				() => false,
			),
			true,
		);
		assert.equal(
			await stat(path.join(pruneRoot, "not-a-log.txt")).then(
				() => true,
				() => false,
			),
			true,
		);
	});

	it("prune on a missing directory returns zero", async () => {
		assert.equal(await pruneJobLogs(path.join(root, "does-not-exist")), 0);
	});
});

describe("stall watchdog", () => {
	it("looksLikePrompt matches interactive prompts on the last line", () => {
		assert.equal(looksLikePrompt("Do you want to continue? (y/n)"), true);
		assert.equal(looksLikePrompt("Overwrite existing file? [Y/n]"), true);
		assert.equal(looksLikePrompt("Are you sure you want to proceed? "), true);
		assert.equal(looksLikePrompt("Press Enter to continue"), true);
		assert.equal(looksLikePrompt("Press any key to exit"), true);
		assert.equal(looksLikePrompt("Enter password: "), true);
		assert.equal(looksLikePrompt("Continue? "), true);
		assert.equal(looksLikePrompt("some output\nProceed? (yes/no)"), true);
	});

	it("looksLikePrompt ignores ordinary output", () => {
		assert.equal(looksLikePrompt("compiling module 4 of 100"), false);
		assert.equal(looksLikePrompt("Test passed: should ask (y/n) when needed\ndone"), false);
		assert.equal(looksLikePrompt(""), false);
		assert.equal(looksLikePrompt("Downloading... 45%"), false);
	});

	it("fires once when output is flat and ends with a prompt", async () => {
		const logPath = path.join(root, "stall.log");
		await writeFile(logPath, "Installing...\nDo you want to continue? (y/n)");
		let stalls = 0;
		const cancel = startStallWatchdog({
			logPath,
			intervalMs: 10,
			thresholdMs: 30,
			onStall: () => stalls++,
		});
		await delay(150);
		cancel();
		assert.equal(stalls, 1);
	});

	it("does not fire while output keeps growing or without a prompt tail", async () => {
		const growingPath = path.join(root, "growing.log");
		await writeFile(growingPath, "start\n");
		let growingStalls = 0;
		const cancelGrowing = startStallWatchdog({
			logPath: growingPath,
			intervalMs: 10,
			thresholdMs: 40,
			onStall: () => growingStalls++,
		});
		const feeder = setInterval(() => {
			void writeFile(growingPath, `more output ${Date.now()}\n`, { flag: "a" });
		}, 15);

		const quietPath = path.join(root, "quiet.log");
		await writeFile(quietPath, "building step 3 of 9\n");
		let quietStalls = 0;
		const cancelQuiet = startStallWatchdog({
			logPath: quietPath,
			intervalMs: 10,
			thresholdMs: 30,
			onStall: () => quietStalls++,
		});

		await delay(150);
		clearInterval(feeder);
		cancelGrowing();
		cancelQuiet();
		assert.equal(growingStalls, 0);
		assert.equal(quietStalls, 0);
	});
});

describe("jobs tool", () => {
	it("list shows all jobs with status", async () => {
		const jobs = new BackgroundJobs();
		const tool = createJobsTool(jobs);
		const empty = await tool.execute("j0", { action: "list" });
		assert.match(text(empty), /No background jobs/);

		const running = jobs.start({ type: "bash", title: "npm run dev" });
		jobs.start({ type: "task", title: "explore src" }).complete(0);
		const result = await tool.execute("j1", { action: "list" });
		const output = text(result);
		assert.match(output, new RegExp(`${running.id} \\[running\\]`));
		assert.match(output, /\[completed exit=0\]/);
		assert.equal(result.details.jobs?.length, 2);
	});

	it("output returns the log tail and full path", async () => {
		const jobs = new BackgroundJobs();
		const tool = createJobsTool(jobs);
		const handle = jobs.start({ type: "bash", title: "npm test" });
		const log = createJobLog(handle.id, root);
		jobs.setLogPath(handle.id, log.path);
		log.append("42 tests passed\n");
		await log.close();
		handle.complete(0);

		const result = await tool.execute("j2", { action: "output", jobId: handle.id });
		const output = text(result);
		assert.match(output, /42 tests passed/);
		assert.match(output, /Full output:/);
		assert.equal(result.details.job?.status, "completed");
	});

	it("output with wait blocks until completion", async () => {
		const jobs = new BackgroundJobs();
		const tool = createJobsTool(jobs);
		const handle = jobs.start({ type: "bash", title: "slow" });
		setTimeout(() => handle.complete(0), 30);
		const result = await tool.execute("j3", { action: "output", jobId: handle.id, wait: 2000 });
		assert.equal(result.details.job?.status, "completed");
	});

	it("kill stops a running job", async () => {
		const jobs = new BackgroundJobs();
		const tool = createJobsTool(jobs);
		let killed = false;
		const handle = jobs.start({
			type: "bash",
			title: "server",
			kill: () => {
				killed = true;
			},
		});
		const result = await tool.execute("j4", { action: "kill", jobId: handle.id });
		assert.equal(killed, true);
		assert.equal(result.details.job?.status, "killed");
	});

	it("output/kill require a jobId and reject unknown jobs", async () => {
		const jobs = new BackgroundJobs();
		const tool = createJobsTool(jobs);
		await assert.rejects(() => tool.execute("j5", { action: "output" }), /jobId is required/);
		await assert.rejects(() => tool.execute("j6", { action: "kill" }), /jobId is required/);
		await assert.rejects(() => tool.execute("j7", { action: "output", jobId: "nope" }), /Unknown job/);
		await assert.rejects(() => tool.execute("j8", { action: "kill", jobId: "nope" }), /Unknown job/);
	});
});
