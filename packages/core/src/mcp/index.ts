/** MCP subsystem: client (stdio + streamable HTTP) with optional OAuth. */
export type {
	McpConfig,
	McpConnection,
	McpConnectOptions,
	McpConnectResult,
	McpHttpServerConfig,
	McpOAuthConnectOptions,
	McpServerConfig,
	McpStdioServerConfig,
} from "./client.ts";
export { connectMcpServer, connectMcpServers } from "./client.ts";
export type { McpConfigDiscoveryOptions } from "./config.ts";
export { discoverMcpConfig } from "./config.ts";
export type {
	ArborOAuthProviderOptions,
	McpAuthEntry,
	McpAuthStorage,
	OAuthCallbackServer,
} from "./oauth.ts";
export {
	ArborOAuthProvider,
	DEFAULT_OAUTH_CALLBACK_PORT,
	defaultMcpAuthPath,
	FileMcpAuthStorage,
	MemoryMcpAuthStorage,
	startOAuthCallbackServer,
} from "./oauth.ts";
