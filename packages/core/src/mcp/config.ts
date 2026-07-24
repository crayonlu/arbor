/**
 * MCP config discovery: read mcpServers from Arbor and compatible locations.
 *
 * Search order (later files add servers; earlier names win):
 * 1. <cwd>/.arbor/mcp.json
 * 2. <cwd>/.mcp.json          (Claude Code project convention)
 * 3. ~/.arbor/mcp.json
 */
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { McpConfig, McpServerConfig } from "./client.ts";

export interface McpConfigDiscoveryOptions {
	cwd: string;
	homeDir?: string;
	/** Extra config file paths (settings). */
	extraPaths?: string[];
}

async function readConfigFile(filePath: string): Promise<Record<string, McpServerConfig>> {
	const content = await readFile(filePath, "utf-8").catch(() => null);
	if (content === null) return {};
	try {
		const parsed = JSON.parse(content) as { mcpServers?: Record<string, McpServerConfig> };
		return parsed.mcpServers ?? {};
	} catch {
		return {};
	}
}

/** Merge MCP configs from all known locations. First definition of a name wins. */
export async function discoverMcpConfig(options: McpConfigDiscoveryOptions): Promise<McpConfig> {
	const home = options.homeDir ?? os.homedir();
	const files = [
		path.join(options.cwd, ".arbor", "mcp.json"),
		path.join(options.cwd, ".mcp.json"),
		path.join(home, ".arbor", "mcp.json"),
		...(options.extraPaths ?? []).map((p) => path.resolve(options.cwd, p)),
	];
	const merged: Record<string, McpServerConfig> = {};
	for (const file of files) {
		const servers = await readConfigFile(file);
		for (const [name, config] of Object.entries(servers)) {
			if (!(name in merged)) merged[name] = config;
		}
	}
	return { mcpServers: merged };
}
