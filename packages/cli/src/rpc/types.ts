/**
 * RPC protocol types — stdio JSONL. Commands come in on stdin (each with an
 * optional `id` for correlation); responses and events go out on stdout.
 * Extension UI requests (ask/confirm/select/input) are emitted as
 * `extension_ui_request` and resolved by a matching `extension_ui_response`.
 */

export type RpcCommand =
	| { type: "prompt"; id?: string; message: string; images?: unknown[] }
	| { type: "steer"; id?: string; message: string }
	| { type: "abort"; id?: string }
	| { type: "request_stop"; id?: string }
	| { type: "get_state"; id?: string }
	| { type: "get_messages"; id?: string }
	| { type: "set_model"; id?: string; provider: string; modelId: string }
	| { type: "set_mode"; id?: string; mode: "build" | "plan" }
	| { type: "compact"; id?: string }
	| { type: "rewind"; id?: string; entryId: string }
	| { type: "get_tree"; id?: string }
	| { type: "get_entries"; id?: string; since?: string }
	| { type: "fork"; id?: string; entryId?: string }
	| { type: "get_commands"; id?: string }
	| { type: "invoke_command"; id?: string; text: string }
	| { type: "set_session_name"; id?: string; name: string }
	| { type: "shutdown"; id?: string };

export interface RpcResponse {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export interface RpcExtensionUiRequest {
	type: "extension_ui_request";
	id: string;
	method: "notify" | "confirm" | "input" | "select" | "ask";
	[key: string]: unknown;
}

export interface RpcExtensionUiResponse {
	type: "extension_ui_response";
	id: string;
	[key: string]: unknown;
}

/** Anything written to stdout: a response, an event, or a UI request. */
export type RpcOutput = RpcResponse | RpcExtensionUiRequest | { type: string; [key: string]: unknown };

export function ok(id: string | undefined, command: string, data?: unknown): RpcResponse {
	const base: RpcResponse = { type: "response", command, success: true };
	return {
		...base,
		...(id !== undefined ? { id } : {}),
		...(data !== undefined ? { data } : {}),
	};
}

export function fail(id: string | undefined, command: string, error: string): RpcResponse {
	const base: RpcResponse = { type: "response", command, success: false, error };
	return { ...base, ...(id !== undefined ? { id } : {}) };
}
