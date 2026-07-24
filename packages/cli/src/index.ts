/** @arbor-space/cli public surface. */

export { type AppMode, resolveAppMode } from "./app-mode.ts";
export { type Args, parseArgs, printHelp } from "./args.ts";
export { type BuildSessionInput, type BuiltSession, buildSession, HEADLESS_UI } from "./build-session.ts";
export * from "./commands/index.ts";
export { main } from "./main.ts";
export { type PrintModeOptions, runPrintMode } from "./modes/print.ts";
export { runRpcMode } from "./modes/rpc.ts";
export { attachJsonlLineReader, serializeLine } from "./ndjson.ts";
