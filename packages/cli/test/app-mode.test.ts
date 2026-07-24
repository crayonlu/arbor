/** resolveAppMode tests. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAppMode } from "../src/app-mode.ts";

describe("resolveAppMode", () => {
	it("interactive when both streams are TTY and no print flag", () => {
		assert.equal(resolveAppMode({ stdinIsTty: true, stdoutIsTty: true }), "interactive");
	});

	it("print-text when piped stdin", () => {
		assert.equal(resolveAppMode({ stdinIsTty: false, stdoutIsTty: true }), "print-text");
	});

	it("print-text when -p is set even on a TTY", () => {
		assert.equal(resolveAppMode({ print: true, stdinIsTty: true, stdoutIsTty: true }), "print-text");
	});

	it("print-json when --json is set", () => {
		assert.equal(resolveAppMode({ json: true, stdinIsTty: false, stdoutIsTty: true }), "print-json");
	});

	it("rpc takes precedence", () => {
		assert.equal(resolveAppMode({ mode: "rpc", json: true, stdinIsTty: true, stdoutIsTty: true }), "rpc");
	});

	it("print-json via --mode json", () => {
		assert.equal(resolveAppMode({ mode: "json", stdinIsTty: true, stdoutIsTty: true }), "print-json");
	});
});
