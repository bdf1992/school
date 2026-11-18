// Predictor study runner. A frozen plan names the inputs and, from cycle 2 on, the variants
// and comparisons; without them it runs cycle 1 (order 0, order 1, DEFLATE reference).
// It executes only the checked-in codec files listed below, never any other program.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { comparePrizeBundles, gradePrizeBundle, PRIZE_PROFILE, SMOKE_LIMIT, type PrizeAttempt } from "../src/core/school-prize.ts";

const root = path.resolve(import.meta.dirname, "..");
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
// Defaults for studies under the smoke limit; a plan may raise them up to the hard ceilings.
const DEFAULT_CHILD_MS = 60_000, DEFAULT_TOTAL_MS = 600_000, MAX_CHILD_MS = 3_600_000, MAX_TOTAL_MS = 14_400_000, MAX_INPUT = 100_000_000;
const REFERENCE_WORKERS = ["scripts/prize-codec-worker.mjs", "scripts/prize-baseline-worker.mjs"];
type Variant = { id: string; program: string; argument: string };
const PROGRAMS: Record<string, string[]> = {
	"scripts/prize-predictor-codec.mjs": ["0", "1"],
	"scripts/prize-mix-codec.mjs": ["mix", "mix+match", "mix-large", "mix+match-large"],
	"scripts/prize-baseline-worker.mjs": ["deflate", "brotli", "zstd"],
	"scripts/prize-codec-worker.mjs": ["deflate", "raw"],
};
const CYCLE_ONE: Variant[] = [
	{ id: "order0", program: "scripts/prize-predictor-codec.mjs", argument: "0" },
	{ id: "order1", program: "scripts/prize-predictor-codec.mjs", argument: "1" },
	{ id: "deflate", program: "scripts/prize-codec-worker.mjs", argument: "deflate" },
];
type Plan = { format: string; inputs: { name: string; bytes: string; sha256: string }[]; variants?: Variant[]; comparisons?: [string, string][]; damaged_archive_controls?: boolean; limits?: { input_bytes_per_case?: string; child_timeout_ms?: number; cumulative_ms?: number } };

function run(planFile: string, inputDirectory: string, outputDirectory: string) {
	const started = performance.now(), output = path.resolve(outputDirectory);
	if (existsSync(output)) throw new Error("output directory must not already exist");
	const planBytes = readFileSync(planFile), plan = JSON.parse(planBytes.toString("utf8")) as Plan;
	if (plan.format !== "school.prize-study-plan/1" || !Array.isArray(plan.inputs) || !plan.inputs.length) throw new Error("unsupported plan");
	const variants = plan.variants ?? CYCLE_ONE, comparisons = plan.comparisons ?? [["order0", "order1"], ["deflate", "order1"]];
	for (const variant of variants) {
		if (!/^[a-z0-9]{1,24}$/.test(variant.id) || !PROGRAMS[variant.program]?.includes(variant.argument)) throw new Error(`plan names a variant outside the fixed codecs: ${variant.id}`);
	}
	if (new Set(variants.map(variant => variant.id)).size !== variants.length) throw new Error("duplicate variant id");
	const bounded = (value: unknown, fallback: number, ceiling: number) => { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > ceiling) throw new Error("plan limit is outside the runner's ceiling"); return value as number; };
	const CHILD_MS = bounded(plan.limits?.child_timeout_ms, DEFAULT_CHILD_MS, MAX_CHILD_MS), TOTAL_MS = bounded(plan.limits?.cumulative_ms, DEFAULT_TOTAL_MS, MAX_TOTAL_MS);
	const INPUT_LIMIT = bounded(plan.limits?.input_bytes_per_case === undefined ? undefined : Number(plan.limits.input_bytes_per_case), SMOKE_LIMIT, MAX_INPUT);
	const withControls = plan.damaged_archive_controls ?? true;
	for (const pair of comparisons) if (pair.length !== 2 || pair.some(id => !variants.some(variant => variant.id === id))) throw new Error("comparison names an unknown variant");
	// Every input is checked against the frozen plan before any codec runs.
	const inputs = plan.inputs.map(entry => {
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.name)) throw new Error(`invalid input name: ${entry.name}`);
		const bytes = readFileSync(path.join(inputDirectory, `${entry.name}.bin`));
		if (bytes.length > INPUT_LIMIT || String(bytes.length) !== entry.bytes || digest(bytes) !== entry.sha256) throw new Error(`input does not match the frozen plan: ${entry.name}`);
		return { name: entry.name, bytes };
	});
	mkdirSync(output, { recursive: true });
	const cases = inputs.map(input => {
		const executions: { variant: string; phase: string; wall_ms: number; peak_rss_kb: number | null; exit_code: number }[] = [];
		const left = () => { const remaining = Math.floor(TOTAL_MS - (performance.now() - started)); if (remaining <= 0) throw new Error("cumulative study budget exhausted"); return Math.min(CHILD_MS, remaining); };
		const bundles = variants.map(variant => {
			const directory = path.join(output, input.name, variant.id);
			mkdirSync(path.join(directory, "encode-work"), { recursive: true });
			mkdirSync(path.join(directory, "decode-work"));
			writeFileSync(path.join(directory, "original.bin"), input.bytes, { flag: "wx" });
			copyFileSync(path.join(root, variant.program), path.join(directory, "codec.mjs"));
			writeFileSync(path.join(directory, "compress.args"), `encode ${variant.argument}`, { flag: "wx" });
			writeFileSync(path.join(directory, "decompress.args"), `decode ${variant.argument}`, { flag: "wx" });
			for (const phase of ["encode", "decode"]) {
				const source = path.join(directory, phase === "encode" ? "original.bin" : "archive.bin");
				const target = path.join(directory, phase === "encode" ? "archive.bin" : "restored.bin");
				const before = performance.now();
				const result = spawnSync(process.execPath, [path.join(directory, "codec.mjs"), phase, variant.argument, source, target], { cwd: path.join(directory, `${phase}-work`), encoding: "utf8", timeout: left(), maxBuffer: 65_536 });
				const wall = Math.round((performance.now() - before) * 1000) / 1000;
				if (result.error || result.status !== 0) throw new Error(`${input.name}/${variant.id}/${phase}: ${result.error?.message ?? result.stderr}`);
				let rss: number | null = null;
				try { rss = (JSON.parse(result.stdout) as { peak_rss_kb: number }).peak_rss_kb; } catch { /* the DEFLATE worker reports none */ }
				executions.push({ variant: variant.id, phase, wall_ms: wall, peak_rss_kb: rss, exit_code: result.status });
			}
			const attempt: PrizeAttempt = {
				format: "school.prize-attempt/1", profile: PRIZE_PROFILE,
				attempt_id: `${input.name}-${variant.id}`, track: "proxy", score_form: "shared-program", program_format: "unqualified-source",
				expected_corpus: { bytes: String(input.bytes.length), sha256: digest(input.bytes) },
				files: { original: "original.bin", restored: "restored.bin", compressor: "codec.mjs", decompressor: "codec.mjs", archive: "archive.bin", options: [{ phase: "compress", path: "compress.args" }, { phase: "decompress", path: "decompress.args" }] },
			};
			writeFileSync(path.join(directory, "attempt.json"), json(attempt), { flag: "wx" });
			return { directory, attempt };
		});
		// Damaged-archive control: one flipped bit must not restore the original. The DEFLATE worker is not under study.
		const controls = !withControls ? [] : variants.filter(variant => !REFERENCE_WORKERS.includes(variant.program)).map(variant => {
			const directory = path.join(output, input.name, variant.id), archive = readFileSync(path.join(directory, "archive.bin"));
			const damaged = Buffer.from(archive); damaged[Math.floor(damaged.length / 2)]! ^= 0x10;
			const work = path.join(directory, "control-work"); mkdirSync(work);
			writeFileSync(path.join(work, "damaged.bin"), damaged, { flag: "wx" });
			const result = spawnSync(process.execPath, [path.join(directory, "codec.mjs"), "decode", variant.argument, path.join(work, "damaged.bin"), path.join(work, "restored.bin")], { cwd: work, encoding: "utf8", timeout: left(), maxBuffer: 65_536 });
			const restored = result.status === 0 && existsSync(path.join(work, "restored.bin")) ? readFileSync(path.join(work, "restored.bin")) : null;
			return { variant: variant.id, decoder_exit_code: result.status, restored_equals_original: restored !== null && restored.equals(input.bytes) };
		});
		const bundle = (id: string) => bundles[variants.findIndex(variant => variant.id === id)]!;
		return {
			name: input.name, executions, damaged_archive_controls: controls,
			archive_bytes: Object.fromEntries(bundles.map((item, index) => [variants[index]!.id, gradePrizeBundle(item.directory, item.attempt, INPUT_LIMIT).accounting.archive_bytes])),
			...Object.fromEntries(comparisons.map(([from, to]) => [`${from}_to_${to}`, comparePrizeBundles(bundle(from), bundle(to), INPUT_LIMIT)])),
		};
	});
	return {
		format: "school.prize-predictor-study/1", observed_at: new Date().toISOString(), profile: PRIZE_PROFILE,
		plan: { path: path.basename(planFile), sha256: digest(planBytes) },
		host: { node: process.version, platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown", logical_cpus: cpus().length, total_memory_bytes: totalmem() },
		variants, comparisons,
		programs: [...new Set(variants.map(variant => variant.program)), "src/core/school-prize.ts", "scripts/school-prize-predictors.ts"].map(file => ({ path: file, sha256: digest(readFileSync(path.join(root, file))) })),
		budget: { control_children: cases.reduce((sum, item) => sum + item.damaged_archive_controls.length, 0), maximum_input_bytes_per_case: INPUT_LIMIT, child_timeout_ms: CHILD_MS, cumulative_ms: TOTAL_MS, elapsed_ms: Math.round(performance.now() - started), provider_calls: 0, gpu_calls: 0 },
		claims: { decoder_execution: "OBSERVED_FIXED_CODEC_CHILD_PROCESSES", decoder_independence: "NOT_ESTABLISHED", ram_disk_limits: "PEAK_RSS_SELF_REPORTED_BY_CHILD", package_qualification: "NOT_ESTABLISHED", generalization: "NOT_ESTABLISHED", official_prize_result: "NOT_ESTABLISHED", award_eur: null },
		cases,
	};
}

try {
	const args = process.argv.slice(2), options = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index]!, value = args[index + 1];
		if (!["--plan", "--inputs", "--out", "--report"].includes(key) || options.has(key) || !value) throw new Error(`invalid or duplicate option: ${key}`);
		options.set(key, value);
	}
	const plan = options.get("--plan"), inputs = options.get("--inputs"), out = options.get("--out");
	if (!plan || !inputs || !out) throw new Error("usage: school-prize-predictors.ts --plan PLAN.json --inputs DIRECTORY --out NEW_DIRECTORY [--report NEW_FILE]");
	const result = run(plan, inputs, out), report = options.get("--report");
	if (report) writeFileSync(report, json(result), { flag: "wx" });
	process.stdout.write(json(result));
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2;
}
