/**
 * SessionManager: append-only JSONL session files with a tree structure.
 *
 * Entries link via id/parentId; the manager tracks the active leaf. Rewind
 * moves the leaf pointer (data is never deleted); branching happens by
 * appending an entry whose parentId points to a non-leaf entry.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "../types.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	MessageEntry,
	ModelChangeEntry,
	RewindEntry,
	SessionEntry,
	SessionHeader,
	SessionLine,
	SnapshotEntry,
} from "./entries.ts";
import { generateEntryId, isSessionEntry, SESSION_VERSION } from "./entries.ts";

export interface SessionInfo {
	path: string;
	id: string;
	name?: string;
	cwd: string;
	timestamp: string;
	messageCount: number;
}

/** Encode a working directory into a filesystem-safe directory name. */
export function encodeSessionDir(cwd: string): string {
	return `--${cwd.replaceAll("/", "-").replaceAll("\\", "-")}--`;
}

export function defaultSessionsRoot(): string {
	return path.join(os.homedir(), ".arbor", "sessions");
}

export interface SessionManagerOptions {
	/** Root directory for session storage. Default: ~/.arbor/sessions */
	sessionsRoot?: string;
	/** Do not persist anything (ephemeral session). */
	ephemeral?: boolean;
}

export class SessionManager {
	readonly cwd: string;
	readonly filePath: string | null;
	private header: SessionHeader;
	private entries = new Map<string, SessionEntry>();
	private order: string[] = [];
	private leafId: string | null = null;

	private constructor(cwd: string, filePath: string | null, header: SessionHeader) {
		this.cwd = cwd;
		this.filePath = filePath;
		this.header = header;
	}

	/** Create a new session (persisted unless `ephemeral`). */
	static create(cwd: string, options: SessionManagerOptions = {}): SessionManager {
		const header: SessionHeader = {
			type: "session",
			version: SESSION_VERSION,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			cwd,
		};
		let filePath: string | null = null;
		if (!options.ephemeral) {
			const dir = path.join(options.sessionsRoot ?? defaultSessionsRoot(), encodeSessionDir(cwd));
			mkdirSync(dir, { recursive: true });
			const stamp = header.timestamp.replaceAll(":", "-").replaceAll(".", "-");
			filePath = path.join(dir, `${stamp}_${header.id}.jsonl`);
			appendFileSync(filePath, `${JSON.stringify(header)}\n`, "utf-8");
		}
		return new SessionManager(cwd, filePath, header);
	}

	/** Create an in-memory session (never persisted). */
	static inMemory(cwd = process.cwd()): SessionManager {
		return SessionManager.create(cwd, { ephemeral: true });
	}

	/** Load an existing session file. The leaf becomes the last entry in file order. */
	static load(filePath: string): SessionManager {
		const lines = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0);
		if (lines.length === 0) {
			throw new Error(`Empty session file: ${filePath}`);
		}
		const header = JSON.parse(lines[0] as string) as SessionHeader;
		if (header.type !== "session") {
			throw new Error(`Not a session file (missing header): ${filePath}`);
		}
		const manager = new SessionManager(header.cwd, filePath, header);
		for (const line of lines.slice(1)) {
			const parsed = JSON.parse(line) as SessionLine;
			if (isSessionEntry(parsed)) {
				manager.entries.set(parsed.id, parsed);
				manager.order.push(parsed.id);
			}
		}
		const lastId = manager.order.at(-1);
		manager.leafId = lastId ?? null;
		// A trailing rewind entry moves the leaf to its recorded target's parent chain.
		const last = lastId ? manager.entries.get(lastId) : undefined;
		if (last?.type === "rewind") {
			manager.leafId = last.parentId;
		}
		return manager;
	}

	/**
	 * Fork an existing session file into a new session: copies the header
	 * lineage and all entries, then continues in a new file.
	 */
	static fork(sourcePath: string, options: SessionManagerOptions = {}): SessionManager {
		const source = SessionManager.load(sourcePath);
		const header: SessionHeader = {
			type: "session",
			version: SESSION_VERSION,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			cwd: source.cwd,
			parentSession: sourcePath,
		};
		let filePath: string | null = null;
		if (!options.ephemeral) {
			const dir = path.join(options.sessionsRoot ?? defaultSessionsRoot(), encodeSessionDir(source.cwd));
			mkdirSync(dir, { recursive: true });
			const stamp = header.timestamp.replaceAll(":", "-").replaceAll(".", "-");
			filePath = path.join(dir, `${stamp}_${header.id}.jsonl`);
			appendFileSync(filePath, `${JSON.stringify(header)}\n`, "utf-8");
		}
		const manager = new SessionManager(source.cwd, filePath, header);
		for (const id of source.order) {
			const entry = source.entries.get(id) as SessionEntry;
			manager.entries.set(id, entry);
			manager.order.push(id);
			if (filePath) {
				appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
			}
		}
		manager.leafId = source.leafId;
		return manager;
	}

	/** List sessions stored for a working directory, newest first. */
	static async list(cwd: string, sessionsRoot?: string): Promise<SessionInfo[]> {
		const dir = path.join(sessionsRoot ?? defaultSessionsRoot(), encodeSessionDir(cwd));
		if (!existsSync(dir)) return [];
		const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
		const infos: SessionInfo[] = [];
		for (const file of files) {
			const filePath = path.join(dir, file);
			try {
				const manager = SessionManager.load(filePath);
				infos.push({
					path: filePath,
					id: manager.header.id,
					...(manager.header.name !== undefined ? { name: manager.header.name } : {}),
					cwd: manager.header.cwd,
					timestamp: manager.header.timestamp,
					messageCount: manager.order.filter((id) => manager.entries.get(id)?.type === "message").length,
				});
			} catch {
				// Skip unreadable files.
			}
		}
		infos.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
		return infos;
	}

	/** Most recent session for a working directory, if any. */
	static async mostRecent(cwd: string, sessionsRoot?: string): Promise<SessionInfo | undefined> {
		const sessions = await SessionManager.list(cwd, sessionsRoot);
		return sessions[0];
	}

	get sessionId(): string {
		return this.header.id;
	}

	get name(): string | undefined {
		return this.header.name;
	}

	/**
	 * Set the session display name. Persisted sessions get their header line
	 * rewritten atomically (temp file + rename).
	 */
	setName(name: string): void {
		this.header = { ...this.header, name };
		if (!this.filePath) return;
		const content = readFileSync(this.filePath, "utf-8");
		const newlineIndex = content.indexOf("\n");
		const rest = newlineIndex === -1 ? "" : content.slice(newlineIndex + 1);
		const updated = `${JSON.stringify(this.header)}\n${rest}`;
		const tempPath = `${this.filePath}.tmp`;
		writeFileSync(tempPath, updated, "utf-8");
		renameSync(tempPath, this.filePath);
	}

	get leaf(): string | null {
		return this.leafId;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.entries.get(id);
	}

	/** All entries in append order (the full tree, not just the active path). */
	getAllEntries(): SessionEntry[] {
		return this.order.map((id) => this.entries.get(id) as SessionEntry);
	}

	/** Entries on the active path: root → leaf. */
	getActivePath(): SessionEntry[] {
		const result: SessionEntry[] = [];
		let currentId = this.leafId;
		while (currentId) {
			const entry = this.entries.get(currentId);
			if (!entry) break;
			result.push(entry);
			currentId = entry.parentId;
		}
		return result.reverse();
	}

	/**
	 * Rebuild the message context for the active path. Applies compaction
	 * entries: the newest compaction on the path replaces everything before it
	 * with its summary message.
	 */
	buildContextMessages(): AgentMessage[] {
		const activePath = this.getActivePath();
		// Find the newest compaction on the path.
		let compactionIndex = -1;
		for (let i = activePath.length - 1; i >= 0; i--) {
			if ((activePath[i] as SessionEntry).type === "compaction") {
				compactionIndex = i;
				break;
			}
		}

		const messages: AgentMessage[] = [];
		if (compactionIndex >= 0) {
			const compaction = activePath[compactionIndex] as CompactionEntry;
			messages.push({
				role: "user",
				content: `[Conversation summary from earlier context]\n\n${compaction.summary}`,
				timestamp: Date.parse(compaction.timestamp),
			});
		}
		for (const entry of activePath.slice(compactionIndex + 1)) {
			if (entry.type === "message") {
				messages.push(entry.message);
			} else if (entry.type === "branch_summary") {
				messages.push({
					role: "user",
					content: `[Summary of an abandoned conversation branch]\n\n${entry.summary}`,
					timestamp: Date.parse(entry.timestamp),
				});
			}
		}
		return messages;
	}

	private newId(): string {
		let id = generateEntryId();
		while (this.entries.has(id)) id = generateEntryId();
		return id;
	}

	private append<T extends SessionEntry>(entry: T): T {
		this.entries.set(entry.id, entry);
		this.order.push(entry.id);
		this.leafId = entry.id;
		if (this.filePath) {
			appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
		}
		return entry;
	}

	private base(): { id: string; parentId: string | null; timestamp: string } {
		return { id: this.newId(), parentId: this.leafId, timestamp: new Date().toISOString() };
	}

	appendMessage(message: AgentMessage): MessageEntry {
		return this.append({ type: "message", ...this.base(), message });
	}

	appendModelChange(provider: string, modelId: string): ModelChangeEntry {
		return this.append({ type: "model_change", ...this.base(), provider, modelId });
	}

	appendCompaction(input: Omit<CompactionEntry, "type" | "id" | "parentId" | "timestamp">): CompactionEntry {
		return this.append({ type: "compaction", ...this.base(), ...input });
	}

	appendBranchSummary(fromId: string, summary: string): BranchSummaryEntry {
		return this.append({ type: "branch_summary", ...this.base(), fromId, summary });
	}

	appendSnapshot(commit: string): SnapshotEntry {
		return this.append({ type: "snapshot", ...this.base(), commit });
	}

	appendCustom(customType: string, data: unknown): CustomEntry {
		return this.append({ type: "custom", ...this.base(), customType, data });
	}

	/**
	 * Move the active leaf to `targetId` (any entry in the tree). Appends a
	 * rewind marker so the move survives reload, then returns the closest
	 * snapshot at or above the target for file restoration.
	 */
	rewindTo(targetId: string, filesRestored: boolean): RewindEntry {
		if (!this.entries.has(targetId)) {
			throw new Error(`Unknown entry id: ${targetId}`);
		}
		const fromId = this.leafId;
		const entry: RewindEntry = {
			type: "rewind",
			id: this.newId(),
			// The rewind entry's parent IS the rewind target: future entries
			// branch from there.
			parentId: targetId,
			timestamp: new Date().toISOString(),
			fromId: fromId ?? "",
			filesRestored,
		};
		this.entries.set(entry.id, entry);
		this.order.push(entry.id);
		if (this.filePath) {
			appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
		}
		// Leaf moves to the target; the rewind marker itself is not on the path.
		this.leafId = targetId;
		return entry;
	}

	/** Find the nearest snapshot entry at or above `fromId` on the tree path. */
	findNearestSnapshot(fromId: string | null): SnapshotEntry | undefined {
		let currentId = fromId;
		while (currentId) {
			const entry = this.entries.get(currentId);
			if (!entry) return undefined;
			if (entry.type === "snapshot") return entry;
			currentId = entry.parentId;
		}
		return undefined;
	}
}
