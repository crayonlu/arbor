/**
 * jobs tool: let the model inspect, wait on, and kill background jobs.
 */
import { type Static, Type } from "typebox";
import { truncateTail } from "../tools/truncate.ts";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { tailJobLog } from "./log-store.ts";
import type { BackgroundJobs, JobInfo } from "./registry.ts";

const parameters = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("output"), Type.Literal("kill")], {
		description: "list: all jobs; output: read a job's output (optionally wait); kill: stop a job",
	}),
	jobId: Type.Optional(Type.String({ description: "Job id (required for output/kill)" })),
	wait: Type.Optional(
		Type.Number({
			description: "For output: wait up to this many milliseconds for the job to finish first",
			minimum: 0,
		}),
	),
});

export type JobsToolInput = Static<typeof parameters>;

export interface JobsToolDetails {
	action: JobsToolInput["action"];
	jobs?: JobInfo[];
	job?: JobInfo;
}

function formatRuntime(info: JobInfo): string {
	const end = info.completedAt ?? Date.now();
	const seconds = Math.round((end - info.startedAt) / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function formatJobLine(info: JobInfo): string {
	const exit = info.exitCode !== undefined && info.exitCode !== null ? ` exit=${info.exitCode}` : "";
	return `${info.id} [${info.status}${exit}] (${info.type}, ${formatRuntime(info)}) ${info.title}`;
}

export function createJobsTool(registry: BackgroundJobs): AgentTool<typeof parameters, JobsToolDetails> {
	return {
		name: "jobs",
		label: "Jobs",
		description:
			"Manage background jobs started with background=true. " +
			"action=list shows all jobs; action=output returns a job's output tail (use wait to block up to N ms for completion); " +
			"action=kill stops a running job. You are notified automatically when jobs finish — prefer that over polling.",
		parameters,
		async execute(_id, params): Promise<AgentToolResult<JobsToolDetails>> {
			switch (params.action) {
				case "list": {
					const jobs = registry.list();
					const text = jobs.length === 0 ? "No background jobs." : jobs.map(formatJobLine).join("\n");
					return { content: [{ type: "text", text }], details: { action: "list", jobs } };
				}
				case "output": {
					if (!params.jobId) throw new Error("jobId is required for action=output");
					let info = registry.get(params.jobId);
					if (!info) throw new Error(`Unknown job: ${params.jobId}`);
					if (params.wait !== undefined && info.status === "running") {
						info = (await registry.wait(params.jobId, params.wait)) ?? info;
					}
					const tail = info.logPath ? await tailJobLog(info.logPath, 8192) : "";
					const truncated = truncateTail(tail, { maxLines: 200 });
					const parts = [formatJobLine(info)];
					if (truncated.content.length > 0) {
						parts.push("", "Output tail:", truncated.content.trimEnd());
					}
					if (info.logPath) {
						parts.push("", `Full output: ${info.logPath} (use the read tool)`);
					}
					if (info.error) parts.push("", `Error: ${info.error}`);
					return {
						content: [{ type: "text", text: parts.join("\n") }],
						details: { action: "output", job: info },
					};
				}
				case "kill": {
					if (!params.jobId) throw new Error("jobId is required for action=kill");
					const info = registry.kill(params.jobId);
					if (!info) throw new Error(`Unknown job: ${params.jobId}`);
					return {
						content: [{ type: "text", text: formatJobLine(info) }],
						details: { action: "kill", job: info },
					};
				}
			}
		},
	};
}
