import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const codec = path.join(root, "scripts/prize-mix-codec.mjs"), runner = path.join(root, "scripts/school-prize-predictors.ts");
const call = (...args: string[]) => spawnSync(process.execPath, [codec, ...args], { encoding: "utf8", timeout: 30_000 });
function scratch<T>(use: (directory: string) => T): T {
	const directory = mkdtempSync(path.join(tmpdir(), "prize-mix-"));
	try { return use(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function encode(bytes: Buffer, mode: string): Buffer {
	return scratch(directory => {
		writeFileSync(path.join(directory, "original"), bytes);
		const done = call("encode", mode, path.join(directory, "original"), path.join(directory, "archive"));
		assert.equal(done.status, 0, done.stderr);
		return readFileSync(path.join(directory, "archive"));
	});
}
function decode(archive: Buffer, mode: string): { status: number | null; stderr: string; restored: Buffer | null } {
	return scratch(directory => {
		writeFileSync(path.join(directory, "archive"), archive);
		const done = call("decode", mode, path.join(directory, "archive"), path.join(directory, "restored"));
		return { status: done.status, stderr: done.stderr, restored: existsSync(path.join(directory, "restored")) ? readFileSync(path.join(directory, "restored")) : null };
	});
}
function noise(length: number): Buffer {
	const bytes = Buffer.alloc(length); let state = 0x2468ace1;
	for (let index = 0; index < length; index++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; bytes[index] = state & 255; }
	return bytes;
}
const text = Buffer.from(Array.from({ length: 500 }, (_, index) => `Entry ${index}: a rule, and the changes needed to recover byte ${index % 7}.\n`).join(""));
const cases: [string, Buffer][] = [
	["empty", Buffer.alloc(0)],
	["one byte", Buffer.from([0])],
	["four bytes, below the match length", Buffer.from("abcd")],
	["every byte value", Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 256))],
	["a long run", Buffer.alloc(150_000, 0xff)],
	["noise", noise(60_000)],
	["text", text],
	["text, then noise, then the same text", Buffer.concat([text, noise(5_000), text])],
];

for (const mode of ["mix", "mix+match"]) for (const [name, bytes] of cases) {
	test(`${mode} restores ${name} exactly`, () => {
		const result = decode(encode(bytes, mode), mode);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.restored!.equals(bytes));
	});
}

test("the repeated-string input shortens repeated text", () => {
	const repeated = cases[7]![1];
	assert.ok(encode(repeated, "mix+match").length < encode(repeated, "mix").length);
	assert.ok(encode(text, "mix").length < text.length / 4);
});

test("a flipped bit, a truncated archive and appended bytes are refused with a reason", () => {
	const archive = encode(text, "mix+match");
	const flipped = Buffer.from(archive); flipped[Math.floor(flipped.length / 2)]! ^= 0x10;
	const damaged = decode(flipped, "mix+match");
	assert.equal(damaged.status, 1); assert.equal(damaged.restored, null);
	assert.match(damaged.stderr, /checksum|does not use|ended before|damaged|too short|exceeds/);
	const short = decode(archive.subarray(0, archive.length - 9), "mix+match");
	assert.equal(short.status, 1); assert.equal(short.restored, null);
	const longer = decode(Buffer.concat([archive, Buffer.from([0])]), "mix+match");
	assert.equal(longer.status, 1); assert.equal(longer.restored, null);
});

test("an archive made with one mode does not restore through the other", () => {
	const result = decode(encode(cases[7]![1], "mix+match"), "mix");
	assert.equal(result.status, 1); assert.equal(result.restored, null);
});

test("a header that claims more than the study limit is refused", () => {
	const result = decode(Buffer.from([0x81, 0x80, 0x40, 0, 0, 0, 0, 0, 0, 0, 0]), "mix");
	assert.equal(result.status, 1); assert.match(result.stderr, /exceeds study limit/);
});

test("unknown modes, extra arguments and oversized input are refused with usage or limit text", () => scratch(directory => {
	const original = path.join(directory, "original"), large = path.join(directory, "large"), archive = path.join(directory, "archive");
	writeFileSync(original, "abc"); writeFileSync(large, Buffer.alloc(1_048_577));
	assert.match(call("encode", "order9", original, archive).stderr, /usage/);
	assert.match(call("encode", "mix", original, archive, "extra").stderr, /usage/);
	assert.match(call("encode", "mix", large, archive).stderr, /exceeds study limit/);
	assert.equal(existsSync(archive), false);
}));

test("the runner refuses an input that differs from its frozen plan, and a variant outside the fixed codecs", () => scratch(directory => {
	const bytes = Buffer.from("planned input\n"), sha256 = createHash("sha256").update(bytes).digest("hex");
	const plan = (extra: object) => JSON.stringify({ format: "school.prize-study-plan/1", inputs: [{ name: "sample", bytes: String(bytes.length), sha256 }], ...extra });
	const run = (planText: string, out: string) => { writeFileSync(path.join(directory, "plan.json"), planText); return spawnSync(process.execPath, [runner, "--plan", path.join(directory, "plan.json"), "--inputs", directory, "--out", path.join(directory, out)], { encoding: "utf8", timeout: 60_000 }); };
	writeFileSync(path.join(directory, "sample.bin"), Buffer.concat([bytes, Buffer.from("x")]));
	const changed = run(plan({}), "changed");
	assert.equal(changed.status, 2); assert.match(changed.stderr, /does not match the frozen plan: sample/); assert.equal(existsSync(path.join(directory, "changed")), false);
	writeFileSync(path.join(directory, "sample.bin"), bytes);
	const foreign = run(plan({ variants: [{ id: "other", program: "scripts/school-prize.ts", argument: "mix" }] }), "foreign");
	assert.equal(foreign.status, 2); assert.match(foreign.stderr, /outside the fixed codecs/);
	const good = run(plan({ variants: [{ id: "mix", program: "scripts/prize-mix-codec.mjs", argument: "mix" }, { id: "deflate", program: "scripts/prize-codec-worker.mjs", argument: "deflate" }], comparisons: [["deflate", "mix"]] }), "good");
	assert.equal(good.status, 0, good.stderr);
	const report = JSON.parse(good.stdout) as { cases: { deflate_to_mix: { candidate: { verdict: string } }; damaged_archive_controls: { restored_equals_original: boolean; decoder_exit_code: number }[] }[] };
	assert.equal(report.cases[0]!.deflate_to_mix.candidate.verdict, "EXACT_BYTES_OBSERVED");
	assert.deepEqual(report.cases[0]!.damaged_archive_controls.map(control => [control.decoder_exit_code, control.restored_equals_original]), [[1, false]]);
}));
