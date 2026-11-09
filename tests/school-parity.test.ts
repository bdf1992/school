import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { evaluateSchoolParityMachine, executeSchoolParityMachine, MAX_SCHOOL_PARITY_BYTES, parseSchoolParityMachine, SCHOOL_PARITY_ADDITIONAL_INPUTS, schoolParityOracle, type SchoolParityMachine } from "../src/core/school-parity.ts";

const checkout = path.resolve(import.meta.dirname, "..");
const goodFile = path.join(checkout, "examples/school/parity-machine.json");
const mutantFile = path.join(checkout, "examples/school/parity-machine-mutated.json");
const good = (): SchoolParityMachine => JSON.parse(readFileSync(goodFile, "utf8"));
const scratch = mkdtempSync(path.join(tmpdir(), "school-parity-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/school-parity.ts", ...args], { cwd: checkout, encoding: "utf8", timeout: 10000 });

test("a parity machine passes all 256 bytes and every declared additional string", () => {
	const result = evaluateSchoolParityMachine(good());
	assert.equal(result.status, "PASSED");
	assert.deepEqual(result.bytes, { checked: 256, passed: 256, failed: 0 });
	assert.deepEqual(result.additional, { checked: 16, passed: 16, failed: 0 });
	assert.equal(result.cases.length, 272);
	assert.equal(new Set(result.cases.map((item) => item.input)).size, 272);
	assert.deepEqual(result.cases.filter((item) => item.group === "additional").map((item) => item.input), SCHOOL_PARITY_ADDITIONAL_INPUTS);
	assert.equal(result.counterexample, null);
	assert.equal(result.equivalenceForAllStrings, "NOT_ESTABLISHED");
	// Independent byte witness: the parity bit is the low bit after XOR folding.
	for (let byte = 0; byte < 256; byte++) {
		let folded = byte; folded ^= folded >> 4; folded ^= folded >> 2; folded ^= folded >> 1;
		const item = result.cases[byte]!;
		assert.equal(item.input, byte.toString(2).padStart(8, "0"));
		assert.equal(item.expected, folded & 1 ? "ODD" : "EVEN");
		assert.equal(item.actual, item.expected);
	}
});

test("one valid mutated edge fails behavior and retains the exact counterexample", () => {
	const candidate = JSON.parse(readFileSync(mutantFile, "utf8"));
	assert.doesNotThrow(() => parseSchoolParityMachine(candidate));
	const result = evaluateSchoolParityMachine(candidate);
	assert.equal(result.status, "FAILED");
	assert.deepEqual(result.bytes, { checked: 256, passed: 128, failed: 128 });
	assert.deepEqual(result.counterexample, { group: "byte", input: "00000001", expected: "ODD", actual: "EVEN", terminalState: "even", correct: false });
	assert.equal(result.cases.filter((item) => !item.correct && item.group === "byte").length, 128);
});

test("empty input uses the initial output and labels are checked independently of names", () => {
	const candidate = good();
	assert.deepEqual(executeSchoolParityMachine(candidate, ""), { output: "EVEN", terminalState: "even" });
	assert.equal(schoolParityOracle(""), "EVEN");
	assert.equal(schoolParityOracle("111"), "ODD");
	assert.equal(schoolParityOracle("1111"), "EVEN");
	candidate.states[0]!.output = "ODD";
	const result = evaluateSchoolParityMachine(candidate);
	assert.equal(result.cases.find((item) => item.input === "")?.correct, false);
	assert.equal(result.status, "FAILED");
});

test("unknown or missing schema fields refuse instead of acquiring execution meaning", () => {
	for (const candidate of [
		{ ...good(), code: "process.exit()" },
		{ ...good(), states: [{ ...good().states[0], authority: "teacher" }, good().states[1]] },
		{ ...good(), states: [{ ...good().states[0], transitions: { "0": "even", "1": "odd", "2": "even" } }, good().states[1]] },
		{ version: 1, kind: "parity-machine", alphabet: ["0", "1"], states: good().states },
	]) assert.throws(() => parseSchoolParityMachine(candidate), /unsupported field|missing a required field/);
});

test("states, initial state, labels and total transition targets must agree", () => {
	const mutations: ((machine: SchoolParityMachine) => void)[] = [
		(machine) => { machine.initial = "absent"; },
		(machine) => { machine.states[1]!.id = "even"; },
		(machine) => { machine.states[0]!.transitions["1"] = "absent"; },
		(machine) => { delete (machine.states[0]!.transitions as Partial<Record<string, string>>)["1"]; },
		(machine) => { (machine.states[0] as unknown as Record<string, unknown>).output = "MAYBE"; },
	];
	for (const mutate of mutations) { const candidate = good(); mutate(candidate); assert.throws(() => parseSchoolParityMachine(candidate)); }
	for (const alphabet of [["1", "0"], [0, 1], ["0"], ["0", "1", "2"]]) assert.throws(() => parseSchoolParityMachine({ ...good(), alphabet }), /Alphabet/);
	assert.throws(() => parseSchoolParityMachine({ ...good(), version: 2 }), /Unsupported/);
});

test("artifact, state, identifier and input limits are enforced", () => {
	assert.throws(() => parseSchoolParityMachine({ ...good(), states: [] }), /1–64/);
	assert.throws(() => parseSchoolParityMachine({ ...good(), states: Array.from({ length: 65 }, (_, index) => ({ id: `s${index}`, output: "EVEN", transitions: { "0": "s0", "1": "s0" } })) }), /1–64/);
	const oversized = good(); oversized.initial = "s".repeat(MAX_SCHOOL_PARITY_BYTES);
	assert.throws(() => parseSchoolParityMachine(oversized), /64 KiB/);
	for (const id of ["", "9bad", "state name", "x".repeat(65)]) assert.throws(() => parseSchoolParityMachine({ ...good(), initial: id }), /state ID/);
	for (const input of ["2", "10 01", "0".repeat(4097), null, 101]) {
		assert.throws(() => executeSchoolParityMachine(good(), input), /4096 binary/);
		assert.throws(() => schoolParityOracle(input), /4096 binary/);
	}
	assert.equal(executeSchoolParityMachine(good(), "1".repeat(4096)).output, "EVEN");
});

test("parser copies and freezes the admitted definition", () => {
	const source = good(), admitted = parseSchoolParityMachine(source), before = JSON.stringify(source);
	assert.notEqual(admitted, source);
	assert.ok(Object.isFrozen(admitted) && Object.isFrozen(admitted.states[0]!.transitions));
	assert.throws(() => { admitted.states[0]!.transitions["1"] = "even"; }, TypeError);
	evaluateSchoolParityMachine(source);
	assert.equal(JSON.stringify(source), before);
	source.states[0]!.transitions["1"] = "even";
	assert.equal(evaluateSchoolParityMachine(admitted).status, "PASSED");
});

test("state IDs are ordinary names, including names inherited by JavaScript objects", () => {
	const candidate = good();
	for (const state of candidate.states) {
		state.id = state.id === "even" ? "constructor" : "toString";
		for (const bit of ["0", "1"] as const) state.transitions[bit] = state.transitions[bit] === "even" ? "constructor" : "toString";
	}
	candidate.initial = "constructor";
	assert.equal(evaluateSchoolParityMachine(candidate).status, "PASSED");
});

test("CLI retains the artifact, every case, hashes and success without model claims", () => {
	const output = path.join(scratch, "good-report.json"), result = cli("check", goodFile, "--output", output);
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(readFileSync(output, "utf8"));
	assert.equal(report.status, "PASSED");
	assert.deepEqual(report.validation, { encoding: "VALID", json: "VALID", structure: "VALID" });
	assert.equal(report.coverage, "SUFFICIENT");
	assert.equal(report.evaluation.cases.length, 272);
	assert.deepEqual(report.machine, good());
	assert.equal(report.artifact.sha256, createHash("sha256").update(readFileSync(goodFile)).digest("hex"));
	assert.equal(report.artifact.normalizedSha256, createHash("sha256").update(JSON.stringify(parseSchoolParityMachine(good()))).digest("hex"));
	assert.equal(report.modelGeneration, "NOT_ESTABLISHED");
});

test("CLI writes a structurally valid failed report and exits nonzero", () => {
	const result = cli("check", mutantFile);
	assert.equal(result.status, 1, result.stderr);
	const report = JSON.parse(result.stdout);
	assert.equal(report.validation.structure, "VALID");
	assert.equal(report.status, "FAILED");
	assert.equal(report.coverage, "SUFFICIENT");
	assert.equal(report.evaluation.counterexample.input, "00000001");
});

test("CLI keeps malformed JSON and invalid structure separate from zero scores", () => {
	const invalidJson = path.join(scratch, "invalid-json.json"), invalidStructure = path.join(scratch, "invalid-structure.json");
	writeFileSync(invalidJson, "```json\n{}\n```"); writeFileSync(invalidStructure, "{}");
	for (const [filename, field] of [[invalidJson, "json"], [invalidStructure, "structure"]]) {
		const result = cli("check", filename!);
		assert.equal(result.status, 1, result.stderr);
		const report = JSON.parse(result.stdout);
		assert.equal(report.status, "INVALID");
		assert.equal(report.validation[field!], "INVALID");
		assert.equal(report.coverage, "ABSENT");
		assert.equal(report.evaluation, null);
	}
});

test("CLI bounds the file read and rejects invalid UTF-8 without a false full digest", () => {
	const oversized = path.join(scratch, "oversized.json"), invalidUtf8 = path.join(scratch, "utf8.json");
	writeFileSync(oversized, Buffer.alloc(MAX_SCHOOL_PARITY_BYTES * 2, 0x20)); writeFileSync(invalidUtf8, Buffer.from([0xff, 0xfe, 0x7b, 0x7d]));
	const tooBig = cli("check", oversized), badText = cli("check", invalidUtf8);
	assert.equal(tooBig.status, 1); assert.equal(badText.status, 1);
	const sizeReport = JSON.parse(tooBig.stdout), utf8Report = JSON.parse(badText.stdout);
	assert.equal(sizeReport.error.code, "ARTIFACT_TOO_LARGE");
	assert.deepEqual(sizeReport.artifact, { bytes: MAX_SCHOOL_PARITY_BYTES + 1, sha256: null, normalizedSha256: null, bytesComplete: false });
	assert.equal(utf8Report.validation.encoding, "INVALID");
	assert.equal(utf8Report.validation.json, "NOT_CHECKED");
	assert.equal(utf8Report.evaluation, null);
});

test("CLI refuses to overwrite evidence and refuses ambiguous arguments", () => {
	const output = path.join(scratch, "occupied.json"); writeFileSync(output, "owner evidence\n");
	const occupied = cli("check", goodFile, "--output", output);
	assert.equal(occupied.status, 1); assert.equal(readFileSync(output, "utf8"), "owner evidence\n");
	assert.equal(cli("check", goodFile, "--output", output, "--output", "other.json").status, 1);
	assert.equal(cli("check", goodFile, "--run").status, 1);
});

test("CLI rejects a named pipe without waiting for a writer", { skip: process.platform === "win32" }, () => {
	const fifo = path.join(scratch, "unopened-pipe");
	const made = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 2000 });
	assert.equal(made.status, 0, made.stderr);
	const result = cli("check", fifo);
	assert.equal(result.signal, null, "special-file admission must not reach the process timeout");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /regular file/);
});
