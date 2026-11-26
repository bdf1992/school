import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { builderView, evaluatorView, residentTurnView, teacherView, type BuilderTask } from "../src/core/builder/views.ts";
import { G0_FIXTURES, type NamedCase } from "../src/core/builder/task.ts";

const [H1, , , M1, B1] = G0_FIXTURES as [NamedCase, NamedCase, NamedCase, NamedCase, NamedCase, NamedCase];
const sealedCase = { name: "S-secret", case: { receiver: "B" as const, signals: [7, 99, 251], conditionOps: [{ turn: 1, op: "shade" as const }] } };
const task: BuilderTask = { teaching: [H1], sealed: [sealedCase, M1], budgets: { turns: 8 } };

describe("builder views", () => {
	it("teaching cases in the builder view carry expected lamps", () => {
		const v = builderView(task);
		assert.deepEqual(v.teaching_cases[0]!.expected_lamps, ["on", "on"]);
	});
	it("sealed cases and expectations never appear in builder or teacher views", () => {
		for (const v of [builderView(task), teacherView(task, [{ attempt: 1, summary: "s", diagnostics: ["d"] }])]) {
			const text = JSON.stringify(v);
			assert.ok(!text.includes("S-secret"));
			assert.ok(!text.includes("251"));
			assert.ok(!text.includes('"sealed"'));
			assert.equal(v.teaching_cases.length, 1);
		}
		assert.equal(teacherView(task, [{ attempt: 1, summary: "s", diagnostics: ["d"] }]).attempts.length, 1);
	});
	it("resident per-turn view has the observation and read-only subject views but no expectation", () => {
		const v = residentTurnView({ receiver: B1.case.receiver, signal: null, condition: 2, turn: 5, memory: { latch: 1 } });
		assert.equal(v.signal, "missing");
		assert.deepEqual([v.receiver, v.condition, v.turn, v.memory], ["B", 2, 5, { latch: 1 }]);
		assert.equal(v.subject.bytes.length, 8);
		assert.equal(v.subject.bits.length, 64);
		assert.equal(v.subject.high_nibbles.length, 8);
		assert.equal(typeof v.subject.popcount, "number");
		assert.deepEqual(Object.keys(v).sort(), ["condition", "memory", "receiver", "signal", "subject", "turn"]);
		assert.ok(!/lamp|expected|sealed/.test(JSON.stringify(v)));
	});
	it("evaluator view carries sealed expectations", () => {
		const v = evaluatorView(task);
		assert.equal(v.sealed.length, 2);
		assert.deepEqual(v.sealed[0]!.expected.map((e) => e.lamp), [1, 1, 0]);
	});
});
