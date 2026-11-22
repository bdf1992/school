import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evaluateImageStudy, imageStudyLearnerView, IMAGE_STUDY_EVALUATOR, MAX_IMAGE_STUDY_ANSWERS_BYTES, MAX_IMAGE_STUDY_PACKET_BYTES } from "../src/core/school-image-study.ts";

const HELP = `Usage:
  npm run school:image-study -- view <packet.json> [--output <new-view.json>]
  npm run school:image-study -- check <packet.json> <answers.json> [--output <new-report.json>]
Validate AUM image-study packet payloads and derive a learner view or independently
grade saved answers. No model, network, image decoder or AUM Python code executes.
Output paths must be new. Invalid input and failed answers exit nonzero.`;

function readJson(filename: string, limit: number): { value: unknown; sha256: string } {
	const fd = openSync(filename, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		if (!fstatSync(fd).isFile()) throw new Error("Input must be a regular file");
		const buffer = Buffer.alloc(limit + 1);
		let size = 0;
		while (size < buffer.length) { const count = readSync(fd, buffer, size, buffer.length - size, null); if (!count) break; size += count; }
		if (size > limit) throw new Error(`Input exceeds its ${limit}-byte bound`);
		const bytes = buffer.subarray(0, size), text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return { value: JSON.parse(text), sha256: createHash("sha256").update(bytes).digest("hex") };
	} finally { closeSync(fd); }
}

function implementationHash(): string {
	const hash = createHash("sha256");
	for (const relative of ["../src/core/school-image-study.ts", "school-image-study.ts"]) {
		hash.update(relative).update("\0").update(readFileSync(new URL(relative, import.meta.url))).update("\0");
	}
	return hash.digest("hex");
}

function main(): void {
	const args = process.argv.slice(2);
	if (!args.length || (args.length === 1 && args[0] === "--help")) { console.log(HELP); return; }
	const mode = args.shift(), filename = args.shift();
	if ((mode !== "view" && mode !== "check") || !filename || filename.startsWith("--")) throw new Error(HELP);
	const answerFile = mode === "check" ? args.shift() : undefined;
	if (mode === "check" && (!answerFile || answerFile.startsWith("--"))) throw new Error(HELP);
	let output: string | undefined;
	if (args.length) {
		if (args.length !== 2 || args[0] !== "--output" || !args[1] || args[1].startsWith("--")) throw new Error(HELP);
		output = path.resolve(args[1]);
	}
	let report: Record<string, unknown>;
	try {
		const packet = readJson(path.resolve(filename), MAX_IMAGE_STUDY_PACKET_BYTES);
		if (mode === "view") report = imageStudyLearnerView(packet.value);
		else {
			const answers = readJson(path.resolve(answerFile!), MAX_IMAGE_STUDY_ANSWERS_BYTES);
			report = { ...evaluateImageStudy(packet.value, answers.value), packet_file_sha256: packet.sha256,
				answers_file_sha256: answers.sha256, evaluator_source_sha256: implementationHash() };
		}
	} catch (error) {
		report = { schema: "school.image-study-error/1", evaluator: IMAGE_STUDY_EVALUATOR,
			status: "INVALID", coverage: "ABSENT", model_calls: 0,
			error: error instanceof Error ? error.message : String(error) };
		process.exitCode = 1;
	}
	if (report.status === "FAILED") process.exitCode = 1;
	if (output) {
		writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		console.log(JSON.stringify({ schema: report.schema, status: report.status ?? "VIEW_PREPARED", counts: report.counts ?? null, output }));
	} else console.log(JSON.stringify(report, null, 2));
}

try { main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
