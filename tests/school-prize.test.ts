import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { deflateSync } from "node:zlib";
import { comparePrizeBundles, declaredScore, gradePrizeBundle, onePercentCutoff, parsePrizeAttempt, parsePrizeAttemptJson, prizeChildTimeout, PRIZE_PROFILE, SMOKE_LIMIT, type PrizeAttempt } from "../src/core/school-prize.ts";

const repository = path.resolve(import.meta.dirname, "..");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function scratch(t: TestContext): string {
	const directory = mkdtempSync(path.join(tmpdir(), "school-prize-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function bundle(t: TestContext, source = Buffer.from("Six sevens: 777777\n\x00\xff", "latin1")) {
	const directory = scratch(t);
	const materials: Record<string, Uint8Array> = {
		"original.bin": source,
		"restored.bin": source,
		"compressor.bin": Buffer.alloc(11, 0xa1),
		"decompressor.bin": Buffer.alloc(7, 0xb2),
		"archive.bin": Buffer.alloc(13, 0xc3),
		"compress.options": Buffer.from("c=1\n"),
		"decompress.options": Buffer.from("d=2\n"),
	};
	for (const [file, bytes] of Object.entries(materials)) writeFileSync(path.join(directory, file), bytes);
	const attempt: PrizeAttempt = {
		format: "school.prize-attempt/1", profile: PRIZE_PROFILE, attempt_id: "test-attempt", track: "smoke",
		score_form: "separate", program_format: "unqualified-source",
		expected_corpus: { bytes: String(source.length), sha256: sha256(source) },
		files: { original: "original.bin", restored: "restored.bin", compressor: "compressor.bin", decompressor: "decompressor.bin", archive: "archive.bin", options: [
			{ phase: "compress", path: "compress.options" }, { phase: "decompress", path: "decompress.options" },
		] },
	};
	return { directory, attempt, source };
}

test("artifact grading observes exact retained bytes without crediting execution, independence or funds", (t) => {
	const input = bundle(t), grade = gradePrizeBundle(input.directory, input.attempt);
	assert.equal(grade.verdict, "EXACT_BYTES_OBSERVED");
	assert.equal(grade.corpus.matches_pin, true);
	assert.equal(grade.corpus.canonical_enwik9, false);
	assert.equal(grade.recovery.exact_bytes, true);
	assert.deepEqual(grade.errors, []);
	assert.equal(grade.accounting.total_declared_bytes, "46"); // 11 + 2*7 + 13 + 4 + 4.
	assert.equal(grade.accounting.coverage, "DECLARED_FILES_ONLY");
	assert.deepEqual(grade.proof, {
		decoder_execution: "NOT_OBSERVED", decoder_independence: "NOT_ESTABLISHED", complete_dependencies: "NOT_ESTABLISHED",
		executable_qualification: "NOT_ESTABLISHED", time_ram_disk: "NOT_MEASURED", license_and_source: "NOT_REVIEWED", generalization: "NOT_ESTABLISHED",
	});
	assert.deepEqual(grade.prize, { standing: "NOT_SUBMITTED", award_eur: null });
	assert.equal(grade.files.find(file => file.role === "original")?.sha256, sha256(input.source));
	assert.ok(grade.files.every(file => !Object.hasOwn(file, "identity")));
	// These are arbitrary non-executable program/archive bytes and a retained copy.
	// Passing their equality check must never imply the archive produced that copy.
});

test("same-length mutation, truncation and extension of restoration reject exact recovery", (t) => {
	for (const change of [
		(source: Buffer) => { const changed = Buffer.from(source); changed[3] = changed[3]! ^ 1; return changed; },
		(source: Buffer) => source.subarray(0, source.length - 1),
		(source: Buffer) => Buffer.concat([source, Buffer.from([0])]),
	]) {
		const input = bundle(t);
		writeFileSync(path.join(input.directory, "restored.bin"), change(input.source));
		const grade = gradePrizeBundle(input.directory, input.attempt);
		assert.equal(grade.verdict, "REJECTED");
		assert.equal(grade.corpus.matches_pin, true);
		assert.equal(grade.recovery.exact_bytes, false);
		assert.deepEqual(grade.errors, ["restored bytes differ from original"]);
	}
});

test("matching retained copies do not excuse a wrong fixed source hash or length", (t) => {
	for (const pin of [{ sha256: "0".repeat(64) }, { bytes: "1" }]) {
		const input = bundle(t);
		Object.assign(input.attempt.expected_corpus, pin);
		const grade = gradePrizeBundle(input.directory, input.attempt);
		assert.equal(grade.verdict, "REJECTED");
		assert.equal(grade.recovery.exact_bytes, true);
		assert.equal(grade.corpus.matches_pin, false);
		assert.deepEqual(grade.errors, ["source does not match pinned expected corpus"]);
	}
});

test("a labeled full-corpus attempt cannot turn a small exact fixture into enwik9", (t) => {
	const input = bundle(t); input.attempt.track = "full-corpus";
	const grade = gradePrizeBundle(input.directory, input.attempt);
	assert.equal(grade.recovery.exact_bytes, true);
	assert.equal(grade.corpus.matches_pin, true);
	assert.equal(grade.corpus.canonical_enwik9, false);
	assert.equal(grade.verdict, "REJECTED");
	assert.match(grade.errors.join(" "), /published enwik9 identity/);
});

test("all three accounting forms charge actual programs, archive and every option phase", (t) => {
	const separate = bundle(t);
	writeFileSync(path.join(separate.directory, "compile-c.options"), "abc");
	writeFileSync(path.join(separate.directory, "compile-d.options"), "defgh");
	separate.attempt.files.options.push({ phase: "compile-compressor", path: "compile-c.options" }, { phase: "compile-decompressor", path: "compile-d.options" });
	assert.equal(gradePrizeBundle(separate.directory, separate.attempt).accounting.total_declared_bytes, "54");
	const extracting = bundle(t); extracting.attempt.score_form = "self-extracting"; delete extracting.attempt.files.decompressor;
	assert.equal(gradePrizeBundle(extracting.directory, extracting.attempt).accounting.total_declared_bytes, "32");
	const shared = bundle(t); shared.attempt.score_form = "shared-program";
	writeFileSync(path.join(shared.directory, "decompressor.bin"), readFileSync(path.join(shared.directory, "compressor.bin")));
	assert.equal(gradePrizeBundle(shared.directory, shared.attempt).accounting.total_declared_bytes, "43");
	shared.attempt.files.decompressor = shared.attempt.files.compressor;
	assert.equal(gradePrizeBundle(shared.directory, shared.attempt).accounting.total_declared_bytes, "43", "a shared program is charged twice even if named once");
});

test("a fake shared program fails even when both program lengths are equal", (t) => {
	const input = bundle(t); input.attempt.score_form = "shared-program";
	writeFileSync(path.join(input.directory, "decompressor.bin"), Buffer.alloc(11, 0x7f));
	assert.throws(() => gradePrizeBundle(input.directory, input.attempt), /identical compressor and decompressor/);
});

test("percentage cutoff and accounting retain integer precision above 53 bits", () => {
	assert.equal(onePercentCutoff(100_424_672n), 99_420_425n);
	assert.equal(onePercentCutoff(93_388_956n), 92_455_066n);
	assert.equal(onePercentCutoff(9_007_199_254_740_993n), 8_917_127_262_193_583n);
	assert.equal(onePercentCutoff(18_446_744_073_709_551_615n), 18_262_276_632_972_456_098n);
	assert.equal(onePercentCutoff(101n), 99n);
	assert.throws(() => onePercentCutoff(0n), /positive/);
	assert.throws(() => onePercentCutoff(-1n), /positive/);
	assert.equal(declaredScore("separate", 9_007_199_254_740_993n, 5n, 17n, 3n), 9_007_199_254_741_023n);
	for (const [compressor, decoder, archive, options] of [[-1n, 0n, 0n, 0n], [0n, -1n, 0n, 0n], [0n, 0n, -1n, 0n], [0n, 0n, 0n, -1n]] as const) {
		assert.throws(() => declaredScore("self-extracting", compressor, decoder, archive, options), /negative/);
	}
});

test("each child timeout is bounded by the remaining cumulative allowance", () => {
	assert.equal(prizeChildTimeout(30_000, 0), 5_000);
	assert.equal(prizeChildTimeout(30_000, 29_250.25), 749, "fractional remaining time rounds down");
	assert.equal(prizeChildTimeout(30_000, 29_999), 1);
	assert.equal(prizeChildTimeout(30_000, 20_000, 300), 300);
	assert.equal(prizeChildTimeout(30_000, 29_950, 300), 50);
	for (const now of [29_999.01, 30_000, 30_001]) assert.throws(() => prizeChildTimeout(30_000, now), /budget exhausted/);
	for (const invalid of [NaN, Infinity, -Infinity]) {
		assert.throws(() => prizeChildTimeout(invalid, 0), /invalid smoke deadline/);
		assert.throws(() => prizeChildTimeout(30_000, invalid), /invalid smoke deadline/);
	}
	for (const maximum of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => prizeChildTimeout(30_000, 0, maximum), /invalid smoke deadline/);
	}
});

test("strict manifests reject unsupported claims at every material level", (t) => {
	const input = bundle(t);
	for (const field of ["PASS", "verdict", "award_eur", "decoder_execution", "command", "score_bytes"]) {
		assert.throws(() => parsePrizeAttempt({ ...input.attempt, [field]: "PASS" }), /unsupported field/);
	}
	assert.throws(() => parsePrizeAttempt({ ...input.attempt, expected_corpus: { ...input.attempt.expected_corpus, trusted: true } }), /unsupported field/);
	assert.throws(() => parsePrizeAttempt({ ...input.attempt, files: { ...input.attempt.files, command: "run-me" } }), /unsupported field/);
	const extraOption = structuredClone(input.attempt);
	Object.assign(extraOption.files.options[0]!, { verified: true });
	assert.throws(() => parsePrizeAttempt(extraOption), /unsupported field/);
	assert.throws(() => parsePrizeAttempt(gradePrizeBundle(input.directory, input.attempt)), /unsupported field/);
	assert.throws(() => parsePrizeAttempt(null), /object required/);
	assert.throws(() => parsePrizeAttempt([]), /object required/);
});

test("JSON manifests reject ordinary and escaped duplicate keys including nested options", (t) => {
	const input = bundle(t), text = JSON.stringify(input.attempt);
	assert.deepEqual(parsePrizeAttemptJson(`${text}\n`), input.attempt, "JSON whitespace is valid outside values");
	for (const extra of ['"track":"smoke",', '"\\u0074rack":"smoke",']) {
		assert.throws(() => parsePrizeAttemptJson(`{${extra}${text.slice(1)}`), /duplicate JSON key: track/);
	}
	const nested = text.replace('"path":"compress.options"', '"path":"compress.options","pa\\u0074h":"compress.options"');
	assert.throws(() => parsePrizeAttemptJson(nested), /duplicate JSON key: path/);
	assert.throws(() => parsePrizeAttemptJson(`${text}\n{}`), SyntaxError);
	assert.throws(() => parsePrizeAttemptJson(" ".repeat(65_537)), /64 KiB/);
	assert.throws(() => parsePrizeAttemptJson('{"nested":' + "[".repeat(18) + "0" + "]".repeat(18) + "}"), /nesting limit/);
});

test("values cannot hide trailing newlines or noncanonical numeric text", (t) => {
	const input = bundle(t);
	assert.throws(() => parsePrizeAttempt({ ...input.attempt, attempt_id: "valid\n" }), /attempt_id/);
	for (const bytes of ["01", "1.0", "1e2", "-1", "1\n", "1000000001", 20]) {
		assert.throws(() => parsePrizeAttempt({ ...input.attempt, expected_corpus: { ...input.attempt.expected_corpus, bytes } }), /byte count/);
	}
	assert.throws(() => parsePrizeAttempt({ ...input.attempt, expected_corpus: { ...input.attempt.expected_corpus, sha256: input.attempt.expected_corpus.sha256 + "\n" } }), /SHA-256/);
	assert.throws(() => parsePrizeAttempt({ ...input.attempt, files: { ...input.attempt.files, archive: "archive.bin\n" } }), /relative path/);
	const parsed = parsePrizeAttempt(input.attempt); parsed.files.archive = "changed.bin";
	assert.equal(input.attempt.files.archive, "archive.bin", "parser output must not alias mutable input material");
});

test("accounting shape rejects missing decoders, extra decoders and duplicate option phases", (t) => {
	const input = bundle(t), missing = structuredClone(input.attempt); delete missing.files.decompressor;
	assert.throws(() => parsePrizeAttempt(missing), /relative path/);
	assert.throws(() => parsePrizeAttempt({ ...input.attempt, score_form: "self-extracting" }), /unsupported field: decompressor/);
	const duplicate = structuredClone(input.attempt); duplicate.files.options.push({ phase: "compress", path: "compile.options" });
	assert.throws(() => parsePrizeAttempt(duplicate), /duplicate option phase/);
	const excessive = structuredClone(input.attempt); excessive.files.options = Array.from({ length: 5 }, () => ({ phase: "compress", path: "compress.options" }));
	assert.throws(() => parsePrizeAttempt(excessive), /at most four/);
});

test("absolute, traversing and ambiguous material paths are refused before inspection", (t) => {
	const input = bundle(t);
	for (const archive of ["../outside", "a/../archive.bin", "/tmp/archive.bin", "a//b", "./archive.bin", "a/./b", "a\\b", "archive.bin\0", "a/", " archive.bin"]) {
		assert.throws(() => parsePrizeAttempt({ ...input.attempt, files: { ...input.attempt.files, archive } }), /relative path/);
	}
});

test("file and directory symlinks cannot supply bundle material or alias the bundle root", (t) => {
	const input = bundle(t);
	unlinkSync(path.join(input.directory, "restored.bin")); symlinkSync("original.bin", path.join(input.directory, "restored.bin"));
	assert.throws(() => gradePrizeBundle(input.directory, input.attempt), /symlink/);
	const nested = bundle(t); mkdirSync(path.join(nested.directory, "actual"));
	writeFileSync(path.join(nested.directory, "actual", "archive.bin"), "archive");
	symlinkSync("actual", path.join(nested.directory, "alias")); nested.attempt.files.archive = "alias/archive.bin";
	assert.throws(() => gradePrizeBundle(nested.directory, nested.attempt), /symlink/);
	const aliasRoot = path.join(scratch(t), "alias"); symlinkSync(nested.directory, aliasRoot);
	assert.throws(() => gradePrizeBundle(aliasRoot, nested.attempt), /real directory without symlink/);
});

test("hardlinks and repeated paths cannot pass data-role or program/data independence", (t) => {
	for (const [target, source] of [["restored.bin", "original.bin"], ["archive.bin", "original.bin"], ["archive.bin", "restored.bin"], ["compressor.bin", "original.bin"], ["decompressor.bin", "archive.bin"]]) {
		const input = bundle(t);
		unlinkSync(path.join(input.directory, target!)); linkSync(path.join(input.directory, source!), path.join(input.directory, target!));
		assert.throws(() => gradePrizeBundle(input.directory, input.attempt), /distinct files/);
	}
	const input = bundle(t); input.attempt.files.restored = input.attempt.files.original;
	assert.throws(() => gradePrizeBundle(input.directory, input.attempt), /distinct files/);
});

test("missing, nonregular, empty-program and oversized files stop inspection", (t) => {
	const missing = bundle(t); unlinkSync(path.join(missing.directory, "archive.bin"));
	assert.throws(() => gradePrizeBundle(missing.directory, missing.attempt), /ENOENT/);
	const directory = bundle(t); unlinkSync(path.join(directory.directory, "archive.bin")); mkdirSync(path.join(directory.directory, "archive.bin"));
	assert.throws(() => gradePrizeBundle(directory.directory, directory.attempt), /regular file/);
	const empty = bundle(t); writeFileSync(path.join(empty.directory, "compressor.bin"), Buffer.alloc(0));
	assert.throws(() => gradePrizeBundle(empty.directory, empty.attempt), /cannot be empty/);
	const oversizedSource = bundle(t, Buffer.alloc(SMOKE_LIMIT + 1));
	assert.throws(() => gradePrizeBundle(oversizedSource.directory, oversizedSource.attempt), /original: file exceeds limit/);
	const oversizedOptions = bundle(t); writeFileSync(path.join(oversizedOptions.directory, "compress.options"), Buffer.alloc(65_537));
	assert.throws(() => gradePrizeBundle(oversizedOptions.directory, oversizedOptions.attempt), /options:compress: file exceeds limit/);
	const oversizedProgram = bundle(t); truncateSync(path.join(oversizedProgram.directory, "compressor.bin"), 1_000_000_001);
	assert.throws(() => gradePrizeBundle(oversizedProgram.directory, oversizedProgram.attempt), /compressor: file exceeds limit/, "the sparse file is rejected by size before reading its content");
	for (const limit of [-1, 1.5, Infinity, 1_000_000_001]) assert.throws(() => gradePrizeBundle(empty.directory, empty.attempt, limit), /invalid corpus inspection limit/);
});

test("an exact empty source is a valid smoke artifact and is never canonical enwik9", (t) => {
	const input = bundle(t, Buffer.alloc(0)), grade = gradePrizeBundle(input.directory, input.attempt, 0);
	assert.equal(grade.verdict, "EXACT_BYTES_OBSERVED");
	assert.equal(grade.corpus.bytes, "0");
	assert.equal(grade.corpus.canonical_enwik9, false);
});

test("comparison uses complete costs at the one-percent boundary and never awards funds", (t) => {
	const baseline = bundle(t), candidate = bundle(t);
	writeFileSync(path.join(baseline.directory, "archive.bin"), Buffer.alloc(67)); // Total 100.
	for (const [archiveBytes, expectedSaving, expectedThreshold] of [[66, "1", true], [67, "0", false], [68, "-1", false]] as const) {
		writeFileSync(path.join(candidate.directory, "archive.bin"), Buffer.alloc(archiveBytes));
		const result = comparePrizeBundles(baseline, candidate);
		assert.equal(result.saving_bytes, expectedSaving);
		assert.deepEqual(result.improvement_percent, { numerator: String(BigInt(expectedSaving) * 100n), denominator: "100" });
		assert.equal(result.at_least_one_percent_on_this_input, expectedThreshold);
		assert.equal(result.external_prize_improvement, "NOT_ESTABLISHED");
		assert.equal(result.award_eur, null);
		assert.equal(result.candidate.proof.decoder_execution, "NOT_OBSERVED");
	}
});

test("comparison refuses mismatched sources, tracks and program qualification forms", (t) => {
	const baseline = bundle(t), otherSource = bundle(t, Buffer.from("another source"));
	assert.throws(() => comparePrizeBundles(baseline, otherSource), /same corpus, track and program format/);
	const otherTrack = bundle(t); otherTrack.attempt.track = "proxy";
	assert.throws(() => comparePrizeBundles(baseline, otherTrack), /same corpus, track and program format/);
	const otherFormat = bundle(t); otherFormat.attempt.program_format = "executable";
	assert.throws(() => comparePrizeBundles(baseline, otherFormat), /same corpus, track and program format/);
});

test("comparison reinspects changed artifacts and never trusts a saved PASS report", (t) => {
	const baseline = bundle(t), candidate = bundle(t);
	const saved = gradePrizeBundle(candidate.directory, candidate.attempt);
	writeFileSync(path.join(candidate.directory, "restored.bin"), Buffer.from("changed"));
	assert.throws(() => comparePrizeBundles(baseline, candidate), /two exact, pinned artifacts/);
	assert.throws(() => comparePrizeBundles(baseline, { directory: candidate.directory, attempt: saved }), /unsupported field/);
	assert.equal(saved.verdict, "EXACT_BYTES_OBSERVED", "a historical report remains historical");
});

function worker(arguments_: string[]) {
	const result = spawnSync(process.execPath, [path.join(repository, "scripts/prize-codec-worker.mjs"), ...arguments_], {
		cwd: repository, encoding: "utf8", timeout: 2_000, maxBuffer: 65_536,
	});
	assert.equal(result.error, undefined, result.error?.message);
	return result;
}

test("the fixed worker round-trips empty and exact-limit binary inputs with both codecs", { timeout: 8_000 }, (t) => {
	const directory = scratch(t), limitInput = Buffer.alloc(SMOKE_LIMIT);
	for (let index = 0; index < limitInput.length; index++) limitInput[index] = index % 256;
	for (const [name, bytes] of [["empty", Buffer.alloc(0)], ["limit", limitInput]] as const) {
		const source = path.join(directory, `${name}.bin`); writeFileSync(source, bytes);
		for (const codec of ["raw", "deflate"]) {
			const archive = path.join(directory, `${name}.${codec}`), restored = archive + ".restored";
			const encoded = worker(["encode", codec, source, archive]);
			assert.equal(encoded.status, 0, encoded.stderr);
			const decoded = worker(["decode", codec, archive, restored]);
			assert.equal(decoded.status, 0, decoded.stderr);
			assert.deepEqual(readFileSync(restored), bytes);
		}
	}
});

test("the fixed worker refuses malformed, truncated and over-expanding deflate streams", { timeout: 5_000 }, (t) => {
	const directory = scratch(t);
	const encoded = deflateSync(Buffer.from("exact source content"));
	const cases = [Buffer.from("not a deflate stream"), encoded.subarray(0, encoded.length - 1), deflateSync(Buffer.alloc(SMOKE_LIMIT + 1))];
	for (const [index, bytes] of cases.entries()) {
		const input = path.join(directory, `${index}.deflate`), output = input + ".restored";
		writeFileSync(input, bytes);
		const result = worker(["decode", "deflate", input, output]);
		assert.equal(result.status, 1);
		assert.ok(result.stderr.trim().length > 0);
		assert.equal(existsSync(output), false, "a failed decode must not leave a partial output");
	}
});

test("the fixed worker enforces size, operation and write-once boundaries", { timeout: 6_000 }, (t) => {
	const directory = scratch(t), input = path.join(directory, "source"), output = path.join(directory, "output");
	writeFileSync(input, Buffer.alloc(SMOKE_LIMIT + 1));
	for (const operation of ["encode", "decode"]) {
		const result = worker([operation, "raw", input, output]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /smoke limit/);
		assert.equal(existsSync(output), false);
	}
	writeFileSync(input, "source"); writeFileSync(output, "retained output");
	const overwrite = worker(["encode", "raw", input, output]);
	assert.equal(overwrite.status, 1); assert.match(overwrite.stderr, /EEXIST/);
	assert.equal(readFileSync(output, "utf8"), "retained output");
	for (const args of [["execute", "raw", input, output], ["encode", "arbitrary-module", input, output], ["encode", "raw", input, output, "extra"]]) {
		const result = worker(args); assert.equal(result.status, 1); assert.match(result.stderr, /usage:/);
	}
});

test("the artifact CLI exits unsuccessfully for changed bytes and invalid flags", { timeout: 5_000 }, (t) => {
	const input = bundle(t);
	writeFileSync(path.join(input.directory, "attempt.json"), JSON.stringify(input.attempt));
	const invoke = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/school-prize.ts", ...args], { cwd: repository, encoding: "utf8", timeout: 2_000, maxBuffer: 65_536 });
	const exact = invoke(["grade", input.directory]);
	assert.equal(exact.status, 0, exact.stderr); assert.equal(JSON.parse(exact.stdout).verdict, "EXACT_BYTES_OBSERVED");
	writeFileSync(path.join(input.directory, "restored.bin"), "wrong bytes");
	const changed = invoke(["grade", input.directory]);
	assert.equal(changed.status, 1, changed.stderr); assert.equal(JSON.parse(changed.stdout).verdict, "REJECTED");
	const unsupported = invoke(["grade", input.directory, "--execute", "candidate.sh"]);
	assert.equal(unsupported.status, 2); assert.match(unsupported.stderr, /invalid or duplicate option/);
});

test("the artifact CLI refuses oversized, directory and symlink manifests before reading", { timeout: 5_000 }, (t) => {
	for (const kind of ["oversized", "directory", "symlink"]) {
		const input = bundle(t), manifest = path.join(input.directory, "attempt.json");
		if (kind === "oversized") {
			writeFileSync(manifest, JSON.stringify(input.attempt));
			truncateSync(manifest, 65_537); // Sparse extension; do not allocate a large manifest.
		} else if (kind === "directory") {
			mkdirSync(manifest);
		} else {
			writeFileSync(path.join(input.directory, "real-attempt.json"), JSON.stringify(input.attempt));
			symlinkSync("real-attempt.json", manifest);
		}
		const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/school-prize.ts", "grade", input.directory], {
			cwd: repository, encoding: "utf8", timeout: 2_000, maxBuffer: 65_536,
		});
		assert.equal(result.error, undefined, result.error?.message);
		assert.equal(result.status, 2, result.stderr);
		assert.match(result.stderr, /manifest must be a regular file of at most 64 KiB/);
		assert.equal(result.stdout, "", "no grade is produced for a refused manifest");
	}
});

test("the dated Hutter profile separates accepted and pending records from local qualification", () => {
	const profile = JSON.parse(readFileSync(path.join(repository, "examples/school/prizes/hutter-enwik9.json"), "utf8"));
	assert.equal(profile.format, "school.prize-profile/1");
	assert.equal(profile.id, PRIZE_PROFILE);
	assert.equal(profile.corpus.bytes, "1000000000");
	assert.equal(profile.corpus.downloaded_for_this_work, false);
	assert.equal(profile.standing.accepted_reference.status, "AWARDED_SOURCE_RECORD");
	assert.equal(profile.standing.pending_comparator.status, "PENDING_SOURCE_REPORT");
	assert.equal(profile.standing.must_refresh_before_full_run, true);
	assert.equal(profile.threshold.formula_cutoff_bytes_from_accepted, String(onePercentCutoff(BigInt(profile.standing.accepted_reference.total_bytes))));
	assert.equal(profile.threshold.conditional_cutoff_if_pending_becomes_reference, String(onePercentCutoff(BigInt(profile.standing.pending_comparator.total_bytes))));
	assert.equal(profile.threshold.local_grader_can_award, false);
	assert.equal(profile.local_lane.untrusted_entrant_execution, false);
	assert.equal(profile.local_lane.decoder_isolation, "NOT_ESTABLISHED");
	assert.equal(profile.local_lane.prize_qualification, "NOT_ESTABLISHED");
	assert.equal(profile.local_lane.funding_booked_eur, "0");
	assert.equal(profile.qualification.gpu_at_runtime, false);
	assert.equal(profile.qualification.external_files_and_network, false);
});

test("the FABLE research owner is a prepared explicit model with no paid or headless fallback", () => {
	const config = JSON.parse(readFileSync(path.join(repository, "examples/school/prizes/fable-research-owner.json"), "utf8"));
	assert.equal(config.requested_model, "claude-fable-5-2");
	assert.equal(config.requested_effort, "high");
	assert.equal(config.actual_model, null);
	assert.equal(config.launch_state, "PREPARED_NOT_LAUNCHED");
	assert.equal(config.school_participant_provider_changed, false);
	assert.equal(config.billing.route_verified, false);
	assert.equal(config.billing.additional_spend_cap, "0");
	assert.equal(config.billing.paid_fallback_allowed, false);
	assert.equal(config.billing.api_key_fallback_allowed, false);
	assert.equal(config.billing.headless_launch_allowed, false);
	assert.match(config.billing.preflight, /Absence of a prompt does not prove/);
	assert.match(config.launch_template, /--model claude-fable-5-2 --effort high --append-system-prompt-file/);
	assert.doesNotMatch(config.launch_template, /(?:^|\s)(?:-p|--print|--dangerously-skip-permissions)(?:\s|$)/);
	assert.equal(config.assignment, "docs/prompts/fable-prize-research.md");
	assert.ok(existsSync(path.join(repository, config.assignment)));
	assert.equal(config.budget_for_next_authorized_session.max_input_bytes_per_case, SMOKE_LIMIT);
	assert.equal(config.budget_for_next_authorized_session.gpu_training, false);
	assert.equal(config.budget_for_next_authorized_session.full_corpus_download, false);
	assert.equal(config.budget_for_next_authorized_session.prize_submission, false);
});

test("retained smoke evidence includes failures to compress and keeps its qualifications narrow", () => {
	// This is a check of the dated evidence record, not a replay or a timing test.
	const evidence = JSON.parse(readFileSync(path.join(repository, "evidence/prizes/hutter-smoke-2026-11-17.json"), "utf8"));
	assert.equal(evidence.format, "school.prize-smoke/1");
	assert.equal(evidence.profile, PRIZE_PROFILE);
	assert.equal(evidence.worker.path, "scripts/prize-codec-worker.mjs");
	assert.match(evidence.worker.sha256, /^[a-f0-9]{64}$/);
	assert.deepEqual(evidence.implementation.map((item: { path: string }) => item.path), ["src/core/school-prize.ts", "scripts/school-prize.ts"]);
	for (const item of evidence.implementation) assert.match(item.sha256, /^[a-f0-9]{64}$/);
	assert.equal(evidence.budget.provider_calls, 0);
	assert.equal(evidence.budget.gpu_calls, 0);
	assert.equal(evidence.budget.maximum_input_bytes, SMOKE_LIMIT);
	assert.ok(evidence.budget.actual_unique_input_bytes <= SMOKE_LIMIT);
	assert.deepEqual(evidence.claims, {
		decoder_execution: "OBSERVED_FIXED_WORKER_CHILD_PROCESSES", decoder_independence: "NOT_ESTABLISHED",
		ram_disk_limits: "NOT_MEASURED", package_qualification: "NOT_ESTABLISHED", generalization: "NOT_ESTABLISHED",
		official_prize_result: "NOT_ESTABLISHED", award_eur: null,
	});
	const names = evidence.cases.map((entry: { name: string }) => entry.name);
	assert.equal(new Set(names).size, names.length);
	assert.ok(names.includes("deterministic-noise"));
	assert.ok(names.includes("already-deflated-noise"));
	let observedUniqueBytes = 0n, improvements = 0, regressions = 0;
	for (const entry of evidence.cases) {
		assert.deepEqual(entry.executions.map((run: { codec: string; phase: string; exit_code: number }) => [run.codec, run.phase, run.exit_code]), [
			["raw", "encode", 0], ["raw", "decode", 0], ["deflate", "encode", 0], ["deflate", "decode", 0],
		]);
		const comparison = entry.comparison;
		assert.equal(comparison.external_prize_improvement, "NOT_ESTABLISHED");
		assert.equal(comparison.award_eur, null);
		assert.equal(comparison.baseline.corpus.sha256, comparison.candidate.corpus.sha256);
		observedUniqueBytes += BigInt(comparison.baseline.corpus.bytes);
		for (const grade of [comparison.baseline, comparison.candidate]) {
			assert.equal(grade.verdict, "EXACT_BYTES_OBSERVED");
			assert.equal(grade.track, "smoke");
			assert.equal(grade.corpus.matches_pin, true);
			assert.equal(grade.recovery.exact_bytes, true);
			assert.equal(grade.accounting.score_form, "shared-program");
			assert.equal(grade.accounting.program_format, "unqualified-source");
			assert.equal(grade.accounting.coverage, "DECLARED_FILES_ONLY");
			assert.equal(grade.proof.decoder_execution, "NOT_OBSERVED", "the inspector does not inherit execution authority from the outer receipt");
			const expected = 2n * BigInt(grade.accounting.compressor_bytes) + BigInt(grade.accounting.archive_bytes) + BigInt(grade.accounting.option_bytes);
			assert.equal(grade.accounting.total_declared_bytes, String(expected));
		}
		const saved = BigInt(comparison.baseline.accounting.total_declared_bytes) - BigInt(comparison.candidate.accounting.total_declared_bytes);
		assert.equal(comparison.saving_bytes, String(saved));
		if (saved > 0n) improvements++; else if (saved < 0n) regressions++;
	}
	assert.equal(observedUniqueBytes, BigInt(evidence.budget.actual_unique_input_bytes));
	assert.ok(improvements > 0 && regressions > 0, "the record must retain both favorable and unfavorable smoke outcomes");
});
