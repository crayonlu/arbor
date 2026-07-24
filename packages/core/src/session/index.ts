/** Session subsystem: tree-structured JSONL sessions, shadow-git snapshots, rewind. */
export type { CompactionResult, CompactionSettings } from "./compaction.ts";
export {
	compactMessages,
	DEFAULT_KEEP_RECENT_TOKENS,
	DEFAULT_RESERVE_TOKENS,
	estimateTokens,
	findCutPoint,
	shouldCompact,
} from "./compaction.ts";
export type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	MessageEntry,
	ModelChangeEntry,
	RewindEntry,
	SessionEntry,
	SessionEntryBase,
	SessionHeader,
	SessionLine,
	SnapshotEntry,
} from "./entries.ts";
export { generateEntryId, isSessionEntry, SESSION_VERSION } from "./entries.ts";
export type { SessionInfo, SessionManagerOptions } from "./manager.ts";
export { defaultSessionsRoot, encodeSessionDir, SessionManager } from "./manager.ts";
export type { RewindResult, RewindTarget } from "./rewind.ts";
export { listRewindTargets, rewindSession } from "./rewind.ts";
export type { GitResult, SnapshotOptions } from "./snapshot.ts";
export { SnapshotManager } from "./snapshot.ts";
export { cleanTitle, generateSessionTitle } from "./title.ts";
