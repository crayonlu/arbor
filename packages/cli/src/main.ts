/**
 * CLI orchestration: parse args, resolve mode + session, dispatch to the
 * matching runner (print / rpc / interactive). Headless modes never load the
 * TUI package; interactive lazy-imports it.
 */
import type { SessionManager } from "@arbor-space/core";
import { ensureConfigFile, ensureModelsToml } from "@arbor-space/core/config";
import { resolveAppMode } from "./app-mode.ts";
import { type Args, parseArgs, printHelp } from "./args.ts";
import { buildSession } from "./build-session.ts";
import { runPrintMode } from "./modes/print.ts";
import { runRpcMode } from "./modes/rpc.ts";
import { restoreStdout, takeOverStdout } from "./output-guard.ts";
import { resolveSession } from "./session-resolver.ts";
import { APP_VERSION } from "./version.ts";

export async function main(argv: string[]): Promise<void> {
	const args = parseArgs(argv);

	for (const d of args.diagnostics) {
		const prefix = d.type === "error" ? "Error: " : "Warning: ";
		process.stderr.write(`${prefix}${d.message}\n`);
	}
	if (args.diagnostics.some((d) => d.type === "error")) {
		process.exit(1);
	}

	if (args.help) {
		printHelp();
		process.exit(0);
	}
	if (args.version) {
		process.stdout.write(`${APP_VERSION}\n`);
		process.exit(0);
	}

	ensureConfigFile();
	ensureModelsToml();

	const stdinIsTty = !!process.stdin.isTTY;
	const stdoutIsTty = !!process.stdout.isTTY;
	const appMode = resolveAppMode({
		...(args.mode ? { mode: args.mode } : {}),
		...(args.print !== undefined ? { print: args.print } : {}),
		...(args.json !== undefined ? { json: args.json } : {}),
		...(args.outputFormat ? { outputFormat: args.outputFormat } : {}),
		stdinIsTty: stdinIsTty,
		stdoutIsTty: stdoutIsTty,
	});

	// Headless modes own stdout (protocol stream); interactive leaves it to the TUI.
	const headless = appMode !== "interactive";
	if (headless) takeOverStdout();

	// Piped stdin becomes the initial prompt in print mode.
	let pipedStdin: string | undefined;
	if (appMode === "print-text" || appMode === "print-json") {
		pipedStdin = await readPipedStdin();
	}

	const { manager: sessionManager } = await resolveSession({
		cwd: process.cwd(),
		...(args.continueRecent ? { continueRecent: args.continueRecent } : {}),
		...(args.resume ? { resume: args.resume } : {}),
		...(args.session ? { session: args.session } : {}),
		...(args.noSession ? { noSession: args.noSession } : {}),
		interactive: appMode === "interactive",
	});
	if (args.name) {
		applyName(sessionManager, args.name);
	}

	if (appMode === "rpc") {
		await runRpcMode({ cwd: process.cwd(), args, sessionManager });
		restoreStdout();
		return;
	}

	if (appMode === "interactive") {
		await runInteractive(args, sessionManager);
		return;
	}

	// print-text / print-json
	const { session } = await buildSession({ cwd: process.cwd(), args, sessionManager, mode: appMode });
	const initialMessage = buildInitialMessage(args, pipedStdin);
	const exitCode = await runPrintMode(session, {
		mode: appMode === "print-json" ? "json" : "text",
		messages: args.messages,
		...(initialMessage !== undefined ? { initialMessage } : {}),
	});
	restoreStdout();
	if (exitCode !== 0) process.exitCode = exitCode;
}

async function runInteractive(args: Args, sessionManager: SessionManager): Promise<void> {
	const { runTui, createTuiExtensionUi } = await import("@arbor-space/tui");
	const { buildSession } = await import("./build-session.ts");
	const { listCommands } = await import("./commands/registry.ts");
	const { createSlashRuntime, executeSlashCommandTui } = await import("./commands/dispatch.ts");
	const { SessionManager } = await import("@arbor-space/core");

	const cwd = process.cwd();
	let manager: SessionManager = sessionManager;

	// Loop so `/session new|resume|fork` can swap the live session without
	// restarting the process. Each iteration builds a fresh UI + session.
	while (true) {
		const extensionUi = createTuiExtensionUi();
		const { session, models, jobs } = await buildSession({
			cwd,
			args,
			sessionManager: manager,
			mode: "interactive",
			ui: extensionUi,
		});

		const commands = listCommands(session).map((c) => ({
			category: c.category,
			name: c.name,
			...(c.aliases ? { aliases: c.aliases } : {}),
			description: c.description,
			...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
		}));

		const exit = await runTui(session, {
			commands,
			extensionUi,
			runCommand: async (text, hook, actions) => {
				const lines: string[] = [];
				const runtime = createSlashRuntime(session, session.session, {
					cwd,
					output: (t) => {
						lines.push(t);
					},
					resolveModel: (provider, modelId) => models.getModel(provider, modelId) ?? null,
					listModels: () => models.getModels().map((m) => `${m.provider}/${m.id}`),
				});
				const outcome = await executeSlashCommandTui(text, { runtime, tui: hook, actions });
				if (outcome.kind === "unknown") lines.push(`Unknown command: /${outcome.name}`);
				if (outcome.kind === "tui_only")
					lines.push(`/${outcome.name} needs interactive args — type it directly with arguments.`);
				void jobs;
				return lines.length > 0 ? lines.join("\n") : undefined;
			},
		});

		if (exit.kind === "quit") return;
		if (exit.mode === "new") {
			manager = SessionManager.create(cwd);
		} else if (exit.mode === "resume" && exit.target) {
			manager = SessionManager.load(exit.target);
		} else if (exit.mode === "fork") {
			const filePath = session.session.filePath;
			manager = filePath ? SessionManager.fork(filePath) : SessionManager.create(cwd);
		}
	}
}

function buildInitialMessage(args: Args, pipedStdin?: string): string | undefined {
	const parts: string[] = [];
	if (pipedStdin) parts.push(pipedStdin);
	if (args.messages.length > 0) parts.push(args.messages.join("\n\n"));
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

async function readPipedStdin(): Promise<string | undefined> {
	if (process.stdin.isTTY) return undefined;
	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolve(data.trim() || undefined));
		process.stdin.resume();
	});
}

function applyName(sessionManager: SessionManager, name: string): void {
	const trimmed = name.trim();
	if (!trimmed) {
		process.stderr.write("Error: --name requires a non-empty value\n");
		process.exit(1);
	}
	sessionManager.setName(trimmed);
}
