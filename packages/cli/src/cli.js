#!/usr/bin/env bun
import { main } from "./main.ts";

main(process.argv.slice(2)).catch((error) => {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exit(1);
});
