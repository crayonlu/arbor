/** MCP OAuth tests: storage, provider persistence, callback server. */
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	ArborOAuthProvider,
	FileMcpAuthStorage,
	MemoryMcpAuthStorage,
	startOAuthCallbackServer,
} from "../src/mcp/oauth.ts";

let root: string;

before(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "arbor-oauth-"));
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

const TOKENS = { access_token: "at-1", token_type: "bearer", refresh_token: "rt-1" };
const CLIENT_INFO = { client_id: "client-1", redirect_uris: ["http://127.0.0.1:19877/callback"] };

describe("MCP auth storage", () => {
	it("round-trips entries and persists across instances", async () => {
		const filePath = path.join(root, "auth.json");
		const storage = new FileMcpAuthStorage(filePath);
		storage.update("github", "https://mcp.github.com", { tokens: TOKENS });

		const reloaded = new FileMcpAuthStorage(filePath);
		const entry = reloaded.get("github", "https://mcp.github.com");
		assert.deepEqual(entry?.tokens, TOKENS);
	});

	it("file is created with 0600 permissions", async () => {
		const filePath = path.join(root, "perm.json");
		new FileMcpAuthStorage(filePath).update("x", "https://x", { codeVerifier: "v" });
		const mode = (await stat(filePath)).mode & 0o777;
		assert.equal(mode, 0o600);
	});

	it("a server URL change invalidates stored credentials", () => {
		const storage = new MemoryMcpAuthStorage();
		storage.update("api", "https://old.example.com", { tokens: TOKENS });
		assert.equal(storage.get("api", "https://new.example.com"), undefined);
		// Updating under the new URL discards the old entry's credentials.
		storage.update("api", "https://new.example.com", { codeVerifier: "v2" });
		const entry = storage.get("api", "https://new.example.com");
		assert.equal(entry?.tokens, undefined);
		assert.equal(entry?.codeVerifier, "v2");
	});

	it("clear removes the entry", () => {
		const storage = new MemoryMcpAuthStorage();
		storage.update("gone", "https://x", { tokens: TOKENS });
		storage.clear("gone");
		assert.equal(storage.get("gone", "https://x"), undefined);
	});
});

describe("ArborOAuthProvider", () => {
	function makeProvider(storage = new MemoryMcpAuthStorage()) {
		const redirects: URL[] = [];
		const provider = new ArborOAuthProvider({
			serverName: "test",
			serverUrl: "https://mcp.test",
			storage,
			redirectUrl: "http://127.0.0.1:19877/callback",
			onRedirect: (url) => {
				redirects.push(url);
			},
		});
		return { provider, storage, redirects };
	}

	it("client metadata uses PKCE without a client secret", () => {
		const { provider } = makeProvider();
		assert.equal(provider.clientMetadata.token_endpoint_auth_method, "none");
		assert.deepEqual(provider.clientMetadata.grant_types, ["authorization_code", "refresh_token"]);
		assert.equal(provider.redirectUrl, "http://127.0.0.1:19877/callback");
	});

	it("persists tokens, client info, and code verifier through storage", () => {
		const { provider, storage } = makeProvider();
		provider.saveClientInformation(CLIENT_INFO);
		provider.saveTokens(TOKENS);
		provider.saveCodeVerifier("verifier-abc");

		assert.deepEqual(provider.clientInformation(), CLIENT_INFO);
		assert.deepEqual(provider.tokens(), TOKENS);
		assert.equal(provider.codeVerifier(), "verifier-abc");
		assert.deepEqual(storage.get("test", "https://mcp.test")?.tokens, TOKENS);
	});

	it("codeVerifier throws when none is stored", () => {
		const { provider } = makeProvider();
		assert.throws(() => provider.codeVerifier(), /No PKCE code verifier/);
	});

	it("redirectToAuthorization forwards the URL", async () => {
		const { provider, redirects } = makeProvider();
		await provider.redirectToAuthorization(new URL("https://auth.test/authorize?x=1"));
		assert.equal(redirects.length, 1);
		assert.equal(redirects[0]?.hostname, "auth.test");
	});

	it("invalidateCredentials scopes work", () => {
		const { provider, storage } = makeProvider();
		provider.saveClientInformation(CLIENT_INFO);
		provider.saveTokens(TOKENS);
		provider.invalidateCredentials("tokens");
		assert.equal(provider.tokens(), undefined);
		assert.deepEqual(provider.clientInformation(), CLIENT_INFO);
		provider.invalidateCredentials("all");
		assert.equal(storage.get("test", "https://mcp.test"), undefined);
	});
});

describe("OAuth callback server", () => {
	it("captures the authorization code from the redirect", async () => {
		const server = await startOAuthCallbackServer(19911);
		try {
			const waiting = server.waitForCode(5000);
			const response = await fetch(`http://127.0.0.1:19911/callback?code=auth-code-123&state=s`);
			assert.equal(response.status, 200);
			assert.match(await response.text(), /Authorization complete/);
			assert.equal(await waiting, "auth-code-123");
		} finally {
			server.close();
		}
	});

	it("resolves even when the redirect beats waitForCode", async () => {
		const server = await startOAuthCallbackServer(19912);
		try {
			await fetch(`http://127.0.0.1:19912/callback?code=early-bird`);
			assert.equal(await server.waitForCode(1000), "early-bird");
		} finally {
			server.close();
		}
	});

	it("rejects on provider error responses", async () => {
		const server = await startOAuthCallbackServer(19913);
		try {
			const waiting = server.waitForCode(5000);
			// Attach a handler before the rejection lands (avoids an unhandled
			// rejection between the fetch and the assertion).
			const outcome = waiting.then(
				() => null,
				(error: Error) => error,
			);
			await fetch(`http://127.0.0.1:19913/callback?error=access_denied`);
			const error = await outcome;
			assert.match(error?.message ?? "", /access_denied/);
		} finally {
			server.close();
		}
	});

	it("404s for other paths and times out without a redirect", async () => {
		const server = await startOAuthCallbackServer(19914);
		try {
			const response = await fetch(`http://127.0.0.1:19914/other`);
			assert.equal(response.status, 404);
			await assert.rejects(() => server.waitForCode(100), /Timed out/);
		} finally {
			server.close();
		}
	});
});
