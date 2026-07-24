/**
 * Rewind: move the conversation and the workspace back to an earlier point
 * together. The session tree provides the conversation side; the shadow git
 * repository provides the file side.
 */
import type { RewindEntry, SessionEntry } from "./entries.ts";
import type { SessionManager } from "./manager.ts";
import type { SnapshotManager } from "./snapshot.ts";

export interface RewindResult {
	entry: RewindEntry;
	/** Whether workspace files were restored from a snapshot. */
	filesRestored: boolean;
	/** The snapshot commit used for the file restore, if any. */
	snapshotCommit?: string;
}

export interface RewindTarget {
	entry: SessionEntry;
	/** Human-readable one-line description for pickers. */
	label: string;
}

/** List entries on the active path that make sense as rewind targets (user messages). */
export function listRewindTargets(session: SessionManager): RewindTarget[] {
	const targets: RewindTarget[] = [];
	for (const entry of session.getActivePath()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role !== "user") continue;
		const text =
			typeof message.content === "string" ? message.content : JSON.stringify(message.content).slice(0, 80);
		targets.push({ entry, label: text.split("\n")[0]?.slice(0, 80) ?? "" });
	}
	return targets;
}

/**
 * Rewind conversation and files to `targetId`.
 *
 * The conversation leaf moves to the target entry. Files are restored from
 * the nearest snapshot at or above the target — snapshots are taken before
 * each user turn, so the nearest snapshot represents the workspace as it was
 * when that part of the conversation happened.
 */
export async function rewindSession(
	session: SessionManager,
	snapshots: SnapshotManager | null,
	targetId: string,
): Promise<RewindResult> {
	const snapshot = session.findNearestSnapshot(targetId);
	let filesRestored = false;
	if (snapshots && snapshot) {
		await snapshots.restore(snapshot.commit);
		filesRestored = true;
	}
	const entry = session.rewindTo(targetId, filesRestored);
	return {
		entry,
		filesRestored,
		...(snapshot ? { snapshotCommit: snapshot.commit } : {}),
	};
}
