/** MCP client tests against a real in-process MCP server over stdio. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { connectMcpServers } from "../src/mcp/client.ts";
import { discoverMcpConfig } from "../src/mcp/config.ts";

let tmp: string;
let serverScript: string;

before(async () => {
	tmp = await mkdtemp(path.join(os.tmpdir(), "arbor-mcp-"));
	// A minimal MCP stdio server using the installed SDK.
	serverScript = path.join(tmp, "server.mjs");
	const sdkBase = path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm");
	await writeFile(
		serverScript,
		`
		import { McpServer } from "${sdkBase}/server/mcp.js";
		import { StdioServerTransport } from "${sdkBase}/server/stdio.js";
		import { z } from "${path.resolve("node_modules/zod/index.js")}";

		const server = new McpServer({ name: "test-server", version: "1.0.0" });
		server.tool("add", "Add two numbers", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
			content: [{ type: "text", text: String(a + b) }],
		}));
		server.tool("boom", "Always fails", {}, async () => ({
			content: [{ type: "text", text: "kaboom" }],
			isError: true,
		}));
		await server.connect(new StdioServerTransport());
		`,
	);
});

after(async () => {
	await rm(tmp, { recursive: true, force: true });
});

describe("MCP config discovery", () => {
	it("merges configs with earlier files winning per server name", async () => {
		const cwd = path.join(tmp, "proj");
		const home = path.join(tmp, "home");
		await import("node:fs/promises").then(async (fs) => {
			await fs.mkdir(path.join(cwd, ".arbor"), { recursive: true });
			await fs.mkdir(path.join(home, ".arbor"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".arbor", "mcp.json"),
				JSON.stringify({ mcpServers: { shared: { command: "project-version" } } }),
			);
			await fs.writeFile(
				path.join(cwd, ".mcp.json"),
				JSON.stringify({ mcpServers: { claude: { command: "claude-compat" } } }),
			);
			await fs.writeFile(
				path.join(home, ".arbor", "mcp.json"),
				JSON.stringify({ mcpServers: { shared: { command: "global-version" }, global: { command: "g" } } }),
			);
		});

		const config = await discoverMcpConfig({ cwd, homeDir: home });
		assert.deepEqual(Object.keys(config.mcpServers).sort(), ["claude", "global", "shared"]);
		assert.equal((config.mcpServers.shared as { command: string }).command, "project-version");
	});

	it("returns empty config when no files exist", async () => {
		const config = await discoverMcpConfig({
			cwd: path.join(tmp, "empty"),
			homeDir: path.join(tmp, "empty"),
		});
		assert.deepEqual(config.mcpServers, {});
	});
});

describe("MCP client (stdio, real server)", () => {
	it("connects, namespaces tools, and calls them", async () => {
		const { connections, failures } = await connectMcpServers({
			mcpServers: { calc: { command: process.execPath, args: [serverScript] } },
		});
		assert.equal(failures.length, 0);
		assert.equal(connections.length, 1);
		const connection = connections[0];
		assert.ok(connection);
		try {
			const names = connection.tools.map((t) => t.name).sort();
			assert.deepEqual(names, ["mcp__calc__add", "mcp__calc__boom"]);
			const addTool = connection.tools.find((t) => t.name === "mcp__calc__add");
			assert.ok(addTool);
			assert.equal(addTool.mutates, true);

			const result = await addTool.execute("t1", { a: 2, b: 40 });
			assert.equal((result.content[0] as { text: string }).text, "42");
		} finally {
			await connection.close();
		}
	});

	it("surfaces isError tool results as thrown errors", async () => {
		const { connections } = await connectMcpServers({
			mcpServers: { calc: { command: process.execPath, args: [serverScript] } },
		});
		const connection = connections[0];
		assert.ok(connection);
		try {
			const boomTool = connection.tools.find((t) => t.name === "mcp__calc__boom");
			assert.ok(boomTool);
			await assert.rejects(boomTool.execute("t1", {}), /kaboom/);
		} finally {
			await connection.close();
		}
	});

	it("collects connection failures without throwing", async () => {
		const { connections, failures } = await connectMcpServers({
			mcpServers: { broken: { command: "/nonexistent/binary" } },
		});
		assert.equal(connections.length, 0);
		assert.equal(failures.length, 1);
		assert.equal(failures[0]?.serverName, "broken");
	});
});
