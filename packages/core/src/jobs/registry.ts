/**
 * BackgroundJobs: a process-local registry for background work (bash
 * commands, subagents). Deliberately not durable — process restart loses
 * status and kills live work; persisted observation would need a separate
 * ownership layer rather than pretending this registry has those semantics.
 *
 * Completion notifications fire exactly once per job via onSettled; notices
 * (e.g. stall warnings) flow through the same subscription channel.
 */

export type JobStatus = "running" | "completed" | "failed" | "killed";

export interface JobInfo {
	id: string;
	/** Kind of work: "bash", "task", or an extension-defined type. */
	type: string;
	/** Human-readable description (command line, task prompt). */
	title: string;
	status: JobStatus;
	startedAt: number;
	completedAt?: number;
	exitCode?: number | null;
	/** Path to the on-disk output log, when one exists. */
	logPath?: string;
	error?: string;
}

export interface JobHandle {
	readonly id: string;
	/** Mark the job successfully finished. Idempotent after first settle. */
	complete(exitCode?: number | null): void;
	/** Mark the job failed. Idempotent after first settle. */
	fail(error: string, exitCode?: number | null): void;
	readonly isSettled: boolean;
}

export interface StartJobInput {
	type: string;
	title: string;
	logPath?: string;
	/** Terminate the underlying work (child.kill). Called by registry.kill. */
	kill?: () => void;
}

/** A settled-job notification or an in-flight notice (stall warning). */
export type JobNotification =
	| { kind: "settled"; info: JobInfo }
	| { kind: "notice"; info: JobInfo; text: string };

type Subscriber = (notification: JobNotification) => void;

interface ActiveJob {
	info: JobInfo;
	kill?: (() => void) | undefined;
	notified: boolean;
	waiters: ((info: JobInfo) => void)[];
}

const MAX_TITLE_LENGTH = 120;

export class BackgroundJobs {
	private jobs = new Map<string, ActiveJob>();
	private subscribers = new Set<Subscriber>();
	private sequence = 0;

	/** Register a new running job. */
	start(input: StartJobInput): JobHandle {
		this.sequence += 1;
		const id = `job-${this.sequence}-${Math.random().toString(36).slice(2, 6)}`;
		const title =
			input.title.length > MAX_TITLE_LENGTH ? `${input.title.slice(0, MAX_TITLE_LENGTH)}…` : input.title;
		const job: ActiveJob = {
			info: {
				id,
				type: input.type,
				title,
				status: "running",
				startedAt: Date.now(),
				...(input.logPath !== undefined ? { logPath: input.logPath } : {}),
			},
			kill: input.kill,
			notified: false,
			waiters: [],
		};
		this.jobs.set(id, job);

		const settle = (status: Exclude<JobStatus, "running">, exitCode?: number | null, error?: string) => {
			if (job.info.status !== "running") return;
			job.info = {
				...job.info,
				status,
				completedAt: Date.now(),
				...(exitCode !== undefined ? { exitCode } : {}),
				...(error !== undefined ? { error } : {}),
			};
			job.kill = undefined;
			for (const waiter of job.waiters.splice(0)) {
				waiter(this.snapshot(job));
			}
			this.notifySettled(job);
		};

		return {
			id,
			complete: (exitCode) => settle("completed", exitCode ?? null),
			fail: (error, exitCode) => settle("failed", exitCode ?? null, error),
			get isSettled() {
				return job.info.status !== "running";
			},
		};
	}

	private snapshot(job: ActiveJob): JobInfo {
		return { ...job.info };
	}

	/** Fire the settled notification exactly once per job. */
	private notifySettled(job: ActiveJob): void {
		if (job.notified) return;
		job.notified = true;
		const info = this.snapshot(job);
		for (const subscriber of this.subscribers) {
			subscriber({ kind: "settled", info });
		}
	}

	/** Emit an in-flight notice (e.g. stall warning) for a running job. */
	notice(id: string, text: string): void {
		const job = this.jobs.get(id);
		if (job?.info.status !== "running") return;
		const info = this.snapshot(job);
		for (const subscriber of this.subscribers) {
			subscriber({ kind: "notice", info, text });
		}
	}

	/** Attach the output log path once it is created (log names use the job id). */
	setLogPath(id: string, logPath: string): void {
		const job = this.jobs.get(id);
		if (job) job.info = { ...job.info, logPath };
	}

	get(id: string): JobInfo | undefined {
		const job = this.jobs.get(id);
		return job ? this.snapshot(job) : undefined;
	}

	/** All jobs, oldest first. */
	list(): JobInfo[] {
		return [...this.jobs.values()].map((j) => this.snapshot(j)).sort((a, b) => a.startedAt - b.startedAt);
	}

	/** Count of currently running jobs. */
	runningCount(): number {
		return [...this.jobs.values()].filter((j) => j.info.status === "running").length;
	}

	/**
	 * Wait for a job to settle. Resolves immediately when already settled;
	 * with a timeout, resolves the current (still-running) snapshot on expiry.
	 */
	wait(id: string, timeoutMs?: number): Promise<JobInfo | undefined> {
		const job = this.jobs.get(id);
		if (!job) return Promise.resolve(undefined);
		if (job.info.status !== "running") return Promise.resolve(this.snapshot(job));
		return new Promise((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			const waiter = (info: JobInfo) => {
				if (timer) clearTimeout(timer);
				resolve(info);
			};
			job.waiters.push(waiter);
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					const index = job.waiters.indexOf(waiter);
					if (index !== -1) job.waiters.splice(index, 1);
					resolve(this.snapshot(job));
				}, timeoutMs);
				timer.unref?.();
			}
		});
	}

	/** Kill a running job. Returns the updated info, or undefined when unknown. */
	kill(id: string): JobInfo | undefined {
		const job = this.jobs.get(id);
		if (!job) return undefined;
		if (job.info.status !== "running") return this.snapshot(job);
		try {
			job.kill?.();
		} catch {
			// The process may already be gone.
		}
		job.info = { ...job.info, status: "killed", completedAt: Date.now() };
		job.kill = undefined;
		for (const waiter of job.waiters.splice(0)) {
			waiter(this.snapshot(job));
		}
		this.notifySettled(job);
		return this.snapshot(job);
	}

	/** Kill every running job (session shutdown). */
	killAll(): void {
		for (const job of this.jobs.values()) {
			if (job.info.status === "running") this.kill(job.info.id);
		}
	}

	/** Subscribe to settled/notice notifications. Returns an unsubscribe function. */
	subscribe(subscriber: Subscriber): () => void {
		this.subscribers.add(subscriber);
		return () => this.subscribers.delete(subscriber);
	}
}
