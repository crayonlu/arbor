#!/usr/bin/env bun
/**
 * Arbor CLI entry point. Runs under Bun (the interactive TUI needs OpenTUI's
 * native FFI; headless modes also work under Bun). Dispatches to main().
 */
import { main } from "./main.ts";

main(process.argv.slice(2)).catch((error) => {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exit(1);
});
