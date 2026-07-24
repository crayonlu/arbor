/**
 * CLI argument parsing. Hand-rolled (no commander) so unknown flags can be
 * collected for extensions and `@file` args are first-class. Supports both
 * `--flag value` and `--flag=value`.
 */

export interface Args {
	provider?: string;
	model?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	continueRecent?: boolean;
	resume?: boolean;
	session?: string;
	noSession?: boolean;
	name?: string;
	tools?: string[];
	excludeTools?: string[];
	noContextFiles?: boolean;
	mode?: "text" | "json" | "rpc";
	print?: boolean;
	json?: boolean;
	outputFormat?: "text" | "json";
	help?: boolean;
	version?: boolean;
	verbose?: boolean;
	fileArgs: string[];
	messages: string[];
	unknownFlags: Map<string, boolean | string>;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		fileArgs: [],
		messages: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};

	const takesValue = (flag: string): boolean => {
		switch (flag) {
			case "--provider":
			case "--model":
			case "--system-prompt":
			case "--append-system-prompt":
			case "--session":
			case "--name":
			case "--mode":
			case "--tools":
			case "--exclude-tools":
			case "--output-format":
				return true;
			default:
				return false;
		}
	};

	const shortFlags: Record<string, string> = {
		"-p": "--print",
		"-c": "--continue",
		"-r": "--resume",
		"-n": "--name",
		"-h": "--help",
		"-v": "--version",
		"-t": "--tools",
		"-xt": "--exclude-tools",
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;

		// Normalize short flags.
		const normalized = shortFlags[arg] ?? arg;

		if (normalized === "--help" || normalized === "-h") {
			result.help = true;
		} else if (normalized === "--version") {
			result.version = true;
		} else if (normalized === "--print") {
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
				result.messages.push(next);
				i++;
			}
		} else if (normalized === "--json") {
			result.json = true;
		} else if (normalized === "--continue") {
			result.continueRecent = true;
		} else if (normalized === "--resume") {
			result.resume = true;
		} else if (normalized === "--no-session") {
			result.noSession = true;
		} else if (normalized === "--no-context-files") {
			result.noContextFiles = true;
		} else if (normalized === "--verbose") {
			result.verbose = true;
		} else if (normalized.startsWith("@")) {
			result.fileArgs.push(arg.slice(1));
		} else if (normalized.startsWith("--")) {
			const eqIndex = normalized.indexOf("=");
			if (eqIndex !== -1) {
				const name = normalized.slice(0, eqIndex);
				const value = normalized.slice(eqIndex + 1);
				applyNamed(result, name, value);
			} else if (takesValue(normalized)) {
				const value = args[i + 1];
				if (value === undefined || value.startsWith("-")) {
					result.diagnostics.push({ type: "error", message: `${normalized} requires a value` });
				} else {
					applyNamed(result, normalized, value);
					i++;
				}
			} else {
				applyNamed(result, normalized, true);
			}
		} else if (normalized.startsWith("-") && normalized !== "-") {
			result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
		} else {
			result.messages.push(arg);
		}
	}

	return result;
}

function applyNamed(result: Args, name: string, value: string | boolean): void {
	switch (name) {
		case "--provider":
			if (typeof value === "string") result.provider = value;
			break;
		case "--model":
			if (typeof value === "string") result.model = value;
			break;
		case "--system-prompt":
			if (typeof value === "string") result.systemPrompt = value;
			break;
		case "--append-system-prompt":
			if (typeof value === "string") {
				result.appendSystemPrompt = result.appendSystemPrompt ?? [];
				result.appendSystemPrompt.push(value);
			}
			break;
		case "--session":
			if (typeof value === "string") result.session = value;
			break;
		case "--name":
			if (typeof value === "string") result.name = value;
			break;
		case "--mode":
			if (value === "text" || value === "json" || value === "rpc") result.mode = value;
			else result.diagnostics.push({ type: "warning", message: `Invalid --mode: ${String(value)}` });
			break;
		case "--tools":
			if (typeof value === "string") result.tools = splitCsv(value);
			break;
		case "--exclude-tools":
			if (typeof value === "string") result.excludeTools = splitCsv(value);
			break;
		case "--output-format":
			if (value === "text" || value === "json") result.outputFormat = value;
			else result.diagnostics.push({ type: "warning", message: `Invalid --output-format: ${String(value)}` });
			break;
		case "--no-context-files":
			result.noContextFiles = true;
			break;
		default: {
			// Unknown flag — collect for extensions. Heuristic: if value looks
			// like a flag or file arg, store boolean; else store the string.
			if (value === true || (typeof value === "string" && (value.startsWith("-") || value.startsWith("@")))) {
				result.unknownFlags.set(name.slice(2), true);
			} else {
				result.unknownFlags.set(name.slice(2), value);
			}
		}
	}
}

function splitCsv(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function printHelp(): void {
	const lines = [
		"arbor - AI coding agent",
		"",
		"Usage:",
		"  arbor [options] [@files...] [messages...]",
		"",
		"Modes:",
		"  (default)            Interactive TUI (requires a TTY)",
		"  -p, --print [msg]    Non-interactive: run once, print final text, exit",
		"  --json [msg]         Non-interactive: stream NDJSON events, exit",
		"  --mode rpc           stdio JSONL RPC protocol (for embedding)",
		"",
		"Options:",
		"  --provider <name>        Model provider (anthropic, openai, google, ...)",
		"  --model <provider/id>    Model id; 'provider/id' sets both",
		"  -c, --continue           Continue the most recent session in this cwd",
		"  -r, --resume             Pick a session to resume",
		"  --session <id|path>      Open a specific session",
		"  --no-session             Ephemeral: don't persist the session",
		"  -n, --name <name>        Set the session display name",
		"  --system-prompt <text>   Override the base system prompt",
		"  --append-system-prompt <text>  Append to the system prompt (repeatable)",
		"  -t, --tools <a,b>        Tool allowlist",
		"  --exclude-tools <a,b>    Tool denylist",
		"  --no-context-files       Disable AGENTS.md/CLAUDE.md loading",
		"  --output-format <fmt>    text | json (implies print mode)",
		"  --verbose                Verbose diagnostics",
		"  -h, --help               Show this help",
		"  -v, --version            Show version",
		"",
		"Interactive slash commands are two-level, e.g. /session rewind, /mode plan.",
		"See the RPC protocol doc for embedding.",
	];
	process.stdout.write(`${lines.join("\n")}\n`);
}
