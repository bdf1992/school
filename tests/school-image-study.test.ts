import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { evaluateImageStudy, imageStudyLearnerView } from "../src/core/school-image-study.ts";

const checkout = path.resolve(import.meta.dirname, "..");
const packetFile = path.join(checkout, "examples/school/image-study-packet.json");
const answersFile = path.join(checkout, "examples/school/image-study-answers.json");
const packet = () => JSON.parse(readFileSync(packetFile, "utf8"));
const answers = () => JSON.parse(readFileSync(answersFile, "utf8"));
const scratch = mkdtempSync(path.join(tmpdir(), "school-image-study-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const cli = (...args: string[]) => spawnSync(process.execPath, ["scripts/school-image-study.ts", ...args], { cwd: checkout, encoding: "utf8", timeout: 10000 });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("independent byte, mask, box, point and conversion calculations match the authored controls", () => {
	const grade = evaluateImageStudy(packet(), answers());
	assert.equal(grade.status, "PASSED");
	assert.deepEqual(grade.counts, { checked: 10, passed: 10, failed: 0 });
	assert.deepEqual(grade.cases.find((row) => row.task_id === "last-bit")!.expected,
		{ byte_offset: 17, byte_value: 15, bit_value: 1, word64_index: 2, byte_in_word: 1 });
	assert.deepEqual(grade.cases.find((row) => row.task_id === "changed")!.expected,
		{ exact: false, changed_channels: 2, max_abs_error: 255, sum_abs_error: 256 });
	assert.equal(grade.model_calls, 0);
	assert.equal(grade.learning, "NOT_ESTABLISHED");
	assert.equal(grade.annotation_truth, "NOT_CHECKED");
});

test("a valid wrong bit fails exactly that case and retains the counterexample", () => {
	const candidate = answers(); candidate.answers[0].value.bit_value = 0;
	const grade = evaluateImageStudy(packet(), candidate);
	assert.equal(grade.status, "FAILED");
	assert.deepEqual(grade.counts, { checked: 10, passed: 9, failed: 1 });
	assert.equal(grade.cases[0]!.actual.bit_value, 0);
	assert.equal(grade.cases[0]!.expected.bit_value, 1);
});

test("bounding rectangles do not become masks or semantic object truth", () => {
	const grade = evaluateImageStudy(packet(), answers());
	assert.deepEqual(grade.cases.find((row) => row.task_id === "box-boundary")!.expected,
		{ selected: false, meaning: "inside_box" });
	assert.deepEqual(grade.cases.find((row) => row.task_id === "mask-yes")!.expected,
		{ selected: true, meaning: "inside_mask" });
	const candidate = answers(); candidate.answers[2].value.meaning = "inside_mask";
	assert.equal(evaluateImageStudy(packet(), candidate).status, "FAILED");
});

test("corrupt, truncated or noncanonical material is rejected before assessment", () => {
	const corrupt = packet(); corrupt.raster.sha256 = "0".repeat(64);
	assert.throws(() => evaluateImageStudy(corrupt, answers()), /SHA-256/);
	const truncated = packet(); truncated.raster.data_base64 = truncated.raster.data_base64.slice(4);
	assert.throws(() => imageStudyLearnerView(truncated), /base64/);
	const invalid = packet(); invalid.raster.data_base64 = "!".repeat(invalid.raster.data_base64.length);
	assert.throws(() => imageStudyLearnerView(invalid), /base64/);
	const wrongMask = packet(), bytes = Buffer.from([0, 0, 2, 0, 1, 0]);
	wrongMask.regions[1].data_base64 = bytes.toString("base64"); wrongMask.regions[1].sha256 = hash(bytes);
	assert.throws(() => imageStudyLearnerView(wrongMask), /Mask bytes/);
});

test("missing, duplicate and unexpected answers cannot receive partial passing grades", () => {
	const missing = answers(); missing.answers.pop();
	assert.throws(() => evaluateImageStudy(packet(), missing), /Missing answers/);
	const duplicate = answers(); duplicate.answers.push(duplicate.answers[0]);
	assert.throws(() => evaluateImageStudy(packet(), duplicate), /unique/);
	const unexpected = answers(); unexpected.answers.push({ task_id: "other", value: {} });
	assert.throws(() => evaluateImageStudy(packet(), unexpected), /unknown task/);
	const different = answers(); different.specimen_id = "other";
	assert.throws(() => evaluateImageStudy(packet(), different), /identity/);
});

test("safe integers, booleans, schema fields and references have strict meaning", () => {
	for (const mutate of [
		(p: ReturnType<typeof packet>) => { p.tasks[0].x = -1; },
		(p: ReturnType<typeof packet>) => { p.tasks[0].bit = 8; },
		(p: ReturnType<typeof packet>) => { p.tasks[0].channel = true; },
		(p: ReturnType<typeof packet>) => { p.tasks[0].x = 0.5; },
		(p: ReturnType<typeof packet>) => { p.tasks[0].x = Number.MAX_SAFE_INTEGER + 1; },
		(p: ReturnType<typeof packet>) => { p.tasks[2].region_id = "missing"; },
		(p: ReturnType<typeof packet>) => { p.tasks[9].conversion_id = "missing"; },
		(p: ReturnType<typeof packet>) => { p.tasks.push(p.tasks[0]); },
		(p: ReturnType<typeof packet>) => { p.regions.push(p.regions[0]); },
		(p: ReturnType<typeof packet>) => { p.expected = "secret"; },
		(p: ReturnType<typeof packet>) => { p.raster.layout = "BGR8-row-major"; },
		(p: ReturnType<typeof packet>) => { p.conversions[0].raster.width = 2; p.conversions[0].raster.height = 3; },
	]) { const value = packet(); mutate(value); assert.throws(() => evaluateImageStudy(value, answers())); }
	const bool = answers(); bool.answers[2].value.selected = 1;
	assert.throws(() => evaluateImageStudy(packet(), bool), /boolean/);
	const scalar = answers(); scalar.answers[0].value.bit_value = true;
	assert.throws(() => evaluateImageStudy(packet(), scalar), /integer/);
	const injection = answers(); injection.answers[0].value.run = "code";
	assert.throws(() => evaluateImageStudy(packet(), injection), /unsupported/);
});

test("learner projection includes explicit supplied data but no answer or grade receipts", () => {
	const raw = packet(), view = imageStudyLearnerView(raw);
	assert.equal(view.schema, "school.image-study-view/1");
	assert.equal(view.bit_numbering, "LSB0");
	assert.equal(view.exposure, "SUPPLIED_RASTERS_REGIONS_AND_TASKS");
	assert.deepEqual(Object.keys(view).sort(), ["answer_schema", "bit_numbering", "conversions", "exposure", "raster", "regions", "schema", "specimen_id", "tasks"]);
	assert.deepEqual(view.tasks, raw.tasks);
	raw.tasks[0].x = 100;
	assert.equal(view.tasks[0]!.kind, "pixel-bit");
	assert.equal((view.tasks[0] as { x: number }).x, 0);
	assert.equal(JSON.stringify(view).includes('"expected"'), false);
});

test("CLI saves exact input hashes, independent evaluator identity and a replayable grade", () => {
	const output = path.join(scratch, "grade.json"), result = cli("check", packetFile, answersFile, "--output", output);
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(readFileSync(output, "utf8"));
	assert.equal(report.status, "PASSED");
	assert.equal(report.packet_file_sha256, hash(readFileSync(packetFile)));
	assert.equal(report.answers_file_sha256, hash(readFileSync(answersFile)));
	assert.match(report.evaluator_source_sha256, /^[0-9a-f]{64}$/);
	const replay = cli("check", packetFile, answersFile);
	assert.equal(replay.status, 0, replay.stderr);
	assert.deepEqual(JSON.parse(replay.stdout), report);
	const view = cli("view", packetFile);
	assert.equal(view.status, 0, view.stderr);
	assert.equal(JSON.parse(view.stdout).schema, "school.image-study-view/1");
});

test("CLI records wrong answers separately from invalid material and refuses overwritten evidence", () => {
	const wrong = answers(), wrongFile = path.join(scratch, "wrong.json"); wrong.answers[0].value.bit_value = 0;
	writeFileSync(wrongFile, JSON.stringify(wrong));
	const failure = cli("check", packetFile, wrongFile);
	assert.equal(failure.status, 1); assert.equal(JSON.parse(failure.stdout).status, "FAILED");
	const malformed = path.join(scratch, "malformed.json"); writeFileSync(malformed, Buffer.from([255]));
	const invalid = cli("check", malformed, answersFile);
	assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).status, "INVALID");
	assert.equal(JSON.parse(invalid.stdout).coverage, "ABSENT");
	const output = path.join(scratch, "occupied.json"); writeFileSync(output, "existing evidence\n");
	assert.equal(cli("view", packetFile, "--output", output).status, 1);
	assert.equal(readFileSync(output, "utf8"), "existing evidence\n");
});
