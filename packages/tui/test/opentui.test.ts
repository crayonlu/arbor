/**
 * OpenTUI-on-Bun capability baseline (durable form of the M6.1 spike).
 *
 * Guards the load-bearing assumption: @opentui/core's native FFI works under
 * Bun, the imperative (non-JSX) composition API renders, and the built-in
 * Diff renderable produces a framed unified diff. Runs under `bun test`.
 */
import { describe, expect, it } from "bun:test";
import { Box, DiffRenderable, instantiate, Text } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

describe("opentui on bun", () => {
	it("renders a Box + Text via the imperative vnode API", async () => {
		const { renderer, flush, captureCharFrame } = await createTestRenderer({
			width: 32,
			height: 6,
		});
		try {
			const node = instantiate(
				renderer,
				Box({ border: true, title: "arbor", width: 20, height: 3 }, Text({ content: "hello" })),
			);
			renderer.root.insertBefore(node, undefined);
			await flush();
			const frame = captureCharFrame();
			expect(frame).toContain("arbor");
			expect(frame).toContain("hello");
		} finally {
			renderer.destroy();
		}
	});

	it("renders a unified diff via the built-in Diff renderable", async () => {
		const { renderer, flush, captureCharFrame } = await createTestRenderer({
			width: 48,
			height: 8,
		});
		try {
			const diff = new DiffRenderable(renderer, {
				diff: "--- a/f.ts\n+++ b/f.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n keep\n",
				view: "unified",
				showLineNumbers: true,
				width: 48,
				height: 8,
			});
			renderer.root.insertBefore(diff, undefined);
			await flush();
			const frame = captureCharFrame();
			expect(frame).toContain("new line");
			expect(frame).toContain("old line");
		} finally {
			renderer.destroy();
		}
	});
});
