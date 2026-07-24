/** Subagent subsystem: child-process subagents over a JSONL protocol. */
export { runSubagent } from "./entry.ts";
export type { SubagentConfig, SubagentEvent } from "./protocol.ts";
export { createJsonlDecoder, encodeEvent } from "./protocol.ts";
export type {
	AgentDefinition,
	SubagentThreadItem,
	TaskToolDetails,
	TaskToolInput,
	TaskToolOptions,
} from "./task-tool.ts";
export { createTaskTool, discoverAgentDefinitions } from "./task-tool.ts";
