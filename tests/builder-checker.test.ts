import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalJson } from "../src/core/builder/canonical.ts";
import { gradeRunRecord } from "../src/core/builder/checker.ts";
import { CONTROLS } from "../src/core/builder/task.ts";
import { CONTROL_NAMES, runControl } from "./builder-controls.ts";

const fixturePath = (n: string) => new URL(`./fixtures/builder/${n}.json`, import.meta.url);
if (process.env.WRITE_BUILDER_FIXTURES === "1") {
	for (const n of CONTROL_NAMES) writeFileSync(fixturePath(n), `${canonicalJson(runControl(n))}\n`);
}

const grade = (n: string) => gradeRunRecord(runControl(n));

describe("builder checker: authored controls", () => {
	it("correct passes all six and is qualified", () => {
		const g = grade("correct");
		assert.equal(g.verdict, "qualified");
		assert.deepEqual(g.summary, { failing_cases: [], reason_kinds: [] });
		assert.deepEqual(g.coverage.missing, []);
	});
	it("byte-corrupting fails all six with only byte_mismatch", () => {
		const g = grade("byte-corrupting");
		assert.deepEqual(g.summary, { failing_cases: ["B1", "C1", "H1", "H2", "M1", "R1"], reason_kinds: ["byte_mismatch"] });
	});
	it("observer-confusing fails exactly B1 and C1 with only lamp_mismatch", () => {
		assert.deepEqual(grade("observer-confusing").summary, { failing_cases: ["B1", "C1"], reason_kinds: ["lamp_mismatch"] });
	});
	it("history-forgetting fails H2,C1,M1,B1,R1, passes H1, only lamp_mismatch", () => {
		const g = grade("history-forgetting");
		assert.deepEqual(g.summary, { failing_cases: ["B1", "C1", "H2", "M1", "R1"], reason_kinds: ["lamp_mismatch"] });
		assert.equal(g.cases.find((c) => c.name === "H1")!.pass, true);
	});
	it("the four summaries are distinct and match the task record's intended verdicts", () => {
		const summaries = CONTROL_NAMES.map((n) => canonicalJson(grade(n).summary));
		assert.equal(new Set(summaries).size, 4);
		for (const spec of CONTROLS) {
			const s = grade(spec.name).summary;
			assert.deepEqual(s.failing_cases, [...spec.failsOn].sort());
			assert.deepEqual(s.reason_kinds, [...spec.reasons].sort());
		}
	});
	it("committed fixtures equal the generated records", () => {
		for (const n of CONTROL_NAMES) {
			assert.equal(readFileSync(fixturePath(n), "utf8"), `${canonicalJson(runControl(n))}\n`, n);
		}
	});
});

describe("builder checker: receipts are not enough", () => {
	it("outcome completed with wrong bytes fails", () => {
		const rec = runControl("byte-corrupting");
		assert.ok(rec.runs.every((r) => r.outcome === "completed"));
		assert.equal(gradeRunRecord(rec).verdict, "not_qualified");
	});
	it("a differing subject_after_hex fails with subject_changed", () => {
		const rec = runControl("correct");
		rec.runs[0].subject_after_hex = "41554d007f80feff".replace("41", "42");
		const g = gradeRunRecord(rec);
		assert.equal(g.verdict, "not_qualified");
		assert.deepEqual(g.cases[0].reasons, ["subject_changed"]);
	});
	it("a missing run for a fixture is not_qualified with coverage listed", () => {
		const rec = runControl("correct");
		rec.runs = rec.runs.filter((_, i) => i !== 4);
		const g = gradeRunRecord(rec);
		assert.equal(g.verdict, "not_qualified");
		assert.deepEqual(g.coverage.missing, ["B1"]);
		assert.deepEqual(g.summary.failing_cases, []);
	});
	it("non-completed outcomes, turn counts, admission and malformed runs get their reasons", () => {
		const rec = runControl("correct");
		rec.runs[0].outcome = "limit_exhausted";
		rec.runs[1].turns.pop();
		(rec.runs[2].turns[0] as { admitted: boolean }).admitted = false;
		(rec.runs[3] as { turns: unknown }).turns = "x";
		const g = gradeRunRecord(rec);
		assert.deepEqual(g.cases.slice(0, 4).map((c) => c.reasons), [["not_completed"], ["turn_count_mismatch"], ["action_not_admitted"], ["malformed"]]);
	});
	it("a wrong format or law version is not qualified", () => {
		assert.equal(gradeRunRecord({ ...runControl("correct"), law_version: "builder-v1" }).verdict, "not_qualified");
		assert.equal(gradeRunRecord(null).verdict, "not_qualified");
	});
});
