import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";

// An artifact inspector, not an entrant-code executor or an official prize judge.
export const PRIZE_PROFILE = "hutter-enwik9/rules-2026-11-17";
export const SMOKE_LIMIT = 1_048_576;
export const ENWIK9_BYTES = 1_000_000_000;
export const ENWIK9_MD5 = "e206c3450ac99950df65bf70ef61a12d";
export const ENWIK9_SHA1 = "2996e86fb978f93cca8f566cc56998923e7fe581";
const ARTIFACT_LIMIT = 1_000_000_000;
type JsonObject = Record<string, unknown>;
type ScoreForm = "self-extracting" | "separate" | "shared-program";
export type PrizeAttempt = {
	format: "school.prize-attempt/1";
	profile: typeof PRIZE_PROFILE;
	attempt_id: string;
	track: "smoke" | "proxy" | "full-corpus";
	score_form: ScoreForm;
	program_format: "unqualified-source" | "executable" | "source-package";
	expected_corpus: { bytes: string; sha256: string };
	files: {
		original: string; restored: string; compressor: string; archive: string;
		decompressor?: string;
		options: { phase: "compress" | "decompress" | "compile-compressor" | "compile-decompressor"; path: string }[];
	};
};
type FileObservation = { role: string; path: string; bytes: string; sha256: string; md5: string; sha1: string; identity: string };

function record(value: unknown, name: string): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}: object required`);
	return value as JsonObject;
}
function fields(object: JsonObject, required: string[], optional: string[] = []): void {
	for (const key of Object.keys(object)) if (![...required, ...optional].includes(key)) throw new Error(`unsupported field: ${key}`);
	for (const key of required) if (!Object.hasOwn(object, key)) throw new Error(`missing required field: ${key}`);
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${name}: unsupported value`);
	return value as T;
}
function whole(value: unknown, pattern: RegExp): value is string {
	return typeof value === "string" && value.match(pattern)?.[0] === value;
}
function relativeFile(value: unknown): string {
	if (!whole(value, /^[A-Za-z0-9_.\/-]{1,240}$/) || value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === "..")) {
		throw new Error("file path must be a plain relative path without traversal");
	}
	return value;
}

/** JSON.parse accepts duplicate keys; manifests reject them before semantic validation. */
export function parsePrizeAttemptJson(text: string): PrizeAttempt {
	if (Buffer.byteLength(text) > 65_536) throw new Error("manifest exceeds 64 KiB");
	const parsed: unknown = JSON.parse(text);
	let at = 0;
	const whitespace = () => { while (at < text.length && /\s/.test(text[at]!)) at++; };
	const string = (): string => {
		const start = at++;
		while (at < text.length) {
			const char = text[at++];
			if (char === "\\") at++;
			else if (char === '"') return JSON.parse(text.slice(start, at)) as string;
		}
		throw new Error("unterminated string");
	};
	const value = (depth: number): void => {
		if (depth > 16) throw new Error("manifest nesting limit exceeded");
		whitespace();
		if (text[at] === "{") {
			at++; whitespace(); const seen = new Set<string>();
			if (text[at] !== "}") for (;;) {
				whitespace(); const key = string();
				if (seen.has(key)) throw new Error(`duplicate JSON key: ${key}`);
				seen.add(key); whitespace(); at++; value(depth + 1); whitespace();
				if (text[at] !== ",") break;
				at++;
			}
			at++;
		} else if (text[at] === "[") {
			at++; whitespace();
			if (text[at] !== "]") for (;;) { value(depth + 1); whitespace(); if (text[at] !== ",") break; at++; }
			at++;
		} else if (text[at] === '"') string();
		else { while (at < text.length && !/[\s,}\]]/.test(text[at]!)) at++; }
	};
	value(0);
	return parsePrizeAttempt(parsed);
}

export function parsePrizeAttempt(value: unknown): PrizeAttempt {
	const item = record(value, "attempt");
	fields(item, ["format", "profile", "attempt_id", "track", "score_form", "program_format", "expected_corpus", "files"]);
	oneOf(item.format, ["school.prize-attempt/1"], "format");
	oneOf(item.profile, [PRIZE_PROFILE], "profile");
	if (!whole(item.attempt_id, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/)) throw new Error("invalid attempt_id");
	oneOf(item.track, ["smoke", "proxy", "full-corpus"], "track");
	const form = oneOf(item.score_form, ["self-extracting", "separate", "shared-program"], "score_form");
	oneOf(item.program_format, ["unqualified-source", "executable", "source-package"], "program_format");
	const corpus = record(item.expected_corpus, "expected_corpus");
	fields(corpus, ["bytes", "sha256"]);
	if (!whole(corpus.bytes, /^(0|[1-9][0-9]{0,9})$/) || BigInt(corpus.bytes) > BigInt(ENWIK9_BYTES)) throw new Error("invalid corpus byte count");
	if (!whole(corpus.sha256, /^[a-f0-9]{64}$/)) throw new Error("invalid corpus SHA-256");
	const files = record(item.files, "files");
	fields(files, ["original", "restored", "compressor", "archive", "options"], form === "self-extracting" ? [] : ["decompressor"]);
	for (const name of ["original", "restored", "compressor", "archive"]) relativeFile(files[name]);
	if (form !== "self-extracting") relativeFile(files.decompressor);
	if (!Array.isArray(files.options) || files.options.length > 4) throw new Error("options must list at most four phases");
	const phases = new Set<string>();
	for (const entry of files.options) {
		const option = record(entry, "option"); fields(option, ["phase", "path"]);
		const phase = oneOf(option.phase, ["compress", "decompress", "compile-compressor", "compile-decompressor"], "option phase");
		if (phases.has(phase)) throw new Error("duplicate option phase");
		phases.add(phase); relativeFile(option.path);
	}
	return structuredClone(item) as PrizeAttempt;
}

function resolveFile(root: string, relative: string): string {
	let current = root;
	for (const part of relative.split("/")) {
		current = path.join(current, part);
		if (lstatSync(current).isSymbolicLink()) throw new Error(`symlink refused: ${relative}`);
	}
	if (!lstatSync(current).isFile()) throw new Error(`regular file required: ${relative}`);
	return current;
}
function observeFile(root: string, relative: string, role: string, limit: number): FileObservation {
	const file = resolveFile(root, relative);
	const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const before = fstatSync(descriptor);
		if (!before.isFile() || before.size > limit) throw new Error(`${role}: file exceeds limit or is not regular`);
		const sha256 = createHash("sha256"), md5 = createHash("md5"), sha1 = createHash("sha1");
		const buffer = Buffer.alloc(65_536); let total = 0, length: number;
		while ((length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
			total += length; if (total > limit) throw new Error(`${role}: file grew beyond limit`);
			const chunk = buffer.subarray(0, length); sha256.update(chunk); md5.update(chunk); sha1.update(chunk);
		}
		const after = fstatSync(descriptor);
		if (total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`${role}: file changed during inspection`);
		return { role, path: relative, bytes: String(total), sha256: sha256.digest("hex"), md5: md5.digest("hex"), sha1: sha1.digest("hex"), identity: `${after.dev}:${after.ino}` };
	} finally { closeSync(descriptor); }
}
function equalFiles(root: string, left: string, right: string, expectedBytes: number): boolean {
	const a = openSync(resolveFile(root, left), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let b: number | undefined;
	try {
		b = openSync(resolveFile(root, right), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const first = Buffer.alloc(65_536), second = Buffer.alloc(65_536);
		for (let offset = 0; offset < expectedBytes; offset += first.length) {
			const amount = Math.min(first.length, expectedBytes - offset);
			const al = readSync(a, first, 0, amount, offset), bl = readSync(b, second, 0, amount, offset);
			if (al !== amount || bl !== amount || !first.subarray(0, amount).equals(second.subarray(0, amount))) return false;
		}
		return fstatSync(a).size === expectedBytes && fstatSync(b).size === expectedBytes;
	} finally { closeSync(a); if (b !== undefined) closeSync(b); }
}

export function declaredScore(form: ScoreForm, compressor: bigint, decompressor: bigint, archive: bigint, options: bigint): bigint {
	for (const amount of [compressor, decompressor, archive, options]) if (amount < 0n) throw new Error("negative component size");
	if (form === "self-extracting") return compressor + archive + options;
	if (form === "separate") return compressor + 2n * decompressor + archive + options;
	if (form === "shared-program") return 2n * compressor + archive + options;
	throw new Error("unsupported score form");
}

/** Integer cutoff from the percentage formula. This is not a promise of eligibility or payment. */
export function onePercentCutoff(referenceBytes: bigint): bigint {
	if (referenceBytes <= 0n) throw new Error("positive reference required");
	return referenceBytes * 99n / 100n;
}

/** A child receives only the remaining cumulative allowance, rounded down. */
export function prizeChildTimeout(deadlineMs: number, nowMs: number, maximumChildMs = 5_000): number {
	if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs) || !Number.isSafeInteger(maximumChildMs) || maximumChildMs <= 0) throw new Error("invalid smoke deadline");
	const remaining = Math.floor(deadlineMs - nowMs);
	if (remaining <= 0) throw new Error("cumulative smoke budget exhausted");
	return Math.min(maximumChildMs, remaining);
}

export function gradePrizeBundle(directory: string, candidate: unknown, maximumCorpusBytes = SMOKE_LIMIT) {
	const attempt = parsePrizeAttempt(candidate);
	if (!Number.isSafeInteger(maximumCorpusBytes) || maximumCorpusBytes < 0 || maximumCorpusBytes > ENWIK9_BYTES) throw new Error("invalid corpus inspection limit");
	const root = path.resolve(directory);
	if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error("bundle root must be a real directory without symlink aliases");
	const limit = attempt.track === "smoke" ? Math.min(SMOKE_LIMIT, maximumCorpusBytes) : maximumCorpusBytes;
	const original = observeFile(root, attempt.files.original, "original", limit);
	const restored = observeFile(root, attempt.files.restored, "restored", limit);
	const compressor = observeFile(root, attempt.files.compressor, "compressor", ARTIFACT_LIMIT);
	const archive = observeFile(root, attempt.files.archive, "archive", ARTIFACT_LIMIT);
	const decoder = attempt.files.decompressor ? observeFile(root, attempt.files.decompressor, "decompressor", ARTIFACT_LIMIT) : undefined;
	const options = attempt.files.options.map(option => observeFile(root, option.path, `options:${option.phase}`, 65_536));
	const observations = [original, restored, compressor, archive, ...(decoder ? [decoder] : []), ...options];
	if (compressor.bytes === "0" || decoder?.bytes === "0") throw new Error("program artifact cannot be empty");
	if (original.identity === restored.identity || original.identity === archive.identity || restored.identity === archive.identity) throw new Error("original, archive and restored must be distinct files");
	if ([compressor, ...(decoder ? [decoder] : [])].some(program => [original, restored, archive].some(data => data.identity === program.identity))) throw new Error("program and data roles must be distinct files");
	if (attempt.score_form === "shared-program" && (!decoder || compressor.bytes !== decoder.bytes || compressor.sha256 !== decoder.sha256 || !equalFiles(root, compressor.path, decoder.path, Number(compressor.bytes)))) throw new Error("shared-program requires identical compressor and decompressor bytes");
	const errors: string[] = [];
	const corpusMatches = original.bytes === attempt.expected_corpus.bytes && original.sha256 === attempt.expected_corpus.sha256;
	if (!corpusMatches) errors.push("source does not match pinned expected corpus");
	const exact = original.bytes === restored.bytes && original.sha256 === restored.sha256 && equalFiles(root, original.path, restored.path, Number(original.bytes));
	if (!exact) errors.push("restored bytes differ from original");
	const canonical = original.bytes === String(ENWIK9_BYTES) && original.md5 === ENWIK9_MD5 && original.sha1 === ENWIK9_SHA1;
	if (attempt.track === "full-corpus" && !canonical) errors.push("full-corpus track requires the published enwik9 identity");
	const optionBytes = options.reduce((sum, item) => sum + BigInt(item.bytes), 0n);
	const total = declaredScore(attempt.score_form, BigInt(compressor.bytes), BigInt(decoder?.bytes ?? "0"), BigInt(archive.bytes), optionBytes);
	return {
		format: "school.prize-grade/1" as const,
		profile: PRIZE_PROFILE,
		attempt_id: attempt.attempt_id,
		track: attempt.track,
		verdict: errors.length ? "REJECTED" as const : "EXACT_BYTES_OBSERVED" as const,
		errors,
		corpus: { bytes: original.bytes, sha256: original.sha256, matches_pin: corpusMatches, canonical_enwik9: canonical },
		recovery: { exact_bytes: exact, method: "length, SHA-256, and byte-for-byte comparison" },
		accounting: {
			score_form: attempt.score_form, program_format: attempt.program_format,
			compressor_bytes: compressor.bytes, decompressor_bytes: decoder?.bytes ?? "0", archive_bytes: archive.bytes,
			option_bytes: String(optionBytes), total_declared_bytes: String(total),
			coverage: "DECLARED_FILES_ONLY" as const,
		},
		files: observations.map(file => ({ role: file.role, path: file.path, bytes: file.bytes, sha256: file.sha256, md5: file.md5, sha1: file.sha1 })),
		proof: { decoder_execution: "NOT_OBSERVED", decoder_independence: "NOT_ESTABLISHED", complete_dependencies: "NOT_ESTABLISHED", executable_qualification: "NOT_ESTABLISHED", time_ram_disk: "NOT_MEASURED", license_and_source: "NOT_REVIEWED", generalization: "NOT_ESTABLISHED" },
		prize: { standing: "NOT_SUBMITTED", award_eur: null },
	};
}

export function comparePrizeBundles(baseline: { directory: string; attempt: unknown }, candidate: { directory: string; attempt: unknown }, maximumCorpusBytes = SMOKE_LIMIT) {
	// Saved reports are never accepted as the authority: inspect both bundles again.
	const before = gradePrizeBundle(baseline.directory, baseline.attempt, maximumCorpusBytes);
	const after = gradePrizeBundle(candidate.directory, candidate.attempt, maximumCorpusBytes);
	if (before.verdict === "REJECTED" || after.verdict === "REJECTED") throw new Error("comparison requires two exact, pinned artifacts");
	if (before.track !== after.track || before.corpus.bytes !== after.corpus.bytes || before.corpus.sha256 !== after.corpus.sha256 || before.accounting.program_format !== after.accounting.program_format) throw new Error("comparison requires the same corpus, track and program format");
	const base = BigInt(before.accounting.total_declared_bytes), next = BigInt(after.accounting.total_declared_bytes), saving = base - next;
	return {
		format: "school.prize-comparison/1", baseline: before, candidate: after,
		saving_bytes: String(saving), improvement_percent: { numerator: String(saving * 100n), denominator: String(base) },
		at_least_one_percent_on_this_input: saving > 0n && saving * 100n >= base,
		external_prize_improvement: "NOT_ESTABLISHED", award_eur: null,
	};
}
