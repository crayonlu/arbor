/** Built-in tools for the Arbor harness. */
import type { AgentTool } from "../types.ts";
import { type BashToolOptions, createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

export { type AskToolDetails, type AskToolInput, createAskTool } from "./ask.ts";
export {
	type AutoBackgroundOptions,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
} from "./bash.ts";
export {
	applyMatchedEdits,
	createEditTool,
	detectLineEnding,
	type EditToolDetails,
	type EditToolInput,
	matchEdits,
	normalizeToLF,
	unifiedDiff,
} from "./edit.ts";
export { createFindTool, type FindToolDetails, type FindToolInput } from "./find.ts";
export { globToRegex } from "./glob.ts";
export { createGrepTool, type GrepToolDetails, type GrepToolInput } from "./grep.ts";
export { createLsTool, type LsToolDetails, type LsToolInput } from "./ls.ts";
export { displayPath, resolveToCwd } from "./paths.ts";
export {
	DEFAULT_PERSIST_PREVIEW_BYTES,
	DEFAULT_PERSIST_THRESHOLD_BYTES,
	defaultToolOutputsRoot,
	type OutputPersistenceOptions,
	persistLargeOutputs,
	pruneToolOutputs,
	withOutputPersistence,
} from "./persist.ts";
export { createReadTool, type ReadToolDetails, type ReadToolInput } from "./read.ts";
export {
	createTodoStore,
	createTodoTool,
	TODO_CUSTOM_TYPE,
	type TodoItem,
	type TodoStore,
	type TodoToolDetails,
	type TodoToolInput,
} from "./todo.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateTail,
	truncationNotice,
} from "./truncate.ts";
export { DEFAULT_IGNORED_DIRS, gitignorePatternToRule, looksBinary, walkFiles } from "./walker.ts";
export { createWriteTool, type WriteToolDetails, type WriteToolInput } from "./write.ts";

export type CodingToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

/** Create the standard set of coding tools rooted at `cwd`. */
export function createCodingTools(cwd: string, options: { bash?: BashToolOptions } = {}): AgentTool<any>[] {
	return [
		createReadTool(cwd),
		createBashTool(cwd, options.bash),
		createEditTool(cwd),
		createWriteTool(cwd),
		createGrepTool(cwd),
		createFindTool(cwd),
		createLsTool(cwd),
	];
}
