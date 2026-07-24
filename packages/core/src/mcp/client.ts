/**
 * MCP client: connect to Model Context Protocol servers and expose their
 * tools in the agent tool registry as `mcp__<server>__<tool>`.
 *
 * Transports: stdio and streamable HTTP. HTTP servers may require OAuth —
 * pass `oauth` connect options to enable the browser-based authorization
 * flow (see mcp/oauth.ts); without it an unauthorized server simply fails
 * to connect. Config format is compatible with `.claude/mcp.json` / `.mcp.json`.
 */
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TSchema } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import {
	ArborOAuthProvider,
	DEFAULT_OAUTH_CALLBACK_PORT,
	FileMcpAuthStorage,
	type McpAuthStorage,
	startOAuthCallbackServer,
} from "./oauth.ts";

export interface McpStdioServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface McpHttpServerConfig {
	url: string;
	headers?: Record<string, string>;
	/** Set false to never attempt OAuth for this server. Default: allowed. */
	oauth?: boolean;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpConfig {
	mcpServers: Record<string, McpServerConfig>;
}

export interface McpOAuthConnectOptions {
	/**
	 * Receives the authorization URL when a server requires OAuth. Open it in
	 * a browser or show it to the user; the loopback callback server catches
	 * the redirect automatically.
	 */
	onAuthorizationUrl: (url: string) => void | Promise<void>;
	/** Loopback callback port. Default 19877. */
	callbackPort?: number;
	/** Credential storage. Default: ~/.arbor/mcp-auth.json */
	storage?: McpAuthStorage;
	/** Max wait for the user to complete authorization. Default 5 minutes. */
	authTimeoutMs?: number;
}

export interface McpConnectOptions {
	/** Enables the OAuth flow for HTTP servers that require it. */
	oauth?: McpOAuthConnectOptions;
}

export interface McpConnection {
	serverName: string;
	client: Client;
	tools: AgentTool<any>[];
	close: () => Promise<void>;
}

export interface McpConnectResult {
	connections: McpConnection[];
	failures: { serverName: string; error: Error }[];
}

function isHttpConfig(config: McpServerConfig): config is McpHttpServerConfig {
	return "url" in config;
}

/** Convert one MCP tool description into an AgentTool. */
function toAgentTool(
	serverName: string,
	client: Client,
	mcpTool: {
		name: string;
		description?: string | undefined;
		inputSchema: unknown;
	},
): AgentTool<any> {
	return {
		name: `mcp__${serverName}__${mcpTool.name}`,
		label: `${serverName}:${mcpTool.name}`,
		description: mcpTool.description ?? `Tool ${mcpTool.name} from MCP server ${serverName}`,
		// MCP servers send JSON Schema; typebox schemas are JSON Schema, so
		// pass-through works for validation and provider serialization.
		parameters: (mcpTool.inputSchema ?? { type: "object", properties: {} }) as TSchema,
		// MCP tools may mutate anything; hide them in plan mode.
		mutates: true,
		async execute(_id, params, signal): Promise<AgentToolResult> {
			const result = await client.callTool(
				{ name: mcpTool.name, arguments: (params ?? {}) as Record<string, unknown> },
				undefined,
				signal ? { signal } : {},
			);
			const blocks = (result.content ?? []) as {
				type: string;
				text?: string;
				data?: string;
				mimeType?: string;
			}[];
			const content: AgentToolResult["content"] = [];
			for (const block of blocks) {
				if (block.type === "text" && block.text !== undefined) {
					content.push({ type: "text", text: block.text });
				} else if (block.type === "image" && block.data !== undefined) {
					content.push({ type: "image", data: block.data, mimeType: block.mimeType ?? "image/png" });
				} else {
					content.push({ type: "text", text: JSON.stringify(block) });
				}
			}
			if (content.length === 0) {
				content.push({ type: "text", text: "(no content)" });
			}
			if (result.isError) {
				throw new Error(content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n"));
			}
			return { content, details: { server: serverName, tool: mcpTool.name } };
		},
	};
}

/** Connect an HTTP transport, running the OAuth flow when required and enabled. */
async function connectHttp(
	serverName: string,
	config: McpHttpServerConfig,
	client: Client,
	options: McpConnectOptions,
): Promise<void> {
	const oauth = config.oauth === false ? undefined : options.oauth;
	const makeTransport = (authProvider?: ArborOAuthProvider) =>
		new StreamableHTTPClientTransport(new URL(config.url), {
			...(config.headers ? { requestInit: { headers: config.headers } } : {}),
			...(authProvider ? { authProvider } : {}),
		});

	if (!oauth) {
		await client.connect(makeTransport() as Parameters<Client["connect"]>[0]);
		return;
	}

	const storage = oauth.storage ?? new FileMcpAuthStorage();
	const port = oauth.callbackPort ?? DEFAULT_OAUTH_CALLBACK_PORT;
	let authorizationUrl: URL | null = null;
	const provider = new ArborOAuthProvider({
		serverName,
		serverUrl: config.url,
		storage,
		redirectUrl: `http://127.0.0.1:${port}/callback`,
		onRedirect: (url) => {
			authorizationUrl = url;
		},
	});

	const transport = makeTransport(provider);
	try {
		await client.connect(transport as Parameters<Client["connect"]>[0]);
		return; // Stored/refreshed tokens were sufficient.
	} catch (error) {
		if (!(error instanceof UnauthorizedError) || !authorizationUrl) throw error;
	}

	// Interactive authorization: hand the URL to the caller, wait for the
	// loopback redirect, exchange the code, then reconnect fresh.
	const callbackServer = await startOAuthCallbackServer(port);
	try {
		await oauth.onAuthorizationUrl(String(authorizationUrl));
		const code = await callbackServer.waitForCode(oauth.authTimeoutMs);
		await transport.finishAuth(code);
	} finally {
		callbackServer.close();
	}
	await client.connect(makeTransport(provider) as Parameters<Client["connect"]>[0]);
}

/** Connect to one MCP server and list its tools. */
export async function connectMcpServer(
	serverName: string,
	config: McpServerConfig,
	options: McpConnectOptions = {},
): Promise<McpConnection> {
	const client = new Client({ name: "arbor", version: "0.1.0" });
	if (isHttpConfig(config)) {
		await connectHttp(serverName, config, client, options);
	} else {
		const transport = new StdioClientTransport({
			command: config.command,
			args: config.args ?? [],
			env: { ...(process.env as Record<string, string>), ...config.env },
			...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
			stderr: "ignore",
		});
		await client.connect(transport);
	}

	const listed = await client.listTools();
	const tools = listed.tools.map((t) => toAgentTool(serverName, client, t));
	return {
		serverName,
		client,
		tools,
		close: () => client.close(),
	};
}

/** Connect to every configured server; failures are collected, not thrown. */
export async function connectMcpServers(
	config: McpConfig,
	options: McpConnectOptions = {},
): Promise<McpConnectResult> {
	const connections: McpConnection[] = [];
	const failures: { serverName: string; error: Error }[] = [];
	await Promise.all(
		Object.entries(config.mcpServers).map(async ([serverName, serverConfig]) => {
			try {
				connections.push(await connectMcpServer(serverName, serverConfig, options));
			} catch (error) {
				failures.push({
					serverName,
					error: error instanceof Error ? error : new Error(String(error)),
				});
			}
		}),
	);
	return { connections, failures };
}
