/**
 * MCP OAuth support: file-backed credential storage, an OAuthClientProvider
 * implementation for the MCP SDK, and a one-shot loopback callback server.
 *
 * The SDK drives the actual OAuth flow (PKCE, dynamic client registration,
 * token refresh); this module supplies persistence and the browser handoff.
 * Flow: connect with an authProvider → SDK throws UnauthorizedError and
 * calls redirectToAuthorization(url) → caller opens the URL → the loopback
 * server catches the code → transport.finishAuth(code) → reconnect.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationFull,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

// -- storage -----------------------------------------------------------------

export interface McpAuthEntry {
	/** Server URL the credentials were issued for; a change invalidates them. */
	serverUrl: string;
	clientInfo?: OAuthClientInformationFull;
	tokens?: OAuthTokens;
	codeVerifier?: string;
}

export interface McpAuthStorage {
	get(serverName: string, serverUrl: string): McpAuthEntry | undefined;
	update(serverName: string, serverUrl: string, patch: Partial<McpAuthEntry>): void;
	clear(serverName: string): void;
}

export function defaultMcpAuthPath(): string {
	return path.join(os.homedir(), ".arbor", "mcp-auth.json");
}

/**
 * JSON file storage at ~/.arbor/mcp-auth.json (0600). Entries are keyed by
 * server name; credentials for a different serverUrl are treated as absent
 * so a config URL change forces re-authorization instead of leaking tokens.
 */
export class FileMcpAuthStorage implements McpAuthStorage {
	private readonly filePath: string;

	constructor(filePath?: string) {
		this.filePath = filePath ?? defaultMcpAuthPath();
	}

	private read(): Record<string, McpAuthEntry> {
		try {
			return JSON.parse(readFileSync(this.filePath, "utf-8")) as Record<string, McpAuthEntry>;
		} catch {
			return {};
		}
	}

	private write(data: Record<string, McpAuthEntry>): void {
		mkdirSync(path.dirname(this.filePath), { recursive: true });
		const tempPath = `${this.filePath}.tmp`;
		writeFileSync(tempPath, JSON.stringify(data, null, "\t"), { encoding: "utf-8", mode: 0o600 });
		renameSync(tempPath, this.filePath);
	}

	get(serverName: string, serverUrl: string): McpAuthEntry | undefined {
		const entry = this.read()[serverName];
		if (!entry || entry.serverUrl !== serverUrl) return undefined;
		return entry;
	}

	update(serverName: string, serverUrl: string, patch: Partial<McpAuthEntry>): void {
		const data = this.read();
		const existing = data[serverName];
		// A URL change discards stale credentials instead of merging into them.
		const base: McpAuthEntry = existing && existing.serverUrl === serverUrl ? existing : { serverUrl };
		data[serverName] = { ...base, ...patch, serverUrl };
		this.write(data);
	}

	clear(serverName: string): void {
		const data = this.read();
		if (serverName in data) {
			delete data[serverName];
			this.write(data);
		}
	}
}

/** In-memory storage (tests, ephemeral sessions). */
export class MemoryMcpAuthStorage implements McpAuthStorage {
	private entries = new Map<string, McpAuthEntry>();

	get(serverName: string, serverUrl: string): McpAuthEntry | undefined {
		const entry = this.entries.get(serverName);
		return entry && entry.serverUrl === serverUrl ? entry : undefined;
	}

	update(serverName: string, serverUrl: string, patch: Partial<McpAuthEntry>): void {
		const existing = this.entries.get(serverName);
		const base: McpAuthEntry = existing && existing.serverUrl === serverUrl ? existing : { serverUrl };
		this.entries.set(serverName, { ...base, ...patch, serverUrl });
	}

	clear(serverName: string): void {
		this.entries.delete(serverName);
	}
}

// -- provider ------------------------------------------------------------------

export interface ArborOAuthProviderOptions {
	serverName: string;
	serverUrl: string;
	storage: McpAuthStorage;
	redirectUrl: string;
	/** Receives the authorization URL the user must open. */
	onRedirect: (url: URL) => void | Promise<void>;
}

/**
 * OAuthClientProvider backed by McpAuthStorage. Uses PKCE with dynamic
 * client registration (token_endpoint_auth_method "none") — no client
 * secret is ever configured or stored by default.
 */
export class ArborOAuthProvider implements OAuthClientProvider {
	private readonly options: ArborOAuthProviderOptions;

	constructor(options: ArborOAuthProviderOptions) {
		this.options = options;
	}

	get redirectUrl(): string {
		return this.options.redirectUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			redirect_uris: [this.options.redirectUrl],
			client_name: "Arbor",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	private entry(): McpAuthEntry | undefined {
		return this.options.storage.get(this.options.serverName, this.options.serverUrl);
	}

	private save(patch: Partial<McpAuthEntry>): void {
		this.options.storage.update(this.options.serverName, this.options.serverUrl, patch);
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return this.entry()?.clientInfo;
	}

	saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
		this.save({ clientInfo: clientInformation as OAuthClientInformationFull });
	}

	tokens(): OAuthTokens | undefined {
		return this.entry()?.tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.save({ tokens });
	}

	saveCodeVerifier(codeVerifier: string): void {
		this.save({ codeVerifier });
	}

	codeVerifier(): string {
		const verifier = this.entry()?.codeVerifier;
		if (!verifier) {
			throw new Error(`No PKCE code verifier stored for MCP server ${this.options.serverName}`);
		}
		return verifier;
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		await this.options.onRedirect(authorizationUrl);
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		switch (scope) {
			case "all":
				this.options.storage.clear(this.options.serverName);
				break;
			case "client":
				this.save({ clientInfo: undefined as never });
				break;
			case "tokens":
				this.save({ tokens: undefined as never });
				break;
			case "verifier":
				this.save({ codeVerifier: undefined as never });
				break;
			default:
				break;
		}
	}
}

// -- callback server -----------------------------------------------------------

export const DEFAULT_OAUTH_CALLBACK_PORT = 19877;
const DEFAULT_CALLBACK_TIMEOUT_MS = 300_000;

const CALLBACK_HTML = `<!doctype html><html><body style="font-family: system-ui; padding: 3rem; text-align: center">
<h2>Authorization complete</h2><p>You can close this tab and return to Arbor.</p>
</body></html>`;

export interface OAuthCallbackServer {
	port: number;
	redirectUrl: string;
	/** Resolves with the authorization code from the provider redirect. */
	waitForCode(timeoutMs?: number): Promise<string>;
	close(): void;
}

/** Start a one-shot loopback HTTP server that captures the OAuth redirect. */
export function startOAuthCallbackServer(port = DEFAULT_OAUTH_CALLBACK_PORT): Promise<OAuthCallbackServer> {
	return new Promise((resolveServer, rejectServer) => {
		let resolveCode: ((code: string) => void) | null = null;
		let rejectCode: ((error: Error) => void) | null = null;
		let received: string | Error | null = null;

		const server = http.createServer((request, response) => {
			const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
			if (url.pathname !== "/callback") {
				response.writeHead(404).end();
				return;
			}
			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");
			response.writeHead(200, { "content-type": "text/html" }).end(CALLBACK_HTML);
			const outcome = code ?? new Error(`Authorization failed: ${error ?? "no code returned"}`);
			if (typeof outcome === "string" && resolveCode) resolveCode(outcome);
			else if (outcome instanceof Error && rejectCode) rejectCode(outcome);
			else received = outcome;
		});

		server.once("error", rejectServer);
		server.listen(port, "127.0.0.1", () => {
			resolveServer({
				port,
				redirectUrl: `http://127.0.0.1:${port}/callback`,
				waitForCode(timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS) {
					return new Promise<string>((resolve, reject) => {
						// The redirect may have arrived before anyone waited.
						if (typeof received === "string") return resolve(received);
						if (received instanceof Error) return reject(received);
						const timer = setTimeout(() => {
							reject(new Error(`Timed out waiting for the OAuth callback after ${timeoutMs}ms`));
						}, timeoutMs);
						timer.unref?.();
						resolveCode = (code) => {
							clearTimeout(timer);
							resolve(code);
						};
						rejectCode = (error) => {
							clearTimeout(timer);
							reject(error);
						};
					});
				},
				close() {
					server.close();
				},
			});
		});
	});
}
