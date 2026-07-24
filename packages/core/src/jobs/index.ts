/** Background jobs subsystem: registry, disk logs, stall watchdog, jobs tool. */
export type { JobsToolDetails, JobsToolInput } from "./jobs-tool.ts";
export { createJobsTool } from "./jobs-tool.ts";
export type { JobLog } from "./log-store.ts";
export { createJobLog, defaultJobLogsRoot, pruneJobLogs, tailJobLog } from "./log-store.ts";
export type { JobHandle, JobInfo, JobNotification, JobStatus, StartJobInput } from "./registry.ts";
export { BackgroundJobs } from "./registry.ts";
export type { StallWatchdogOptions } from "./watchdog.ts";
export { looksLikePrompt, startStallWatchdog } from "./watchdog.ts";
