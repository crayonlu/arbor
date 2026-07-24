/**
 * Resolve a SessionManager from the --continue/--resume/--session/--no-session
 * flags. Mirrors pi's resolution order but uses Arbor's SessionManager API.
 *
 * - --no-session      → in-memory (ephemeral)
 * - --session <id|path> → open by path or id-prefix
 * - --continue        → most recent session for this cwd
 * - --resume          → list sessions, pick via a numbered prompt
 * - (default)         → create a new persisted session
 */
import { createInterface } from "node:readline";
import { type SessionInfo, SessionManager } from "@arbor-space/core";

export interface ResolveOptions {
	cwd: string;
	continueRecent?: boolean;
	resume?: boolean;
	session?: string;
	noSession?: boolean;
	sessionsRoot?: string;
	/** When false, --resume's picker is unavailable (headless); list + exit. */
	interactive?: boolean;
}

export interface ResolveResult {
	manager: SessionManager;
	created: boolean;
}

export async function resolveSession(options: ResolveOptions): Promise<ResolveResult> {
	const { cwd, sessionsRoot } = options;

	if (options.noSession) {
		return { manager: SessionManager.inMemory(cwd), created: true };
	}

	if (options.session) {
		const manager = await openBySessionArg(options.session, cwd, sessionsRoot);
		return { manager, created: false };
	}

	if (options.continueRecent) {
		const recent = await SessionManager.mostRecent(cwd, sessionsRoot);
		if (!recent) {
			throw new Error("No previous session to continue in this directory.");
		}
		return { manager: SessionManager.load(recent.path), created: false };
	}

	if (options.resume) {
		const sessions = await SessionManager.list(cwd, sessionsRoot);
		if (sessions.length === 0) {
			throw new Error("No sessions found in this directory.");
		}
		if (!options.interactive) {
			throw new Error("--resume requires an interactive terminal; use --session <id|path> in headless mode.");
		}
		const chosen = await pickSession(sessions);
		if (!chosen) throw new Error("No session selected.");
		return { manager: SessionManager.load(chosen.path), created: false };
	}

	return { manager: SessionManager.create(cwd, sessionsRoot ? { sessionsRoot } : {}), created: true };
}

async function openBySessionArg(arg: string, cwd: string, sessionsRoot?: string): Promise<SessionManager> {
	// Looks like a file path → open directly.
	if (arg.includes("/") || arg.includes("\\") || arg.endsWith(".jsonl")) {
		return SessionManager.load(arg);
	}
	// Else match by exact id, then id-prefix, within this cwd.
	const sessions = await SessionManager.list(cwd, sessionsRoot);
	const match = sessions.find((s) => s.id === arg) ?? sessions.find((s) => s.id.startsWith(arg));
	if (!match) {
		throw new Error(`No session found matching '${arg}'.`);
	}
	return SessionManager.load(match.path);
}

async function pickSession(sessions: SessionInfo[]): Promise<SessionInfo | undefined> {
	const lines = sessions.map((s, i) => {
		const name = s.name ? `${s.name} ` : "";
		return `  [${i + 1}] ${name}(${s.id.slice(0, 8)}) ${s.messageCount} msgs`;
	});
	process.stderr.write(`Resume a session:\n${lines.join("\n")}\n> `);

	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		rl.question("", (answer) => {
			rl.close();
			const index = Number.parseInt(answer.trim(), 10) - 1;
			resolve(Number.isNaN(index) ? undefined : sessions[index]);
		});
	});
}
