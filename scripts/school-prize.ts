import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform, release, arch } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { deflateSync } from "node:zlib";
import { comparePrizeBundles, gradePrizeBundle, parsePrizeAttemptJson, prizeChildTimeout, PRIZE_PROFILE, SMOKE_LIMIT, type PrizeAttempt } from "../src/core/school-prize.ts";

const root = path.resolve(import.meta.dirname, "..");
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
function load(directory: string) {
	const file = path.join(directory, "attempt.json"), stat = lstatSync(file);
	if (!stat.isFile() || stat.size > 65_536) throw new Error("manifest must be a regular file of at most 64 KiB");
	return parsePrizeAttemptJson(readFileSync(file, "utf8"));
}
function flags(args: string[], allowed: string[]): Map<string, string> {
	const result = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index]!, value = args[index + 1];
		if (!allowed.includes(key) || result.has(key) || !value || value.startsWith("--")) throw new Error(`invalid or duplicate option: ${key}`);
		result.set(key, value);
	}
	return result;
}
function inspectionLimit(options: Map<string, string>): number {
	const value = options.get("--max-corpus-bytes");
	if (value === undefined) return SMOKE_LIMIT;
	if (value.match(/^(0|[1-9][0-9]{0,9})$/)?.[0] !== value) throw new Error("invalid --max-corpus-bytes");
	return Number(value);
}
function fixtures(): { name: string; bytes: Buffer }[] {
	const noise = Buffer.alloc(32_768); let state = 0x6d2b79f5;
	for (let index = 0; index < noise.length; index++) {
		state ^= state << 13; state ^= state >>> 17; state ^= state << 5; noise[index] = state & 255;
	}
	const markup = Buffer.from(Array.from({ length: 600 }, (_, index) => `<page><title>Town ${index}</title><text>Population ${1000 + index}. A river crosses this town.</text></page>\n`).join(""));
	return [
		{ name: "empty", bytes: Buffer.alloc(0) },
		{ name: "short", bytes: Buffer.from("Six sevens: 777777.\n") },
		{ name: "repeated", bytes: Buffer.from("AUM can retain a rule and the changes needed to recover each byte.\n".repeat(800)) },
		{ name: "synthetic-markup", bytes: markup },
		{ name: "deterministic-noise", bytes: noise },
		{ name: "already-deflated-noise", bytes: deflateSync(noise, { level: 9 }) },
	];
}
function runSmoke(outputDirectory: string) {
	const started = performance.now(), deadline = started + 30_000;
	const output = path.resolve(outputDirectory);
	if (existsSync(output)) throw new Error("smoke output directory must not already exist");
	const fixtureSet = fixtures();
	if (fixtureSet.reduce((sum, fixture) => sum + fixture.bytes.length, 0) > SMOKE_LIMIT) throw new Error("aggregate smoke input limit exceeded");
	mkdirSync(output, { recursive: true });
	const worker = path.join(root, "scripts/prize-codec-worker.mjs"), workerHash = digest(readFileSync(worker));
	const cases = fixtureSet.map(fixture => {
		const executions: { codec: string; phase: string; wall_ms: number; exit_code: number; cwd: string }[] = [];
		const bundles = ["raw", "deflate"].map(codec => {
			const directory = path.join(output, fixture.name, codec);
			mkdirSync(path.join(directory, "encode-work"), { recursive: true });
			mkdirSync(path.join(directory, "decode-work"));
			writeFileSync(path.join(directory, "original.bin"), fixture.bytes, { flag: "wx" });
			copyFileSync(worker, path.join(directory, "codec.mjs"));
			writeFileSync(path.join(directory, "compress.args"), `encode ${codec}`, { flag: "wx" });
			writeFileSync(path.join(directory, "decompress.args"), `decode ${codec}`, { flag: "wx" });
			for (const phase of ["encode", "decode"]) {
				const childTimeout = prizeChildTimeout(deadline, performance.now());
				const input = path.join(directory, phase === "encode" ? "original.bin" : "archive.bin");
				const target = path.join(directory, phase === "encode" ? "archive.bin" : "restored.bin");
				const cwd = path.join(directory, `${phase}-work`), before = performance.now();
				const result = spawnSync(process.execPath, [path.join(directory, "codec.mjs"), phase, codec, input, target], { cwd, encoding: "utf8", timeout: childTimeout, maxBuffer: 65_536 });
				prizeChildTimeout(deadline, performance.now());
				if (result.error || result.status !== 0) throw new Error(`${fixture.name}/${codec}/${phase}: ${result.error?.message ?? result.stderr}`);
				executions.push({ codec, phase, wall_ms: Math.round((performance.now() - before) * 1000) / 1000, exit_code: result.status, cwd: `${phase}-work` });
			}
			const attempt: PrizeAttempt = {
				format: "school.prize-attempt/1", profile: PRIZE_PROFILE,
				attempt_id: `${fixture.name}-${codec}`, track: "smoke", score_form: "shared-program", program_format: "unqualified-source",
				expected_corpus: { bytes: String(fixture.bytes.length), sha256: digest(fixture.bytes) },
				files: { original: "original.bin", restored: "restored.bin", compressor: "codec.mjs", decompressor: "codec.mjs", archive: "archive.bin", options: [{ phase: "compress", path: "compress.args" }, { phase: "decompress", path: "decompress.args" }] },
			};
			writeFileSync(path.join(directory, "attempt.json"), json(attempt), { flag: "wx" });
			return { directory, attempt };
		});
		const comparison = comparePrizeBundles(bundles[0]!, bundles[1]!);
		return { name: fixture.name, executions, comparison };
	});
	const result = {
		format: "school.prize-smoke/1", observed_at: new Date().toISOString(), profile: PRIZE_PROFILE,
		host: { node: process.version, platform: platform(), release: release(), arch: arch() },
		worker: { path: "scripts/prize-codec-worker.mjs", sha256: workerHash },
		implementation: ["src/core/school-prize.ts", "scripts/school-prize.ts"].map(file => ({ path: file, sha256: digest(readFileSync(path.join(root, file))) })),
		budget: { maximum_input_bytes: SMOKE_LIMIT, actual_unique_input_bytes: fixtureSet.reduce((sum, fixture) => sum + fixture.bytes.length, 0), provider_calls: 0, gpu_calls: 0 },
		claims: { decoder_execution: "OBSERVED_FIXED_WORKER_CHILD_PROCESSES", decoder_independence: "NOT_ESTABLISHED", ram_disk_limits: "NOT_MEASURED", package_qualification: "NOT_ESTABLISHED", generalization: "NOT_ESTABLISHED", official_prize_result: "NOT_ESTABLISHED", award_eur: null },
		cases,
	};
	prizeChildTimeout(deadline, performance.now());
	return result;
}

try {
	const [command, ...arguments_] = process.argv.slice(2);
	let result: unknown;
	if (command === "grade") {
		const [directory, ...rest] = arguments_; if (!directory || directory.startsWith("--")) throw new Error("grade requires a bundle directory");
		const options = flags(rest, ["--max-corpus-bytes"]);
		result = gradePrizeBundle(directory, load(directory), inspectionLimit(options));
		if ((result as { verdict: string }).verdict === "REJECTED") process.exitCode = 1;
	} else if (command === "compare") {
		const [baseline, candidate, ...rest] = arguments_; if (!baseline || !candidate || baseline.startsWith("--") || candidate.startsWith("--")) throw new Error("compare requires two bundle directories");
		const options = flags(rest, ["--max-corpus-bytes"]);
		result = comparePrizeBundles({ directory: baseline, attempt: load(baseline) }, { directory: candidate, attempt: load(candidate) }, inspectionLimit(options));
	} else if (command === "smoke") {
		const options = flags(arguments_, ["--out", "--report"]), directory = options.get("--out");
		if (!directory) throw new Error("smoke requires --out NEW_DIRECTORY");
		result = runSmoke(directory);
		const report = options.get("--report");
		if (report) { mkdirSync(path.dirname(path.resolve(report)), { recursive: true }); writeFileSync(report, json(result), { flag: "wx" }); }
	} else {
		throw new Error("usage: school-prize.ts grade BUNDLE [--max-corpus-bytes N] | compare BASE CANDIDATE [--max-corpus-bytes N] | smoke --out NEW_DIRECTORY [--report NEW_FILE]");
	}
	process.stdout.write(json(result));
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2;
}
