import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const codec = path.resolve(import.meta.dirname, "../scripts/prize-predictor-codec.mjs");
const call = (...args: string[]) => spawnSync(process.execPath, [codec, ...args], { encoding: "utf8", timeout: 30_000 });

function roundTrip(bytes: Buffer, order: string): { archive: Buffer; restored: Buffer } {
	const directory = mkdtempSync(path.join(tmpdir(), "prize-predictor-"));
	try {
		const original = path.join(directory, "original"), archive = path.join(directory, "archive"), restored = path.join(directory, "restored");
		writeFileSync(original, bytes);
		const encoded = call("encode", order, original, archive);
		assert.equal(encoded.status, 0, encoded.stderr);
		const decoded = call("decode", order, archive, restored);
		assert.equal(decoded.status, 0, decoded.stderr);
		return { archive: readFileSync(archive), restored: readFileSync(restored) };
	} finally { rmSync(directory, { recursive: true, force: true }); }
}
function noise(length: number): Buffer {
	const bytes = Buffer.alloc(length); let state = 0x1234abcd;
	for (let index = 0; index < length; index++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; bytes[index] = state & 255; }
	return bytes;
}
const everyByte = Buffer.from(Array.from({ length: 768 }, (_, index) => index % 256));
const cases: [string, Buffer][] = [
	["empty", Buffer.alloc(0)],
	["one byte", Buffer.from([0])],
	["highest byte", Buffer.from([255, 255])],
	["every byte value", everyByte],
	["long run that halves the counts many times", Buffer.alloc(200_000, 0x41)],
	["noise", noise(70_000)],
	["text", Buffer.from("A rule and the changes needed to recover each byte.\n".repeat(400))],
];

for (const order of ["0", "1"]) for (const [name, bytes] of cases) {
	test(`order ${order} restores ${name} exactly`, () => {
		assert.ok(roundTrip(bytes, order).restored.equals(bytes));
	});
}

test("the previous-byte context shortens repeated text and lengthens noise", () => {
	const text = cases[6]![1], random = cases[5]![1];
	assert.ok(roundTrip(text, "1").archive.length < roundTrip(text, "0").archive.length);
	assert.ok(roundTrip(random, "1").archive.length > roundTrip(random, "0").archive.length);
	assert.ok(roundTrip(random, "0").archive.length > random.length);
});

test("an archive encoded with one order does not restore through the other", () => {
	const text = cases[6]![1], directory = mkdtempSync(path.join(tmpdir(), "prize-predictor-"));
	try {
		const archive = path.join(directory, "archive"), restored = path.join(directory, "restored");
		writeFileSync(archive, roundTrip(text, "1").archive);
		const decoded = call("decode", "0", archive, restored);
		assert.ok(decoded.status !== 0 || !readFileSync(restored).equals(text));
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a truncated archive does not restore the original", () => {
	const text = cases[6]![1], directory = mkdtempSync(path.join(tmpdir(), "prize-predictor-"));
	try {
		const full = roundTrip(text, "1").archive, archive = path.join(directory, "archive"), restored = path.join(directory, "restored");
		writeFileSync(archive, full.subarray(0, Math.floor(full.length / 2)));
		const decoded = call("decode", "1", archive, restored);
		assert.ok(decoded.status !== 0 || !readFileSync(restored).equals(text));
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("invalid orders, extra arguments, oversized input and existing output are refused", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "prize-predictor-"));
	try {
		const original = path.join(directory, "original"), archive = path.join(directory, "archive"), large = path.join(directory, "large");
		writeFileSync(original, "abc"); writeFileSync(large, Buffer.alloc(1_048_577));
		assert.equal(call("encode", "2", original, archive).status, 1);
		assert.equal(call("encode", "0", original, archive, "extra").status, 1);
		assert.equal(call("pack", "0", original, archive).status, 1);
		assert.equal(call("encode", "0", large, archive).status, 1);
		assert.equal(call("encode", "0", original, archive).status, 0);
		assert.equal(call("encode", "0", original, archive).status, 1);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
