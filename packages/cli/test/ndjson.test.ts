/** NDJSON framing tests. */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { attachJsonlLineReader, serializeLine } from "../src/ndjson.ts";

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

describe("serializeLine", () => {
	it("produces strict JSON terminated by LF", () => {
		assert.equal(serializeLine({ a: 1 }), '{"a":1}\n');
	});

	it("escapes U+2028/U+2029 so they cannot break a line-splitting receiver", () => {
		const line = serializeLine({ text: `a${LS}b${PS}c` });
		// Exactly one trailing LF; the separators are escaped, not literal.
		assert.equal(line.endsWith("\n"), true);
		assert.equal(line.indexOf(LS), -1);
		assert.equal(line.indexOf(PS), -1);
		assert.ok(line.includes("\\u2028"));
		assert.ok(line.includes("\\u2029"));
		// Still valid JSON parsing to the same value.
		assert.deepEqual(JSON.parse(line), { text: `a${LS}b${PS}c` });
	});
});

describe("attachJsonlLineReader", () => {
	it("splits on LF only and emits the trailing partial line on end", async () => {
		const lines: string[] = [];
		const stream = Readable.from(['{"a":1}\n{"b":2}\npartial']);
		const detach = attachJsonlLineReader(stream, (l) => lines.push(l));
		await new Promise((resolve) => stream.on("end", resolve));
		detach();
		assert.deepEqual(lines, ['{"a":1}', '{"b":2}', "partial"]);
	});

	it("does not split on U+2028/U+2029 inside a record", async () => {
		const lines: string[] = [];
		const payload = `{"x":"a${LS}b${PS}c"}`;
		const stream = Readable.from([`${payload}\n`]);
		const detach = attachJsonlLineReader(stream, (l) => lines.push(l));
		await new Promise((resolve) => stream.on("end", resolve));
		detach();
		assert.equal(lines.length, 1);
		assert.equal(lines[0], payload);
	});
});
