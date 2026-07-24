/** @arbor-space/core public API. */
export type { AgentSessionOptions, SessionEventListener } from "./agent-session.ts";
export { AgentSession } from "./agent-session.ts";
export type { ContextFile, ContextFileOptions } from "./context-files.ts";
export { contextFilesPromptSection, loadContextFiles } from "./context-files.ts";
export * from "./extensions/index.ts";
export type { GoalState } from "./goal.ts";
export { createGoalState, goalPromptSection, goalReminderMessage } from "./goal.ts";
export * from "./jobs/index.ts";
export type { AgentEventSink, AgentEventStream } from "./loop.ts";
export { agentLoop, agentLoopContinue, runAgentLoop } from "./loop.ts";
export { createErrorToolResult, executeToolCalls, failToolCallsFromTruncatedMessage } from "./loop-tools.ts";
export * from "./mcp/index.ts";
export type { AgentMode, ExitPlanDetails, ExitPlanInput } from "./modes.ts";
export { createExitPlanTool, filterToolsForMode, modePromptSection, PLAN_MODE_PROMPT } from "./modes.ts";
export * from "./session/index.ts";
export type { Skill, SkillDiscoveryOptions, SkillWarning } from "./skills.ts";
export {
	discoverSkills,
	loadSkillBody,
	loadSkillFile,
	parseFrontmatter,
	skillsPromptSection,
} from "./skills.ts";
export * from "./subagent/index.ts";
export type { PromptTemplate, TemplateDiscoveryOptions } from "./templates.ts";
export { discoverTemplates, expandTemplate, splitArguments } from "./templates.ts";
export type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	AgentToolUpdateCallback,
	BeforeToolCallContext,
	BeforeToolCallResult,
	CustomAgentMessages,
	LlmContext,
	LoopRetryPolicy,
	StreamFn,
	TurnEndContext,
} from "./types.ts";
export type { UsageTotals } from "./usage.ts";
export { addUsage, computeUsageTotals, createUsageTotals } from "./usage.ts";
