import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bitsView, expectedTurns, highNibblesView, latchStep, popcountView, reading, applyOp } from "../src/core/builder/law.ts";
import { G0_FIXTURES } from "../src/core/builder/task.ts";

// Literal from docs/builder-curriculum.md, "Public G0 fixtures".
const DOC_LAMPS: Record<string, number[]> = {
	H1: [1, 1],
	H2: [0, 0],
	C1: [0],
	M1: [1, 1],
	B1: [1, 1],
	R1: [0, 0, 0, 0, 0, 0, 0, 0],
};

describe("builder law", () => {
	it("law table: expected lamps of H1,H2,C1,M1,B1,R1 match the doc", () => {
		assert.equal(G0_FIXTURES.length, 6);
		for (const f of G0_FIXTURES) assert.deepEqual(expectedTurns(f.case).map((t) => t.lamp), DOC_LAMPS[f.name], f.name);
	});
	it("bytes: R1 covers all eight subject indices in order", () => {
		const r1 = G0_FIXTURES.find((f) => f.name === "R1")!;
		assert.deepEqual(expectedTurns(r1.case).map((t) => t.byte), [0x41, 0x55, 0x4d, 0, 0x7f, 0x80, 0xfe, 0xff]);
	});
	it("readings: calibrations, condition and missing", () => {
		assert.equal(reading("A", 220, 2), 156);
		assert.equal(reading("B", 20, 0), 235);
		assert.equal(reading("B", 128, 0), 127);
		assert.equal(reading("A", 10, 3), 0);
		assert.equal(reading("A", null, 0), null);
	});
	it("latch and condition ops", () => {
		assert.equal(latchStep(0, 192), 1);
		assert.equal(latchStep(1, 63), 0);
		assert.equal(latchStep(1, 100), 1);
		assert.equal(latchStep(1, null), 1);
		assert.equal(applyOp(3, "shade"), 3);
		assert.equal(applyOp(0, "unshade"), 0);
	});
	it("views: bits, high nibbles, popcount", () => {
		const bits = bitsView();
		assert.equal(bits.length, 64);
		assert.deepEqual(bits.slice(0, 8), [0, 1, 0, 0, 0, 0, 0, 1]);
		assert.deepEqual(highNibblesView(), [4, 5, 4, 0, 7, 8, 15, 15]);
		assert.equal(popcountView(), 2 + 4 + 4 + 0 + 7 + 1 + 7 + 8);
	});
});
