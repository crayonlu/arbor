/**
 * Shadow-git snapshots: workspace file state tracking for rewind.
 *
 * Uses a separate GIT_DIR under ~/.arbor/snapshots/<project-hash>/ with the
 * work-tree pointed at the project directory, so the user's own git repo is
 * never touched. Each track() commits the full workspace state and returns a
 * commit hash; restore() resets the workspace back to a hash.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface SnapshotOptions {
	/** Root for shadow repositories. Default: ~/.arbor/snapshots */
	snapshotsRoot?: string;
}

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Prune snapshot commits older than this. */
const PRUNE_DAYS = 7;

const GIT_CONFIG = [
	"-c",
	"core.autocrlf=false",
	"-c",
	"core.longpaths=true",
	"-c",
	"user.name=arbor",
	"-c",
	"user.email=snapshot@arbor.invalid",
	"-c",
	"commit.gpgsign=false",
];

export class SnapshotManager {
	readonly workspaceDir: string;
	readonly gitDir: string;
	private initialized = false;

	constructor(workspaceDir: string, options: SnapshotOptions = {}) {
		this.workspaceDir = path.resolve(workspaceDir);
		const hash = createHash("sha256").update(this.workspaceDir).digest("hex").slice(0, 16);
		const root = options.snapshotsRoot ?? path.join(os.homedir(), ".arbor", "snapshots");
		this.gitDir = path.join(root, hash);
	}

	private git(args: string[], allowFailure = false): Promise<GitResult> {
		return new Promise((resolve, reject) => {
			const child = spawn("git", [...GIT_CONFIG, ...args], {
				cwd: this.workspaceDir,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					GIT_DIR: this.gitDir,
					GIT_WORK_TREE: this.workspaceDir,
					// Never pick up the user's global excludes or hooks.
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_SYSTEM: "/dev/null",
				},
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (c: Buffer) => {
				stdout += c.toString("utf-8");
			});
			child.stderr.on("data", (c: Buffer) => {
				stderr += c.toString("utf-8");
			});
			child.on("error", (error) => reject(new Error(`Failed to run git: ${error.message}`)));
			child.on("close", (code) => {
				if (code !== 0 && !allowFailure) {
					reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`));
				} else {
					resolve({ code: code ?? -1, stdout, stderr });
				}
			});
		});
	}

	/** Initialize the shadow repository if needed. Idempotent. */
	async init(): Promise<void> {
		if (this.initialized) return;
		const exists = await stat(path.join(this.gitDir, "HEAD"))
			.then(() => true)
			.catch(() => false);
		if (!exists) {
			await mkdir(this.gitDir, { recursive: true });
			await this.git(["init", "--quiet"]);
			// The user's .gitignore still applies via the work-tree; that is
			// desirable — ignored artifacts (node_modules) are not snapshotted.
		}
		this.initialized = true;
	}

	/**
	 * Record the current workspace state. Returns the commit hash, or the
	 * previous HEAD when nothing changed (git commit would be empty).
	 */
	async track(): Promise<string> {
		await this.init();
		await this.git(["add", "-A", "."]);
		const commit = await this.git(
			["commit", "--quiet", "--allow-empty-message", "-m", "", "--no-verify"],
			true,
		);
		if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
			throw new Error(`Snapshot commit failed: ${(commit.stderr || commit.stdout).trim()}`);
		}
		const head = await this.git(["rev-parse", "HEAD"]);
		return head.stdout.trim();
	}

	/**
	 * Restore the workspace to a snapshot commit. Tracked files are reset;
	 * files created since the snapshot (now untracked in it) are removed via
	 * a diff against the current state. Ignored files are left alone.
	 */
	async restore(commit: string): Promise<void> {
		await this.init();
		// Snapshot the current state first so a restore is itself reversible.
		await this.track();
		await this.git(["checkout", "--force", commit, "--", "."]);
		// Delete files that exist now but not in the snapshot.
		const diff = await this.git(["diff", "--name-only", "--diff-filter=A", commit, "HEAD"]);
		const added = diff.stdout.split("\n").filter((l) => l.trim().length > 0);
		for (const file of added) {
			const abs = path.join(this.workspaceDir, file);
			await rm(abs, { force: true });
		}
		// Move the branch pointer so subsequent tracks build on the restored state.
		await this.git(["reset", "--soft", commit]);
		await this.git(["add", "-A", "."]);
	}

	/** Unified diff between a snapshot commit and the current workspace. */
	async diff(commit: string): Promise<string> {
		await this.init();
		const result = await this.git(["diff", commit], true);
		return result.stdout;
	}

	/** Files changed between a snapshot commit and the current workspace. */
	async changedFiles(commit: string): Promise<string[]> {
		await this.init();
		const result = await this.git(["diff", "--name-only", commit], true);
		return result.stdout.split("\n").filter((l) => l.trim().length > 0);
	}

	/** Drop snapshot history older than PRUNE_DAYS to bound disk usage. */
	async prune(): Promise<void> {
		await this.init();
		await this.git(["reflog", "expire", `--expire=${PRUNE_DAYS}.days`, "--all"], true);
		await this.git(["gc", "--quiet", `--prune=${PRUNE_DAYS}.days.ago`], true);
	}

	/** Remove the entire shadow repository. */
	async destroy(): Promise<void> {
		await rm(this.gitDir, { recursive: true, force: true });
		this.initialized = false;
	}
}
