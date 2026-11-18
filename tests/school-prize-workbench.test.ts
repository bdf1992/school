import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const bench = path.resolve(import.meta.dirname, "../scripts/prize-workbench.mjs");
const run = (...args: string[]) => spawnSync(process.execPath, [bench, ...args], { encoding: "utf8", timeout: 60_000 });
const page = (title: string, body: string) => `  <page>\n    <title>${title}</title>\n    <revision>\n      <text xml:space="preserve">${body}</text>\n    </revision>\n  </page>\n`;

test("page-split separates bodies from markup and rebuilds the input exactly, including a cut-off last page", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "prize-bench-"));
	try {
		const whole = `<mediawiki>\n${page("One", "First body.")}${page("Empty", "")}${page("Three", "Third [[body]].")}`;
		const cut = whole.slice(0, whole.length - 30);
		for (const [name, content] of [["whole", whole], ["cut", cut]] as const) {
			const input = path.join(directory, `${name}.xml`), out = path.join(directory, name), back = path.join(directory, `${name}.back`);
			writeFileSync(input, content);
			const applied = run("apply", "page-split", input, out);
			assert.equal(applied.status, 0, applied.stderr);
			const receipt = JSON.parse(readFileSync(path.join(out, "receipt.json"), "utf8")) as { inverse_checked: string; streams: { name: string }[] };
			assert.equal(receipt.inverse_checked, "exact");
			assert.deepEqual(receipt.streams.map(stream => stream.name), ["frame", "text"]);
			assert.ok(!readFileSync(path.join(out, "frame.bin"), "utf8").includes("body"));
			assert.equal(run("invert", "page-split", out, back).status, 0);
			assert.equal(readFileSync(back, "utf8"), content);
		}
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the workbench refuses an input with a zero byte, an unknown operation and a tampered stream", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "prize-bench-"));
	try {
		const input = path.join(directory, "in.xml"), zero = path.join(directory, "zero.bin"), out = path.join(directory, "out");
		writeFileSync(input, page("One", "Body.") + page("Two", "More.")); writeFileSync(zero, Buffer.from([65, 0, 66]));
		const refused = run("apply", "page-split", zero, path.join(directory, "z"));
		assert.equal(refused.status, 1); assert.match(refused.stderr, /zero byte/); assert.equal(existsSync(path.join(directory, "z")), false);
		assert.match(run("apply", "fold-twice", input, path.join(directory, "u")).stderr, /unknown operation/);
		assert.equal(run("apply", "page-split", input, out).status, 0);
		writeFileSync(path.join(out, "text.bin"), Buffer.from("Body.\0"));
		const tampered = run("invert", "page-split", out, path.join(directory, "back"));
		assert.equal(tampered.status, 1); assert.match(tampered.stderr, /fewer bodies/);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
