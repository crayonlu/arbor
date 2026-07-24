/**
 * Session entry types.
 *
 * A session is an append-only JSONL file. The first line is a header; every
 * following line is an entry with `id`/`parentId` forming a tree. The current
 * position is the active leaf — rewinding moves the leaf pointer without
 * deleting data, and new entries branch naturally from any point.
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../types.ts";

export const SESSION_VERSION = 1;

/** First line of a session file. Metadata only, not part of the tree. */
export interface SessionHeader {
	type: "session";
	version: number;
	/** Session UUID. */
	id: string;
	timestamp: string;
	cwd: string;
	/** Present for sessions created via fork. */
	parentSession?: string;
	/** Display name (set via --name or /name). */
	name?: string;
}

export interface SessionEntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
}

/** A conversation message (user/assistant/toolResult/custom). */
export interface MessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

/** The user switched models mid-session. */
export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

/** Context was compacted: a summary replaces entries before this point. */
export interface CompactionEntry extends SessionEntryBase {
	type: "compaction";
	summary: string;
	tokensBefore: number;
	/** Usage from generating the summary. */
	usage?: Usage;
	/** True when produced by an extension rather than the built-in compactor. */
	fromExtension?: boolean;
}

/** Summary of an abandoned branch, written when jumping across the tree. */
export interface BranchSummaryEntry extends SessionEntryBase {
	type: "branch_summary";
	/** Leaf entry of the branch that was abandoned. */
	fromId: string;
	summary: string;
	usage?: Usage;
}

/** Shadow-git snapshot anchor: workspace state at this conversation point. */
export interface SnapshotEntry extends SessionEntryBase {
	type: "snapshot";
	/** Commit hash in the shadow repository. */
	commit: string;
}

/** A rewind marker: the leaf moved to `toId` and files were restored. */
export interface RewindEntry extends SessionEntryBase {
	type: "rewind";
	/** Entry the session rewound from (previous leaf). */
	fromId: string;
	/** Whether workspace files were restored from a snapshot. */
	filesRestored: boolean;
}

/** Extension-persisted state. Survives restarts; replayed on load. */
export interface CustomEntry extends SessionEntryBase {
	type: "custom";
	customType: string;
	data: unknown;
}

export type SessionEntry =
	| MessageEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| SnapshotEntry
	| RewindEntry
	| CustomEntry;

export type SessionLine = SessionHeader | SessionEntry;

const ENTRY_TYPES: ReadonlySet<string> = new Set([
	"message",
	"model_change",
	"compaction",
	"branch_summary",
	"snapshot",
	"rewind",
	"custom",
]);

export function isSessionEntry(line: SessionLine): line is SessionEntry {
	return ENTRY_TYPES.has(line.type);
}

/** Random 8-char hex entry id (collision-checked by the caller against the file). */
export function generateEntryId(): string {
	return Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}
