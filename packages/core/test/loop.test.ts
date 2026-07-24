/** Agent loop tests using the pi-ai faux provider. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { agentLoop, agentLoopContinue } from "../src/loop.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	StreamFn,
} from "../src/types.ts";

function setup() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const streamFn: StreamFn = (model, context, options) => models.streamSimple(model, context, options);
	return { faux, models, streamFn };
}

function makeConfig(model: any, overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
	return {
		model,
		convertToLlm: (messages) => messages as any,
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
		...overrides,
	};
}

function makeEchoTool(calls: unknown[]): AgentTool<any> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo the input back",
		parameters: Type.Object({ text: Type.String() }),
		async execute(_id, params: any) {
			calls.push(params);
			return { content: [{ type: "text" as const, text: `echo: ${params.text}` }], details: undefined };
		},
	};
}

function makeContext(tools: AgentTool<any>[] = []): AgentContext {
	return { systemPrompt: "You are a test agent.", messages: [], tools };
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("agentLoop", () => {
	it("runs a single text turn and ends", async () => {
		const { faux, streamFn } = setup();
		faux.setResponses([fauxAssistantMessage("Hello!")]);

		const context = makeContext();
		const stream = agentLoop([userMessage("hi")], context, makeConfig(faux.getModel()), streamFn);
		const events = await collect(stream);
		const messages = await stream.result();

		assert.equal(events[0]?.type, "agent_start");
		assert.equal(events.at(-1)?.type, "agent_end");
		assert.equal(events.filter((e) => e.type === "turn_start").length, 1);
		// user + assistant
		assert.equal(messages.length, 2);
		const assistant = messages[1] as any;
		assert.equal(assistant.role, "assistant");
		assert.equal(assistant.content[0].text, "Hello!");
		// The loop works on a copy: the caller's context is not mutated.
		assert.equal(context.messages.length, 0);
	});

	it("executes tool calls and loops until a text-only response", async () => {
		const { faux, streamFn } = setup();
		const calls: unknown[] = [];
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "first" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);

		const context = makeContext([makeEchoTool(calls)]);
		const stream = agentLoop([userMessage("run echo")], context, makeConfig(faux.getModel()), streamFn);
		const events = await collect(stream);
		const messages = await stream.result();

		assert.deepEqual(calls, [{ text: "first" }]);
		assert.equal(events.filter((e) => e.type === "tool_execution_start").length, 1);
		assert.equal(events.filter((e) => e.type === "tool_execution_end").length, 1);
		assert.equal(events.filter((e) => e.type === "turn_start").length, 2);
		// user + assistant(toolUse) + toolResult + assistant(text)
		assert.equal(messages.length, 4);
		const toolResult = messages[2] as any;
		assert.equal(toolResult.role, "toolResult");
		assert.equal(toolResult.content[0].text, "echo: first");
		assert.equal(toolResult.isError, false);
	});

	it("executes parallel tool calls in one batch and emits results in source order", async () => {
		const { faux, streamFn } = setup();
		const order: string[] = [];
		const slowTool: AgentTool<any> = {
			name: "slow",
			label: "Slow",
			description: "slow tool",
			parameters: Type.Object({}),
			async execute() {
				await new Promise((r) => setTimeout(r, 30));
				order.push("slow-done");
				return { content: [{ type: "text" as const, text: "slow" }], details: undefined };
			},
		};
		const fastTool: AgentTool<any> = {
			name: "fast",
			label: "Fast",
			description: "fast tool",
			parameters: Type.Object({}),
			async execute() {
				order.push("fast-done");
				return { content: [{ type: "text" as const, text: "fast" }], details: undefined };
			},
		};
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", {}), fauxToolCall("fast", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);

		const context = makeContext([slowTool, fastTool]);
		const stream = agentLoop([userMessage("go")], context, makeConfig(faux.getModel()), streamFn);
		const messages = await stream.result();

		// fast finished before slow (concurrent), but results are in source order.
		assert.deepEqual(order, ["fast-done", "slow-done"]);
		const toolResults = messages.filter((m: any) => m.role === "toolResult") as any[];
		assert.equal(toolResults[0].toolName, "slow");
		assert.equal(toolResults[1].toolName, "fast");
	});

	it("reports unknown tools as error results without crashing", async () => {
		const { faux, streamFn } = setup();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("nope", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Recovered."),
		]);

		const context = makeContext();
		const stream = agentLoop([userMessage("x")], context, makeConfig(faux.getModel()), streamFn);
		const messages = await stream.result();

		const toolResult = messages.find((m: any) => m.role === "toolResult") as any;
		assert.equal(toolResult.isError, true);
		assert.match(toolResult.content[0].text, /Unknown tool/);
	});

	it("fails tool calls from a length-truncated assistant message", async () => {
		const { faux, streamFn } = setup();
		const calls: unknown[] = [];
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "maybe-truncated" })], { stopReason: "length" }),
			fauxAssistantMessage("Retried."),
		]);

		const context = makeContext([makeEchoTool(calls)]);
		const stream = agentLoop([userMessage("x")], context, makeConfig(faux.getModel()), streamFn);
		const messages = await stream.result();

		assert.equal(calls.length, 0, "tool must not execute");
		const toolResult = messages.find((m: any) => m.role === "toolResult") as any;
		assert.equal(toolResult.isError, true);
		assert.match(toolResult.content[0].text, /truncated/);
	});

	it("blocks tools via beforeToolCall", async () => {
		const { faux, streamFn } = setup();
		const calls: unknown[] = [];
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "blocked" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("OK."),
		]);

		const context = makeContext([makeEchoTool(calls)]);
		const config = makeConfig(faux.getModel(), {
			beforeToolCall: () => ({ block: true, reason: "not allowed in test" }),
		});
		const stream = agentLoop([userMessage("x")], context, config, streamFn);
		const messages = await stream.result();

		assert.equal(calls.length, 0);
		const toolResult = messages.find((m: any) => m.role === "toolResult") as any;
		assert.equal(toolResult.isError, true);
		assert.match(toolResult.content[0].text, /not allowed in test/);
	});

	it("rewrites args via beforeToolCall and overrides results via afterToolCall", async () => {
		const { faux, streamFn } = setup();
		const calls: { text: string }[] = [];
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "original" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("OK."),
		]);

		const context = makeContext([makeEchoTool(calls as unknown[])]);
		const config = makeConfig(faux.getModel(), {
			beforeToolCall: () => ({ args: { text: "rewritten" } }),
			afterToolCall: () => ({ content: [{ type: "text", text: "overridden" }] }),
		});
		const stream = agentLoop([userMessage("x")], context, config, streamFn);
		const messages = await stream.result();

		assert.deepEqual(calls, [{ text: "rewritten" }]);
		const toolResult = messages.find((m: any) => m.role === "toolResult") as any;
		assert.equal(toolResult.content[0].text, "overridden");
	});

	it("stops early when every tool result in the batch sets terminate", async () => {
		const { faux, streamFn } = setup();
		const terminatingTool: AgentTool<any> = {
			name: "finish",
			label: "Finish",
			description: "terminate the loop",
			parameters: Type.Object({}),
			async execute() {
				return {
					content: [{ type: "text" as const, text: "finished" }],
					details: undefined,
					terminate: true,
				};
			},
		};
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("finish", {})], { stopReason: "toolUse" }),
			// This response must never be requested.
			fauxAssistantMessage("SHOULD NOT APPEAR"),
		]);

		const context = makeContext([terminatingTool]);
		const stream = agentLoop([userMessage("x")], context, makeConfig(faux.getModel()), streamFn);
		const messages = await stream.result();

		assert.equal(faux.getPendingResponseCount(), 1, "second response not consumed");
		assert.ok(!messages.some((m: any) => m.content?.[0]?.text === "SHOULD NOT APPEAR"));
	});

	it("injects steering messages between turns", async () => {
		const { faux, streamFn } = setup();
		const calls: unknown[] = [];
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "one" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Wrapping up."),
		]);

		let steered = false;
		const context = makeContext([makeEchoTool(calls)]);
		const config = makeConfig(faux.getModel(), {
			getSteeringMessages: () => {
				if (steered || calls.length === 0) return [];
				steered = true;
				return [userMessage("steering note")];
			},
		});
		const stream = agentLoop([userMessage("x")], context, config, streamFn);
		const messages = await stream.result();

		const userMessages = messages.filter((m: any) => m.role === "user") as any[];
		assert.equal(userMessages.length, 2);
		assert.equal(userMessages[1].content, "steering note");
	});

	it("continues with follow-up messages after the agent would stop", async () => {
		const { faux, streamFn } = setup();
		faux.setResponses([fauxAssistantMessage("First answer."), fauxAssistantMessage("Second answer.")]);

		let delivered = false;
		const context = makeContext();
		const config = makeConfig(faux.getModel(), {
			getFollowUpMessages: () => {
				if (delivered) return [];
				delivered = true;
				return [userMessage("follow-up")];
			},
		});
		const stream = agentLoop([userMessage("x")], context, config, streamFn);
		const messages = await stream.result();

		const assistants = messages.filter((m: any) => m.role === "assistant") as any[];
		assert.equal(assistants.length, 2);
		assert.equal(assistants[1].content[0].text, "Second answer.");
	});

	it("stops after turn when shouldStopAfterTurn returns true", async () => {
		const { faux, streamFn } = setup();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "one" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("SHOULD NOT APPEAR"),
		]);

		const calls: unknown[] = [];
		const context = makeContext([makeEchoTool(calls)]);
		const config = makeConfig(faux.getModel(), { shouldStopAfterTurn: () => true });
		const stream = agentLoop([userMessage("x")], context, config, streamFn);
		const messages = await stream.result();

		assert.equal(calls.length, 1, "tool batch still ran");
		assert.equal(faux.getPendingResponseCount(), 1);
		assert.ok(!messages.some((m: any) => m.content?.[0]?.text === "SHOULD NOT APPEAR"));
	});

	it("surfaces provider errors as an error assistant message and ends", async () => {
		const { faux, streamFn } = setup();
		faux.setResponses([fauxAssistantMessage("irrelevant", { stopReason: "error", errorMessage: "boom" })]);

		const context = makeContext();
		const stream = agentLoop([userMessage("x")], context, makeConfig(faux.getModel()), streamFn);
		const events = await collect(stream);
		const messages = await stream.result();

		const assistant = messages.find((m: any) => m.role === "assistant") as any;
		assert.equal(assistant.stopReason, "error");
		assert.equal(events.at(-1)?.type, "agent_end");
	});

	it("retries transient errors and recovers", async () => {
		const { faux, streamFn } = setup();
		faux.setResponses([
			fauxAssistantMessage("irrelevant", {
				stopReason: "error",
				errorMessage: "429 too many requests, overloaded",
			}),
			fauxAssistantMessage("Recovered!"),
		]);

		const context = makeContext();
		const config = makeConfig(faux.getModel(), {
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
		});
		const stream = agentLoop([userMessage("x")], context, config, streamFn);
		const events = await collect(stream);
		const messages = await stream.result();

		assert.equal(events.filter((e) => e.type === "retry_scheduled").length, 1);
		const assistants = messages.filter((m: any) => m.role === "assistant") as any[];
		// Failed attempt was popped from the working context; only the recovered
		// message remains in the returned transcript.
		assert.equal(assistants.length, 1);
		assert.equal(assistants[0].content[0].text, "Recovered!");
	});

	it("invokes onOverflow and retries with the replacement context", async () => {
		const { faux, streamFn } = setup();
		faux.setResponses([
			fauxAssistantMessage("irrelevant", {
				stopReason: "error",
				errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
			}),
			fauxAssistantMessage("After compaction."),
		]);

		let overflowCalled = false;
		const context = makeContext();
		const config = makeConfig(faux.getModel(), {
			onOverflow: (messages) => {
				overflowCalled = true;
				// Simulate compaction: keep only the last message.
				return messages.slice(-1);
			},
		});
		const stream = agentLoop([userMessage("x")], context, config, streamFn);
		const messages = await stream.result();

		assert.equal(overflowCalled, true);
		const assistant = messages.find((m: any) => m.role === "assistant") as any;
		assert.equal(assistant.content[0].text, "After compaction.");
	});

	it("applies transformContext before each LLM call", async () => {
		const { faux, streamFn } = setup();
		let seen = 0;
		faux.setResponses([fauxAssistantMessage("ok")]);

		const context = makeContext();
		const config = makeConfig(faux.getModel(), {
			transformContext: (messages) => {
				seen++;
				return messages;
			},
		});
		await agentLoop([userMessage("x")], context, config, streamFn).result();
		assert.equal(seen, 1);
	});
});

describe("agentLoopContinue", () => {
	it("throws when the context is empty", () => {
		const { faux, streamFn } = setup();
		assert.throws(() => agentLoopContinue(makeContext(), makeConfig(faux.getModel()), streamFn));
	});

	it("throws when the last message is from the assistant", () => {
		const { faux, streamFn } = setup();
		const context = makeContext();
		context.messages.push(fauxAssistantMessage("hi"));
		assert.throws(() => agentLoopContinue(context, makeConfig(faux.getModel()), streamFn));
	});

	it("continues from a trailing user message", async () => {
		const { faux, streamFn } = setup();
		faux.setResponses([fauxAssistantMessage("Continued.")]);

		const context = makeContext();
		context.messages.push(userMessage("resume me"));
		const stream = agentLoopContinue(context, makeConfig(faux.getModel()), streamFn);
		const messages = await stream.result();

		const assistant = messages.find((m: any) => m.role === "assistant") as any;
		assert.equal(assistant.content[0].text, "Continued.");
	});
});
