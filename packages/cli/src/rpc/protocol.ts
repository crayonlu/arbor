/**
 * ExtensionUi backed by the RPC roundtrip. The agent's ask/confirm/select/input
 * calls emit an `extension_ui_request` over stdout; the host replies with an
 * `extension_ui_response` carrying the same id. `notify` is fire-and-forget.
 *
 * This lets a headless RPC host fully participate in extension/tool prompts
 * (the ask tool, confirmations, model selectors) without a TUI.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionUi } from "@arbor-space/core";
import type { RpcExtensionUiRequest, RpcExtensionUiResponse, RpcOutput } from "./types.ts";

interface Pending {
	resolve: (value: RpcExtensionUiResponse) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export interface RpcUiHandle {
	ui: ExtensionUi;
	/** Feed an incoming extension_ui_response; resolves the matching promise. */
	resolveResponse: (response: RpcExtensionUiResponse) => void;
	/** Reject all pending requests (on shutdown). */
	rejectAll: (error: Error) => void;
}

export function createRpcUi(output: (value: RpcOutput) => void, timeoutMs = DEFAULT_TIMEOUT_MS): RpcUiHandle {
	const pending = new Map<string, Pending>();

	const request = (
		method: RpcExtensionUiRequest["method"],
		payload: Record<string, unknown>,
	): Promise<RpcExtensionUiResponse> => {
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const entry: Pending = { resolve, reject };
			entry.timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`Extension UI request timed out (${method})`));
			}, timeoutMs);
			pending.set(id, entry);
			output({ type: "extension_ui_request", id, method, ...payload });
		});
	};

	const ui: ExtensionUi = {
		notify: (message, level) => {
			output({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, level });
		},
		confirm: async (title, message) => {
			try {
				const r = await request("confirm", { title, message });
				return Boolean(r.confirmed);
			} catch {
				return false;
			}
		},
		input: async (title, placeholder) => {
			try {
				const r = await request("input", { title, placeholder });
				return typeof r.value === "string" ? r.value : undefined;
			} catch {
				return undefined;
			}
		},
		select: async (title, options) => {
			try {
				const r = await request("select", { title, options });
				return typeof r.value === "string" ? r.value : undefined;
			} catch {
				return undefined;
			}
		},
		ask: async (question) => {
			try {
				const r = await request("ask", { question });
				return Array.isArray(r.value) ? (r.value as string[]) : undefined;
			} catch {
				return undefined;
			}
		},
	};

	return {
		ui,
		resolveResponse: (response) => {
			const entry = pending.get(response.id);
			if (!entry) return;
			pending.delete(response.id);
			if (entry.timer) clearTimeout(entry.timer);
			entry.resolve(response);
		},
		rejectAll: (error) => {
			for (const entry of pending.values()) {
				if (entry.timer) clearTimeout(entry.timer);
				entry.reject(error);
			}
			pending.clear();
		},
	};
}
