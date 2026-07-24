/**
 * Job output log store: background job output goes to disk, not into the
 * conversation. Notifications carry the path + a tail; the model reads the
 * full log with the read tool when needed.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { open, readdir, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface JobLog {
	path: string;
	append(chunk: string | Buffer): void;
	close(): Promise<void>;
}

export function defaultJobLogsRoot(): string {
	return path.join(os.homedir(), ".arbor", "tasks");
}

/** Create the append-only log file for a job. */
export function createJobLog(jobId: string, root?: string): JobLog {
	const dir = root ?? defaultJobLogsRoot();
	mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${jobId}.log`);
	let stream: WriteStream | null = createWriteStream(filePath, { flags: "a" });
	return {
		path: filePath,
		append(chunk) {
			stream?.write(chunk);
		},
		close() {
			return new Promise((resolve) => {
				const current = stream;
				stream = null;
				if (!current) return resolve();
				current.end(() => resolve());
			});
		},
	};
}

/** Read up to `bytes` from the end of a log file. */
export async function tailJobLog(filePath: string, bytes = 2048): Promise<string> {
	const fileStat = await stat(filePath).catch(() => null);
	if (!fileStat || fileStat.size === 0) return "";
	const start = Math.max(0, fileStat.size - bytes);
	const length = fileStat.size - start;
	const handle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, start);
		return buffer.toString("utf-8");
	} finally {
		await handle.close();
	}
}

/** Delete job logs older than `maxAgeDays` to bound disk usage. */
export async function pruneJobLogs(root?: string, maxAgeDays = 7): Promise<number> {
	const dir = root ?? defaultJobLogsRoot();
	const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
	const files = await readdir(dir).catch(() => []);
	let removed = 0;
	for (const file of files) {
		if (!file.endsWith(".log")) continue;
		const filePath = path.join(dir, file);
		const fileStat = await stat(filePath).catch(() => null);
		if (fileStat && fileStat.mtimeMs < cutoff) {
			await rm(filePath, { force: true });
			removed++;
		}
	}
	return removed;
}
