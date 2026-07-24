/**
 * Built-in slash commands. Each spec carries a two-level (category/name)
 * identity. `handle` is UI-agnostic (rpc/print/tui); `handleTui` is the
 * interactive override (selectors, prompts) used in the TUI.
 */
import type { AgentSession, SessionManager } from "@arbor-space/core";
import type { ParsedSlashCommand, SlashCommandRuntime, SlashCommandSpec } from "./types.ts";
import { CATEGORY_LABELS, CATEGORY_ORDER, type CommandInfo } from "./types.ts";

export const BUILTIN_COMMANDS: readonly SlashCommandSpec[] = [
	// -- session ----------------------------------------------------------
	{
		category: "session",
		name: "new",
		description: "Start a new session",
		handleTui: async (_cmd, { tui, actions }) => {
			if (!(await tui.confirm("New session", "Discard the current session and start fresh?"))) {
				return { consumed: true };
			}
			actions.restart("new");
			return { consumed: true };
		},
	},
	{
		category: "session",
		name: "resume",
		description: "Resume a different session",
		handleTui: async (_cmd, { runtime, tui, actions }) => {
			const { SessionManager } = await import("@arbor-space/core");
			const sessions = await SessionManager.list(runtime.cwd);
			if (sessions.length === 0) {
				await runtime.output("No saved sessions found in this cwd.");
				return { consumed: true };
			}
			const labels = sessions.map(
				(s) => `${s.name ?? s.id.slice(0, 8)}  ${s.messageCount} msgs  ${s.timestamp}`,
			);
			const choice = await tui.select("Resume session", labels);
			if (!choice) return { consumed: true };
			const idx = labels.indexOf(choice);
			const target = sessions[idx];
			if (target) actions.restart("resume", target.path);
			return { consumed: true };
		},
	},
	{
		category: "session",
		name: "fork",
		description: "Fork the current session",
		allowArgs: true,
		handleTui: async (_cmd, { actions }) => {
			actions.restart("fork");
			return { consumed: true };
		},
	},
	{
		category: "session",
		name: "rewind",
		description: "Rewind conversation and workspace to an entry",
		argumentHint: "<entryId>",
		allowArgs: true,
		handle: async (cmd, runtime) => {
			if (!cmd.args) {
				await runtime.output("Usage: /session rewind <entryId>. Use /session tree to list entries.");
				return { consumed: true };
			}
			await runtime.session.rewind(cmd.args);
			await runtime.output(`Rewound to entry ${cmd.args}.`);
			return { consumed: true };
		},
	},
	{
		category: "session",
		name: "tree",
		description: "Show the session entry tree",
		handle: async (_cmd, runtime) => {
			const entries = runtime.session.session.getAllEntries();
			const lines = entries.map((e) => `  ${e.id.slice(0, 8)} ${e.type}`);
			await runtime.output(`Session tree (${entries.length} entries):\n${lines.join("\n")}`);
			return { consumed: true };
		},
	},
	{
		category: "session",
		name: "export",
		description: "Export the session transcript as Markdown",
		argumentHint: "<path>",
		allowArgs: true,
		handle: async (cmd, runtime) => {
			const dest = cmd.args.trim();
			if (!dest) {
				await runtime.output("Usage: /session export <path>");
				return { consumed: true };
			}
			const { writeFile } = await import("node:fs/promises");
			const { resolve } = await import("node:path");
			const md = exportMarkdown(runtime.session.getMessages());
			await writeFile(resolve(runtime.cwd, dest), md, "utf-8");
			await runtime.output(`Exported ${runtime.session.getMessages().length} messages to ${dest}.`);
			return { consumed: true };
		},
	},
	{
		category: "session",
		name: "name",
		description: "Set the session display name",
		argumentHint: "<name>",
		allowArgs: true,
		handle: async (cmd, runtime) => {
			const name = cmd.args.trim();
			if (!name) {
				await runtime.output("Usage: /session name <name>");
				return { consumed: true };
			}
			runtime.session.session.setName(name);
			await runtime.output(`Session named: ${name}`);
			return { consumed: true };
		},
	},

	// -- model ------------------------------------------------------------
	{
		category: "model",
		name: "set",
		description: "Choose a model",
		argumentHint: "<provider/id>",
		allowArgs: true,
		handleTui: async (cmd, { runtime, tui }) => {
			let raw = cmd.args.trim();
			if (!raw) {
				raw = (await tui.input("Switch model", "provider/id")) ?? "";
			}
			if (!raw) return { consumed: true };
			const slash = raw.indexOf("/");
			if (slash === -1) {
				await runtime.output("Use the form provider/id, e.g. anthropic/claude-opus-4-8.");
				return { consumed: true };
			}
			const provider = raw.slice(0, slash);
			const modelId = raw.slice(slash + 1);
			const model = runtime.resolveModel?.(provider, modelId);
			if (!model) {
				await runtime.output(`Model not found: ${provider}/${modelId}`);
				return { consumed: true };
			}
			runtime.session.model = model;
			await runtime.output(`Model set to ${provider}/${modelId}.`);
			return { consumed: true };
		},
	},
	{
		category: "model",
		name: "cycle",
		description: "Cycle to the next known model",
		handleTui: async (_cmd, { runtime }) => {
			const ids = runtime.listModels?.() ?? [];
			if (ids.length === 0) {
				await runtime.output("No models available to cycle.");
				return { consumed: true };
			}
			const current = `${runtime.session.model.provider}/${runtime.session.model.id}`;
			const idx = ids.indexOf(current);
			const next = ids[(idx + 1) % ids.length] ?? ids[0];
			if (!next) return { consumed: true };
			const slash = next.indexOf("/");
			const provider = slash === -1 ? next : next.slice(0, slash);
			const modelId = slash === -1 ? next : next.slice(slash + 1);
			const model = runtime.resolveModel?.(provider, modelId);
			if (!model) {
				await runtime.output(`Model not found: ${next}`);
				return { consumed: true };
			}
			runtime.session.model = model;
			await runtime.output(`Model: ${next}`);
			return { consumed: true };
		},
	},
	{
		category: "model",
		name: "thinking",
		description: "Set thinking level",
		argumentHint: "<level>",
		allowArgs: true,
		handleTui: async (cmd, { runtime, tui }) => {
			const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
			let choice = cmd.args.trim();
			if (!choice) {
				choice = (await tui.select("Thinking level", [...levels])) ?? "off";
			}
			if (!choice || !levels.includes(choice as (typeof levels)[number])) {
				await runtime.output(`Unknown level: ${choice}. Options: ${levels.join(", ")}`);
				return { consumed: true };
			}
			runtime.session.thinkingLevel = choice as (typeof levels)[number];
			await runtime.output(`Thinking level: ${choice}`);
			return { consumed: true };
		},
	},

	// -- context ----------------------------------------------------------
	{
		category: "context",
		name: "compact",
		description: "Manually compact the conversation",
		handle: async (_cmd, runtime) => {
			await runtime.session.compactNow();
			await runtime.output("Context compacted.");
			return { consumed: true };
		},
	},
	{
		category: "context",
		name: "reload",
		description: "Reload AGENTS.md/CLAUDE.md context files",
		handle: async (_cmd, runtime) => {
			runtime.session.reloadContextFiles();
			await runtime.output("Context files reloaded.");
			return { consumed: true };
		},
	},
	{
		category: "context",
		name: "files",
		description: "Show loaded context files",
		handle: async (_cmd, runtime) => {
			await runtime.output(
				"Context files are discovered from ~/.arbor/AGENTS.md then ancestor dirs root→cwd.",
			);
			return { consumed: true };
		},
	},
	{
		category: "context",
		name: "clear",
		description: "Clear the conversation (new session)",
		handleTui: async (_cmd, { tui, actions }) => {
			if (!(await tui.confirm("Clear conversation", "Start a new session and discard this one?"))) {
				return { consumed: true };
			}
			actions.restart("new");
			return { consumed: true };
		},
	},
	{
		category: "skill",
		name: "skill",
		description: "Insert a skill into the input (review before sending)",
		handleTui: async (_cmd, { runtime, tui, actions }) => {
			const skills = runtime.session.skills;
			if (skills.length === 0) {
				await runtime.output(
					"No skills discovered. Add SKILL.md files under ~/.arbor/skills or .arbor/skills.",
				);
				return { consumed: true };
			}
			const choice = await tui.select(
				"Insert skill",
				skills.map((s) => s.name),
			);
			if (!choice) return { consumed: true };
			// Add the invocation token to the input — NOT sent. The user appends
			// their task and sends; the TUI expands /skill:<name> at submit time.
			actions.setInput(`/skill:${choice} `);
			return { consumed: true };
		},
	},

	// -- mode -------------------------------------------------------------
	{
		category: "mode",
		name: "build",
		description: "Switch to build mode (full toolset)",
		handle: async (_cmd, runtime) => {
			runtime.session.mode = "build";
			await runtime.output("Mode: build");
			return { consumed: true };
		},
	},
	{
		category: "mode",
		name: "plan",
		description: "Switch to plan mode (read-only, propose a plan)",
		handle: async (_cmd, runtime) => {
			runtime.session.mode = "plan";
			await runtime.output("Mode: plan");
			return { consumed: true };
		},
	},

	// -- tools ------------------------------------------------------------
	{
		category: "tools",
		name: "list",
		description: "List available tools",
		handle: async (_cmd, runtime) => {
			const ext = runtime.session.extensions.getTools().map((t) => t.name);
			const builtins = "read bash edit write grep find ls todo";
			await runtime.output(`Builtins: ${builtins}\nExtension: ${ext.length ? ext.join(", ") : "(none)"}`);
			return { consumed: true };
		},
	},
	{
		category: "tools",
		name: "mcp",
		description: "List discovered MCP servers",
		handleTui: async (_cmd, { runtime }) => {
			const { discoverMcpConfig } = await import("@arbor-space/core");
			const config = await discoverMcpConfig({ cwd: runtime.cwd });
			const names = Object.keys(config.mcpServers);
			if (names.length === 0) {
				await runtime.output("No MCP servers configured. Add mcpServers to .arbor/mcp.json or .mcp.json.");
				return { consumed: true };
			}
			const lines = names.map((n) => {
				const s = config.mcpServers[n] as { command?: string; url?: string; transport?: string };
				const detail = s.command ?? s.url ?? s.transport ?? "(unknown transport)";
				return `  ${n}  ${detail}`;
			});
			await runtime.output(`MCP servers (${names.length}):\n${lines.join("\n")}`);
			return { consumed: true };
		},
	},

	// -- display ----------------------------------------------------------
	{ category: "display", name: "diff", description: "Toggle diff view style (unified/split)" },
	{ category: "display", name: "expand", description: "Toggle tool output expansion" },
	{
		category: "display",
		name: "theme",
		description: "Choose a theme",
		handleTui: async (_cmd, { runtime }) => {
			await runtime.output("Only the dark theme ships in v1 (light/high-contrast is future work).");
			return { consumed: true };
		},
	},

	// -- help -------------------------------------------------------------
	{
		category: "help",
		name: "help",
		description: "Show available commands",
		handle: async (_cmd, runtime) => {
			await runtime.output(formatHelp());
			return { consumed: true };
		},
	},
	{
		category: "help",
		name: "keys",
		description: "Show keyboard shortcuts",
		handleTui: async (_cmd, { runtime }) => {
			await runtime.output(KEY_REFERENCE);
			return { consumed: true };
		},
	},
	{
		category: "help",
		name: "quit",
		description: "Quit Arbor",
		handle: async (_cmd, runtime) => {
			await runtime.output("Goodbye. (In interactive mode this exits the TUI.)");
			return { consumed: true };
		},
	},
];

export function builtinCommandInfos(): CommandInfo[] {
	return BUILTIN_COMMANDS.map((c) => ({
		category: c.category,
		name: c.name,
		...(c.aliases ? { aliases: c.aliases } : {}),
		description: c.description,
		...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
	}));
}

const KEY_REFERENCE = `Keyboard shortcuts (interactive mode):

  Enter          Send / queue as steering while running / abort on empty
  Esc            Withdraw queued message / rewind just-sent message
  Ctrl+C         Abort + quit
  Ctrl+T         Cycle main <-> subagent views
  Ctrl+O         Toggle expanded bash output
  /              Open the command palette
  Up/Down        Move palette selection
`;

export function formatHelp(): string {
	const byCategory = new Map<string, CommandInfo[]>();
	for (const info of builtinCommandInfos()) {
		const list = byCategory.get(info.category) ?? [];
		list.push(info);
		byCategory.set(info.category, list);
	}
	const sections = CATEGORY_ORDER.map((cat) => {
		const infos = byCategory.get(cat);
		if (!infos || infos.length === 0) return "";
		const lines = infos.map((c) => {
			const hint = c.argumentHint ? ` ${c.argumentHint}` : "";
			return `  /${c.category} ${c.name}${hint}`.padEnd(32) + c.description;
		});
		return `${CATEGORY_LABELS[cat]}:\n${lines.join("\n")}`;
	}).filter((s) => s.length > 0);
	return `Commands (category/name):\n\n${sections.join("\n\n")}`;
}

/** Render the session transcript as Markdown for `/session export`. */
function exportMarkdown(messages: readonly { role?: string; content?: unknown }[]): string {
	const lines: string[] = [`# Arbor session export`, ""];
	for (const msg of messages) {
		const role = msg.role ?? "unknown";
		const text =
			typeof msg.content === "string"
				? msg.content
				: Array.isArray(msg.content)
					? (msg.content as { type?: string; text?: string; thinking?: string }[])
							.map((b) =>
								b.type === "text"
									? (b.text ?? "")
									: b.type === "thinking"
										? `> ${b.thinking ?? ""}`
										: b.type
											? `[${b.type}]`
											: "",
							)
							.join("\n")
					: "";
		lines.push(`## ${role}`, "", text, "");
	}
	return lines.join("\n");
}

/** Build the runtime handed to command handlers. */
export function createRuntime(
	session: AgentSession,
	sessionManager: SessionManager,
	cwd: string,
	output: SlashCommandRuntime["output"],
): SlashCommandRuntime {
	return { session, sessionManager, cwd, output };
}

// Re-export for callers that imported from here previously.
export type { ParsedSlashCommand };
