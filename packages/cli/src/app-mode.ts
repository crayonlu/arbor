/**
 * Resolve which runtime mode the CLI should run in from parsed args + TTY state.
 *
 * - rpc:        explicit `--mode rpc`
 * - print-json: `--json`/`--output-format json`, or `--mode json`
 * - print-text: `--print/-p`, or non-TTY stdin/stdout (piped)
 * - interactive: TTY stdin+stdout, no print flag
 *
 * Piped stdin forces print (you cannot drive an interactive UI from a pipe).
 */
export type AppMode = "interactive" | "print-text" | "print-json" | "rpc";

export interface AppModeInput {
	mode?: "text" | "json" | "rpc";
	print?: boolean;
	json?: boolean;
	outputFormat?: "text" | "json";
	stdinIsTty: boolean;
	stdoutIsTty: boolean;
}

export function resolveAppMode(input: AppModeInput): AppMode {
	if (input.mode === "rpc") return "rpc";
	if (input.mode === "json" || input.json || input.outputFormat === "json") {
		return "print-json";
	}
	if (input.print || !input.stdinIsTty || !input.stdoutIsTty) {
		return "print-text";
	}
	return "interactive";
}
