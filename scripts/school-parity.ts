import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evaluateSchoolParityMachine, MAX_SCHOOL_PARITY_BYTES, parseSchoolParityMachine, SCHOOL_PARITY_ADDITIONAL_INPUTS, SCHOOL_PARITY_EVALUATOR, type SchoolParityEvaluation, type SchoolParityMachine } from "../src/core/school-parity.ts";

const HELP = `Usage: npm run school:parity -- check <artifact.json> [--output <new-report.json>]
Check a version-1 data-only parity machine on all 256 eight-bit inputs and
the evaluator's 16 declared additional strings. No model or network calls occur.
With --output, save a new owner-only report and print its summary; never overwrite.
Without --output, print the full report. Invalid artifacts and behavioral failures
exit 1. A passing report does not establish equivalence for every possible string.`;

type Validation = "VALID" | "INVALID" | "NOT_CHECKED";
interface Report {
	version: 1;
	kind: "school-parity-evaluation";
	evaluator: typeof SCHOOL_PARITY_EVALUATOR;
	additionalInputs: readonly string[];
	artifact: { bytes: number; sha256: string | null; normalizedSha256: string | null; bytesComplete: boolean };
	validation: { encoding: Validation; json: Validation; structure: Validation };
	status: "PASSED" | "FAILED" | "INVALID";
	coverage: "SUFFICIENT" | "ABSENT";
	machine: SchoolParityMachine | null;
	evaluation: SchoolParityEvaluation | null;
	error?: { code: string; message: string };
	modelGeneration: "NOT_ESTABLISHED";
}
const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function readBounded(filename: string): Uint8Array {
	// A FIFO must not block at open before the regular-file check can reject it.
	const fd = openSync(filename, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		if (!fstatSync(fd).isFile()) throw new Error("Artifact input must be a regular file");
		const buffer = Buffer.alloc(MAX_SCHOOL_PARITY_BYTES + 1);
		let size = 0;
		while (size < buffer.length) { const count = readSync(fd, buffer, size, buffer.length - size, null); if (!count) break; size += count; }
		return buffer.subarray(0, size);
	} finally { closeSync(fd); }
}

function inspect(bytes: Uint8Array): Report {
	const complete = bytes.byteLength <= MAX_SCHOOL_PARITY_BYTES;
	const report: Report = {
		version: 1, kind: "school-parity-evaluation", evaluator: SCHOOL_PARITY_EVALUATOR, additionalInputs: SCHOOL_PARITY_ADDITIONAL_INPUTS,
		artifact: { bytes: bytes.byteLength, sha256: complete ? digest(bytes) : null, normalizedSha256: null, bytesComplete: complete },
		validation: { encoding: "NOT_CHECKED", json: "NOT_CHECKED", structure: "NOT_CHECKED" },
		status: "INVALID", coverage: "ABSENT", machine: null, evaluation: null, modelGeneration: "NOT_ESTABLISHED",
	};
	if (!complete) { report.error = { code: "ARTIFACT_TOO_LARGE", message: "Artifact exceeds 64 KiB; only a bounded prefix was read and no full-file digest is claimed" }; return report; }
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); report.validation.encoding = "VALID"; }
	catch { report.validation.encoding = "INVALID"; report.error = { code: "INVALID_UTF8", message: "Artifact must be UTF-8" }; return report; }
	let value: unknown;
	try { value = JSON.parse(text); report.validation.json = "VALID"; }
	catch { report.validation.json = "INVALID"; report.error = { code: "INVALID_JSON", message: "Artifact must be one JSON value, without Markdown fences or trailing text" }; return report; }
	try {
		report.machine = parseSchoolParityMachine(value); report.validation.structure = "VALID";
		report.artifact.normalizedSha256 = digest(JSON.stringify(report.machine));
		report.evaluation = evaluateSchoolParityMachine(report.machine);
		report.coverage = "SUFFICIENT"; report.status = report.evaluation.status;
	} catch (error) {
		report.validation.structure = "INVALID";
		report.error = { code: "INVALID_PARITY_ARTIFACT", message: error instanceof Error ? error.message : String(error) };
	}
	return report;
}

function main(): void {
	const args = process.argv.slice(2);
	if (!args.length || (args.length === 1 && args[0] === "--help")) { console.log(HELP); return; }
	if (args.shift() !== "check") throw new Error(HELP);
	const filename = args.shift();
	if (!filename || filename.startsWith("--")) throw new Error("check requires one artifact filename");
	let output: string | undefined;
	if (args.length) {
		if (args.length !== 2 || args[0] !== "--output" || !args[1] || args[1].startsWith("--")) throw new Error("Only one --output <new-report.json> option is supported");
		output = path.resolve(args[1]);
	}
	const report = inspect(readBounded(path.resolve(filename)));
	if (output) {
		writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		console.log(JSON.stringify({ status: report.status, coverage: report.coverage, artifact: report.artifact, validation: report.validation, bytes: report.evaluation?.bytes ?? null, additional: report.evaluation?.additional ?? null, counterexample: report.evaluation?.counterexample ?? null, error: report.error ?? null, output }, null, 2));
	} else console.log(JSON.stringify(report, null, 2));
	if (report.status !== "PASSED") process.exitCode = 1;
}

try { main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
