/**
 * Slash command registry: merges builtins with extension-registered commands
 * (categorized as "extension"). Dedupes by name — builtins win over extension
 * commands so an extension can't shadow `/compact` etc.
 */
import type { AgentSession } from "@arbor-space/core";
import { BUILTIN_COMMANDS, builtinCommandInfos } from "./builtin.ts";
import type { CommandInfo, ParsedSlashCommand, SlashCommandSpec } from "./types.ts";
import { parseSlashCommand } from "./types.ts";

/** All available command infos (builtins + extension), deduped. */
export function listCommands(session?: AgentSession): CommandInfo[] {
	const infos: CommandInfo[] = [];
	const seen = new Set<string>();

	for (const info of builtinCommandInfos()) {
		if (seen.has(info.name)) continue;
		seen.add(info.name);
		infos.push(info);
	}

	if (session) {
		for (const [name, command] of session.extensions.getCommands()) {
			if (seen.has(name)) continue; // builtins win
			seen.add(name);
			infos.push({ category: "extension", name, description: command.description });
		}
	}

	return infos;
}

/** Find a builtin spec by category + name. */
export function findBuiltin(category: string, name: string): SlashCommandSpec | undefined {
	return BUILTIN_COMMANDS.find(
		(c) => c.category === category && (c.name === name || c.aliases?.includes(name)),
	);
}

export { type ParsedSlashCommand, parseSlashCommand };
