/**
 * Slash command dispatch. Invocation is two-level: `/<category> <name> [args]`.
 * Resolves to a builtin spec and runs its `handle` (UI-agnostic); builtin specs
 * without a `handle` resolve to `tui_only` (the TUI supplies `handleTui` in
 * M6.5). Falls back to a flat `/<name> [args]` extension command lookup.
 */
import type { AgentSession, SessionManager } from "@arbor-space/core";
import { findBuiltin } from "./registry.ts";
import {
	parseSlashCommand,
	type SlashCommandOutcome,
	type SlashCommandRuntime,
	type TuiSlashCommandRuntime,
} from "./types.ts";

/** Resolve a builtin spec for a parsed command, applying the bare-`/category` fallback. */
function resolveBuiltin(parsed: { category: string; name: string }) {
	return findBuiltin(parsed.category, parsed.name) ?? findBuiltin(parsed.category, parsed.category);
}

/** Execute a `/<category> <name> [args]` string against the runtime. */
export async function executeSlashCommand(
	text: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandOutcome> {
	const parsed = parseSlashCommand(text);
	if (!parsed.category) return { kind: "unknown", name: "" };

	const spec = resolveBuiltin(parsed);
	if (spec) {
		if (!spec.handle) {
			return { kind: "tui_only", name: `${parsed.category} ${spec.name}` };
		}
		const result = await spec.handle(parsed, runtime);
		return outcome(result);
	}

	// Not a builtin — try a flat extension-registered command: `/<name> [args]`.
	const extArgs = [parsed.name, parsed.args].filter(Boolean).join(" ");
	const invoked = await runtime.session.invokeExtensionCommand(parsed.category, extArgs);
	if (invoked) return { kind: "consumed" };
	return { kind: "unknown", name: parsed.category };
}

/** Execute with a TUI runtime: prefers `handleTui`, falls back to `handle`. */
export async function executeSlashCommandTui(
	text: string,
	tuiRuntime: TuiSlashCommandRuntime,
): Promise<SlashCommandOutcome> {
	const parsed = parseSlashCommand(text);
	if (!parsed.category) return { kind: "unknown", name: "" };

	const spec = resolveBuiltin(parsed);
	if (spec) {
		if (spec.handleTui) {
			const result = await spec.handleTui(parsed, tuiRuntime);
			return outcome(result);
		}
		if (spec.handle) {
			const result = await spec.handle(parsed, tuiRuntime.runtime);
			return outcome(result);
		}
		return { kind: "tui_only", name: `${parsed.category} ${spec.name}` };
	}

	const extArgs = [parsed.name, parsed.args].filter(Boolean).join(" ");
	const invoked = await tuiRuntime.runtime.session.invokeExtensionCommand(parsed.category, extArgs);
	return invoked ? { kind: "consumed" } : { kind: "unknown", name: parsed.category };
}

function outcome(result: undefined | { consumed: true } | { prompt: string }): SlashCommandOutcome {
	if (result === undefined) return { kind: "consumed" };
	if ("prompt" in result) return { kind: "prompt", text: result.prompt };
	return { kind: "consumed" };
}

/** Build the UI-agnostic runtime handed to `handle`. */
export function createSlashRuntime(
	session: AgentSession,
	sessionManager: SessionManager,
	opts: {
		cwd?: string;
		output: SlashCommandRuntime["output"];
		refreshCommands?: SlashCommandRuntime["refreshCommands"];
		resolveModel?: SlashCommandRuntime["resolveModel"];
	},
): SlashCommandRuntime {
	return {
		cwd: opts.cwd ?? session.cwd,
		session,
		sessionManager,
		output: opts.output,
		...(opts.refreshCommands ? { refreshCommands: opts.refreshCommands } : {}),
		...(opts.resolveModel ? { resolveModel: opts.resolveModel } : {}),
	};
}
