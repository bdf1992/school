/** Local, sequential Ollama context experiments. No global provider or credential resolution. */
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { closeSync, fstatSync, fsyncSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { freemem, hostname, tmpdir, totalmem } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

export const CONTEXT_BODY_LIMIT = 4 * 1024 * 1024;
export const DEFAULT_CONTEXTS = [16_384, 32_768, 65_536] as const;
type Json = Record<string, unknown>;
type Mode = "inspect" | "prepare" | "run";
type Observation = "ABSENT" | "INSUFFICIENT" | "SUFFICIENT";
const record = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const normalizedDigest = (value: string) => value.replace(/^sha256:/, "").toLowerCase();

export class OllamaContextError extends Error {
	constructor(readonly code: string, message: string) { super(message); }
}
function fail(code: string, message: string): never { throw new OllamaContextError(code, message); }

/** Canonical literal loopback only; localhost is rewritten to IPv4 to avoid DNS/proxy resolution. */
export function localOllamaUrl(value: string): string {
	let url: URL;
	try { url = new URL(value); } catch { return fail("INVALID_ENDPOINT", "Use an HTTP loopback Ollama root URL."); }
	if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
		return fail("NONLOCAL_ENDPOINT", "Only http://127.0.0.1, localhost, or [::1] at the Ollama root is allowed; no credentials, path, query, or fragment.");
	}
	if (url.hostname === "localhost") url.hostname = "127.0.0.1";
	return url.origin;
}
export function contextCandidates(values: readonly number[]): number[] {
	if (!values.length || values.length > 8 || values.some((value) => !integer(value) || value < 2_048 || value > 1_048_576)) {
		return fail("INVALID_CONTEXTS", "Choose one through eight integer contexts from 2048 through 1048576.");
	}
	return [...new Set(values)].sort((a, b) => a - b);
}
/** Cooperative cross-process exclusion for this endpoint; stale locks are never stolen. */
function acquireProbeLock(endpoint: string): () => void {
	const filename = path.join(tmpdir(), `school-ollama-context-${sha(endpoint)}.lock`), nonce = randomBytes(16).toString("hex");
	let descriptor: number;
	try { descriptor = openSync(filename, "wx", 0o600); }
	catch (error) {
		if (record(error) && error.code === "EEXIST") return fail("PROBE_BUSY", `A context operation already holds ${filename}. If a prior process crashed, confirm it has stopped before removing that lock.`);
		return fail("LOCK_UNAVAILABLE", "The context operation could not acquire its local endpoint lock.");
	}
	const identity = fstatSync(descriptor);
	try { writeFileSync(descriptor, JSON.stringify({ kind: "school-ollama-context-lock", nonce, pid: process.pid, endpoint, createdAt: new Date().toISOString() })); fsyncSync(descriptor); }
	catch (error) { closeSync(descriptor); unlinkSync(filename); throw error; }
	return () => {
		try {
			const current = statSync(filename), content: unknown = JSON.parse(readFileSync(filename, "utf8"));
			if (identity.dev === current.dev && identity.ino === current.ino && record(content) && content.nonce === nonce) unlinkSync(filename);
		} finally { closeSync(descriptor); }
	};
}
/** Exclude generated comments and only the configured context, retaining adapters/history. */
function materialModelfile(value: string): string {
	let quoted = false;
	return value.split(/\r?\n/).filter((line) => {
		const inside = quoted;
		if ((line.match(/"""/g)?.length ?? 0) % 2) quoted = !quoted;
		return inside || !/^\s*(?:#|PARAMETER\s+num_ctx(?:\s|$))/i.test(line);
	}).join("\n").trim();
}
function modelId(value: string): string {
	if (!value.trim() || value !== value.trim() || value.length > 256 || /[\s\x00-\x1f\x7f]/.test(value)) return fail("INVALID_MODEL", "An exact installed Ollama model ID is required.");
	if (/(?:^|[:/._-])cloud(?:$|[:/._-])/i.test(value)) return fail("CLOUD_MODEL_REFUSED", "Cloud model names are refused. Select an installed local GGUF model.");
	return value.slice(value.lastIndexOf("/") + 1).includes(":") ? value : `${value}:latest`;
}
function noRemoteMetadata(value: Json): void {
	for (const field of ["remote_model", "remote_host"]) {
		if (value[field] !== undefined && value[field] !== null && value[field] !== "") fail("REMOTE_MODEL_REFUSED", "The model advertises a remote upstream; no generation is allowed.");
	}
}
function configuredContext(parameters: unknown): number | null {
	if (typeof parameters !== "string") return null;
	const match = /^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters);
	const value = match ? Number(match[1]) : null;
	return integer(value) ? value : null;
}

export interface LocalModelEvidence {
	id: string;
	manifestDigest: string;
	weightDigest: string;
	configurationDigest: string;
	diskBytes: number;
	parameterCount: number;
	quantization: string | null;
	nativeContext: number | null;
	configuredContext: number | null;
	locality: "SERVER_REPORTED_LOCAL_GGUF";
}
function inspectLocalModel(id: string, tag: Json, show: Json): LocalModelEvidence {
	noRemoteMetadata(tag); noRemoteMetadata(show);
	const details = record(show.details) ? show.details : {};
	const info = record(show.model_info) ? show.model_info : {};
	const modelfile = typeof show.modelfile === "string" ? show.modelfile : "";
	const from = /^FROM\s+(.+)$/m.exec(modelfile)?.[1]?.trim().replace(/^"|"$/g, "");
	const weight = from && /(?:^|[/\\])blobs[/\\]sha256[:-]([a-f0-9]{64})$/i.exec(from)?.[1]?.toLowerCase();
	if (details.format !== "gguf" || !integer(tag.size) || !integer(info["general.parameter_count"]) || !weight || typeof tag.digest !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/i.test(tag.digest)) {
		return fail("LOCAL_WEIGHTS_UNCONFIRMED", "Expected an installed GGUF with a nonzero size, parameter count, manifest digest, and local blob FROM in /api/show.");
	}
	if (!Array.isArray(show.capabilities) || !show.capabilities.includes("completion")) return fail("NOT_CHAT_MODEL", "The selected installed model does not advertise completion support.");
	const architecture = info["general.architecture"];
	const native = typeof architecture === "string" ? info[`${architecture}.context_length`] : undefined;
	const parameters = typeof show.parameters === "string" ? show.parameters.split("\n").map((line) => line.trim()).filter((line) => line && !/^num_ctx\s/.test(line)).sort() : [];
	return {
		id, manifestDigest: tag.digest, weightDigest: weight,
		configurationDigest: sha(JSON.stringify({ weight, materialModelfile: materialModelfile(modelfile), template: show.template ?? null, system: show.system ?? null, parameters, capabilities: [...show.capabilities].sort() })),
		diskBytes: tag.size, parameterCount: info["general.parameter_count"] as number,
		quantization: typeof details.quantization_level === "string" ? details.quantization_level : null,
		nativeContext: integer(native) ? native : null, configuredContext: configuredContext(show.parameters), locality: "SERVER_REPORTED_LOCAL_GGUF",
	};
}

export interface MemorySample {
	at: string;
	ram: { totalBytes: number; freeBytes: number };
	gpus: { index: number; name: string; totalMiB: number; usedMiB: number; freeMiB: number }[] | null;
	gpuObservation: "ABSENT" | "SUFFICIENT";
	measurement: "SNAPSHOT_NOT_PEAK";
}
/** One bounded local utility call; no shell, downloaded utility, or elevated privileges. */
export async function sampleLocalMemory(): Promise<MemorySample> {
	const sample: MemorySample = { at: new Date().toISOString(), ram: { totalBytes: totalmem(), freeBytes: freemem() }, gpus: null, gpuObservation: "ABSENT", measurement: "SNAPSHOT_NOT_PEAK" };
	const csv = await new Promise<string | null>((resolve) => {
		execFile("nvidia-smi", ["--query-gpu=index,name,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"], { timeout: 3_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout));
	});
	if (csv !== null) {
		const rows = csv.trim().split(/\r?\n/).filter(Boolean).map((line) => {
			const fields = line.split(",").map((item) => item.trim());
			return { index: Number(fields[0]), name: fields[1] ?? "", totalMiB: Number(fields[2]), usedMiB: Number(fields[3]), freeMiB: Number(fields[4]) };
		});
		if (rows.length && rows.every((row) => row.name && [row.index, row.totalMiB, row.usedMiB, row.freeMiB].every(finite))) { sample.gpus = rows; sample.gpuObservation = "SUFFICIENT"; }
	}
	return sample;
}

interface RequestEvidence { path: string; method: "GET" | "POST"; elapsedMs: number; status: number | null; bodyBytes: number; }
class LocalClient {
	constructor(readonly base: string, readonly timeoutMs: number, readonly requests: RequestEvidence[]) {}
	async json(path: "/api/tags" | "/api/show" | "/api/create" | "/api/chat" | "/api/ps" | "/api/generate" | "/api/version", body?: Json, generation = false): Promise<Json> {
		const entry: RequestEvidence = { path, method: body ? "POST" : "GET", elapsedMs: 0, status: null, bodyBytes: 0 };
		this.requests.push(entry);
		const started = performance.now();
		try {
			// node:http connects directly to the validated literal address. Environment
			// proxy variables and an application's global fetch dispatcher cannot reroute it.
			const bytes = await new Promise<Buffer>((resolve, reject) => {
				const request = httpRequest(`${this.base}${path}`, { method: entry.method, agent: false, headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) } });
				const timer = setTimeout(() => request.destroy(new OllamaContextError("TIMEOUT", "The local Ollama operation exceeded its deadline.")), generation ? this.timeoutMs : 15_000);
				const refuse = (code: string, message: string) => request.destroy(new OllamaContextError(code, message));
				request.once("error", reject);
				request.once("close", () => clearTimeout(timer));
				request.once("response", (response) => {
					entry.status = response.statusCode ?? null;
					if (!entry.status || entry.status < 200 || entry.status >= 300) {
						refuse(entry.status && entry.status >= 300 && entry.status < 400 ? "REDIRECT_REFUSED" : "HTTP_ERROR", "Local Ollama returned a non-success status; redirects are refused and response text is not retained."); return;
					}
					if (Number(response.headers["content-length"]) > CONTEXT_BODY_LIMIT) { refuse("RESPONSE_TOO_LARGE", "The Ollama response exceeds 4 MiB."); return; }
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => {
						entry.bodyBytes += chunk.byteLength;
						if (entry.bodyBytes > CONTEXT_BODY_LIMIT) { refuse("RESPONSE_TOO_LARGE", "The Ollama response exceeds 4 MiB."); return; }
						chunks.push(chunk);
					});
					response.once("error", reject);
					response.once("end", () => resolve(Buffer.concat(chunks)));
				});
				request.end(body ? JSON.stringify(body) : undefined);
			});
			let value: unknown;
			try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
			catch { return fail("INVALID_RESPONSE", "Ollama returned invalid UTF-8 or JSON."); }
			if (!record(value)) fail("INVALID_RESPONSE", "Expected a JSON object from Ollama.");
			if (value.error !== undefined) fail("OLLAMA_ERROR", "Ollama reported an error; no untrusted error text is retained.");
			return value;
		} catch (error) {
			if (error instanceof OllamaContextError) throw error;
			return fail("REQUEST_FAILED", "The local Ollama operation failed; no external endpoint was attempted.");
		} finally {
			entry.elapsedMs = Math.round(performance.now() - started);
		}
	}
	async model(id: string): Promise<LocalModelEvidence> {
		const tags = await this.json("/api/tags");
		if (!Array.isArray(tags.models)) return fail("INVALID_MODELS", "Ollama /api/tags did not return a model list.");
		const matches = tags.models.filter((item) => record(item) && (item.name === id || item.model === id));
		if (matches.length !== 1 || !record(matches[0])) return fail("MODEL_NOT_INSTALLED", "The exact model is not installed once in the local inventory; no pull is attempted.");
		noRemoteMetadata(matches[0]);
		return inspectLocalModel(id, matches[0], await this.json("/api/show", { model: id }));
	}
	async running(id: string): Promise<Json | undefined> {
		const value = await this.json("/api/ps");
		if (!Array.isArray(value.models)) return fail("INVALID_RUNNING_MODELS", "Ollama /api/ps did not return a model list.");
		return value.models.find((item): item is Json => record(item) && (item.name === id || item.model === id));
	}
}

interface GenerationEvidence {
	promptBytes: number;
	promptSha256: string;
	promptTokens: number | null;
	outputTokens: number | null;
	promptTokensPerSecond: number | null;
	outputTokensPerSecond: number | null;
	loadMs: number | null;
	totalMs: number | null;
	answer: string;
	done: boolean;
}
function generationEvidence(reply: Json, prompt: string): GenerationEvidence {
	noRemoteMetadata(reply);
	const message = record(reply.message) ? reply.message : {};
	const rate = (count: unknown, duration: unknown) => finite(count) && finite(duration) && duration > 0 ? Math.round(count / (duration / 1e9) * 100) / 100 : null;
	return {
		promptBytes: Buffer.byteLength(prompt), promptSha256: sha(prompt), promptTokens: integer(reply.prompt_eval_count) ? reply.prompt_eval_count : null,
		outputTokens: finite(reply.eval_count) ? reply.eval_count : null,
		promptTokensPerSecond: rate(reply.prompt_eval_count, reply.prompt_eval_duration), outputTokensPerSecond: rate(reply.eval_count, reply.eval_duration),
		loadMs: finite(reply.load_duration) ? reply.load_duration / 1e6 : null, totalMs: finite(reply.total_duration) ? reply.total_duration / 1e6 : null,
		answer: typeof message.content === "string" ? message.content.slice(0, 4096) : "", done: reply.done === true,
	};
}
export function buildContextPrompt(characters: number, expected: { begin: string; middle: string; end: string }): string {
	const lines: string[] = [];
	let length = 0, index = 0;
	while (length < characters) {
		const line = `Record ${index}: ${sha(`school-context-filler-${index}`).slice(0, 12)}; archive note on fields, colours, stone, water and ordinary workshop supplies.\n`;
		lines.push(line); length += line.length; index++;
	}
	const halfway = Math.floor(lines.length / 2);
	return `Read this archive. Return only JSON with the exact values of keys begin, middle, and end from the three CHECKPOINT lines.\nCHECKPOINT begin=${expected.begin}\n${lines.slice(0, halfway).join("")}CHECKPOINT middle=${expected.middle}\n${lines.slice(halfway).join("")}CHECKPOINT end=${expected.end}\nReturn the three checkpoint values as JSON now.`;
}
export function checkContextAnswer(answer: string, expected: { begin: string; middle: string; end: string }): boolean {
	try { const value: unknown = JSON.parse(answer.trim()); return record(value) && Object.keys(value).length === 3 && Object.entries(expected).every(([key, item]) => value[key] === item); }
	catch { return false; }
}

export interface ContextCandidateResult {
	context: number;
	model: string;
	profile: "NOT_CREATED" | "CREATED" | "REUSED";
	state: "PENDING" | "PREPARED" | "PASSED" | "FAILED" | "SKIPPED";
	observation: Observation;
	allocation: { context: number; sizeBytes: number; vramBytes: number; residencyFraction: number; reportedBy: "OLLAMA_API_PS" } | null;
	calibration?: GenerationEvidence;
	probe?: GenerationEvidence;
	quality: { check: "THREE_CHECKPOINT_EXACT_MATCH"; expected?: { begin: string; middle: string; end: string }; passed: boolean | null; testedContextFraction: number | null; coverage: "NOT_TESTED" | "INSUFFICIENT" | "MEASURED_SPAN" };
	memory?: MemorySample;
	applicationPin?: { provider: "custom"; id: string; context: number; maxTokens: number };
	cleanup?: "UNLOADED_OWN_PROFILE" | "IDLE_EXPIRY_OBSERVED" | "PRESERVED_BUSY_OR_CHANGED" | "UNCONFIRMED";
	error?: { code: string; message: string };
}
export interface ContextProbeReport {
	version: 1; kind: "school-local-context"; mode: Mode;
	startedAt: string; finishedAt: string | null;
	host: { hostname: string; platform: string; node: string };
	endpoint: string;
	ollamaVersion?: string;
	model?: LocalModelEvidence;
	memoryBefore?: MemorySample;
	candidates: ContextCandidateResult[];
	requests: RequestEvidence[];
	outcome: "PENDING" | "PASSED" | "PARTIAL" | "FAILED";
	observation: Observation;
	largestPassingContext: number | null;
	recommendedProfile: string | null;
	recommendationBasis: string;
	settingsChanged: false;
	qualification: "SYNTHETIC_SPAN_ONLY_NOT_FULL_APPLICATION_OR_PEAK_MEMORY";
	error?: { code: string; message: string };
}
const errorEvidence = (error: unknown) => error instanceof OllamaContextError ? { code: error.code, message: error.message } : { code: "PROBE_FAILED", message: "The context operation could not complete." };

export async function probeOllamaContexts(options: {
	model: string; endpoint?: string; mode?: Mode; contexts?: readonly number[]; timeoutMs?: number;
	onProgress?: (report: ContextProbeReport, message: string) => void;
	/** Tests inject memory observations; normal execution samples the local machine. */
	memory?: () => Promise<MemorySample>;
}): Promise<ContextProbeReport> {
	const endpoint = localOllamaUrl(options.endpoint ?? "http://127.0.0.1:11434"), id = modelId(options.model);
	const contexts = contextCandidates(options.contexts ?? DEFAULT_CONTEXTS), mode = options.mode ?? "inspect", timeout = options.timeoutMs ?? 300_000;
	if (!["inspect", "prepare", "run"].includes(mode) || !integer(timeout) || timeout < 1_000 || timeout > 1_800_000) return fail("INVALID_OPTIONS", "Mode must be inspect, prepare, or run; timeout-ms must be 1000 through 1800000.");
	const report: ContextProbeReport = {
		version: 1, kind: "school-local-context", mode, startedAt: new Date().toISOString(), finishedAt: null,
		host: { hostname: hostname(), platform: process.platform, node: process.version }, endpoint, candidates: [], requests: [],
		outcome: "PENDING", observation: "ABSENT", largestPassingContext: null, recommendedProfile: null,
		recommendationBasis: "No inference or memory-fit claim has been established.", settingsChanged: false,
		qualification: "SYNTHETIC_SPAN_ONLY_NOT_FULL_APPLICATION_OR_PEAK_MEMORY",
	};
	const progress = (message: string) => options.onProgress?.(report, message);
	const client = new LocalClient(endpoint, timeout, report.requests), memory = options.memory ?? sampleLocalMemory;
	let releaseLock: (() => void) | undefined;
	try {
		if (mode !== "inspect") releaseLock = acquireProbeLock(endpoint);
		progress("Inspecting installed local weights");
		const source = await client.model(id); report.model = source; report.observation = "INSUFFICIENT";
		const version = await client.json("/api/version");
		if (typeof version.version === "string") report.ollamaVersion = version.version;
		report.memoryBefore = await memory();
		report.candidates = contexts.map((context) => ({ context, model: `school-local-${source.configurationDigest.slice(0, 12)}-ctx${context}:latest`, profile: "NOT_CREATED", state: "PENDING", observation: "ABSENT", allocation: null, quality: { check: "THREE_CHECKPOINT_EXACT_MATCH", passed: null, testedContextFraction: null, coverage: "NOT_TESTED" } }));
		if (mode === "inspect") {
			for (const candidate of report.candidates) candidate.state = "SKIPPED";
			report.outcome = "PASSED"; report.observation = "SUFFICIENT";
			report.recommendationBasis = "Installed local weights were identified. No aliases were created and no context was allocated or tested.";
			return report;
		}
		let stopped = false;
		for (const candidate of report.candidates) {
			if (stopped) { candidate.state = "SKIPPED"; continue; }
			let mayUnload = false;
			let admittedProfile: LocalModelEvidence | undefined;
			try {
				if (!source.nativeContext) fail("NATIVE_CONTEXT_UNKNOWN", "The model's native context limit was not reported; no larger allocation is attempted.");
				if (candidate.context > source.nativeContext) fail("EXCEEDS_NATIVE_CONTEXT", "The requested context exceeds the model's reported native context; no RoPE change is attempted.");
				progress(`Preparing ${candidate.context} token profile`);
				const current = await client.model(id);
				if (current.manifestDigest !== source.manifestDigest || current.configurationDigest !== source.configurationDigest) fail("SOURCE_CHANGED", "The source model changed during inspection; no candidate is created from a changed source.");
				let profile: LocalModelEvidence | undefined;
				try { profile = await client.model(candidate.model); }
				catch (error) { if (!(error instanceof OllamaContextError) || error.code !== "MODEL_NOT_INSTALLED") throw error; }
				if (profile) candidate.profile = "REUSED";
				else {
					await client.json("/api/create", { model: candidate.model, from: id, parameters: { num_ctx: candidate.context }, stream: false }, true);
					candidate.profile = "CREATED";
					profile = await client.model(candidate.model);
				}
				if (profile.configurationDigest !== source.configurationDigest || profile.configuredContext !== candidate.context) fail("PROFILE_CONFLICT", "The profile does not preserve the selected weights/configuration and requested context; existing profiles are not overwritten.");
				admittedProfile = profile;
				candidate.state = "PREPARED"; candidate.observation = "SUFFICIENT";
				if (mode === "prepare") { progress(`Prepared ${candidate.context} token profile without inference`); continue; }
				if (await client.running(candidate.model)) fail("PROFILE_BUSY", "The target profile is already loaded, possibly for another session; no probe or unload was attempted.");
				const generate = async (prompt: string) => {
					const dispatch = await client.model(candidate.model);
					if (dispatch.manifestDigest !== profile.manifestDigest || dispatch.configurationDigest !== source.configurationDigest || dispatch.configuredContext !== candidate.context) fail("PROFILE_CHANGED", "The local profile changed before generation.");
					mayUnload = true;
					return generationEvidence(await client.json("/api/chat", {
						model: candidate.model, messages: [{ role: "user", content: prompt }], stream: false, think: false, format: "json", keep_alive: candidate.profile === "REUSED" ? "10s" : "5m",
						options: { num_predict: 256, temperature: 0, seed: 7 },
					}, true), prompt);
				};
				progress(`Calibrating token density at ${candidate.context}`);
				const calibrationKeys = { begin: randomBytes(6).toString("hex"), middle: randomBytes(6).toString("hex"), end: randomBytes(6).toString("hex") };
				const calibrationPrompt = buildContextPrompt(4_096, calibrationKeys);
				candidate.calibration = await generate(calibrationPrompt);
				if (!candidate.calibration.promptTokens || !candidate.calibration.done) fail("TOKEN_COUNT_ABSENT", "Calibration did not produce a completed response and usable prompt token count.");
				const targetTokens = Math.floor(candidate.context * 0.75), characters = Math.min(3_000_000, Math.max(512, Math.floor(calibrationPrompt.length / candidate.calibration.promptTokens * targetTokens) - 512));
				const keys = { begin: randomBytes(12).toString("hex"), middle: randomBytes(12).toString("hex"), end: randomBytes(12).toString("hex") };
				candidate.quality.expected = keys;
				progress(`Checking beginning, middle and end near ${targetTokens} input tokens`);
				candidate.probe = await generate(buildContextPrompt(characters, keys));
				const currentProfile = await client.model(candidate.model);
				if (currentProfile.manifestDigest !== profile.manifestDigest || currentProfile.configurationDigest !== source.configurationDigest || currentProfile.configuredContext !== candidate.context) fail("PROFILE_CHANGED", "The tested profile changed during generation; its allocation is not qualified.");
				const running = await client.running(candidate.model);
				if (!record(running)) fail("ALLOCATION_UNOBSERVED", "The tested profile was not present in the running-model response.");
				noRemoteMetadata(running);
				if (typeof running.digest !== "string" || normalizedDigest(running.digest) !== normalizedDigest(profile.manifestDigest)) fail("RUNNING_MODEL_CHANGED", "The running model digest does not match the inspected profile.");
				if (!integer(running.context_length) || !integer(running.size) || !finite(running.size_vram)) fail("ALLOCATION_UNOBSERVED", "The running-model response lacks context or memory accounting.");
				candidate.allocation = { context: running.context_length, sizeBytes: running.size, vramBytes: running.size_vram, residencyFraction: Math.min(1, running.size_vram / running.size), reportedBy: "OLLAMA_API_PS" };
				candidate.memory = await memory();
				candidate.quality.passed = candidate.probe.done && checkContextAnswer(candidate.probe.answer, keys);
				candidate.quality.testedContextFraction = candidate.probe.promptTokens ? candidate.probe.promptTokens / candidate.context : null;
				candidate.quality.coverage = candidate.quality.testedContextFraction !== null && candidate.quality.testedContextFraction >= 0.6 && candidate.quality.testedContextFraction <= 0.9 ? "MEASURED_SPAN" : "INSUFFICIENT";
				if (candidate.allocation.context < candidate.context) fail("ALLOCATION_TOO_SMALL", "Ollama allocated less context than requested.");
				if (!candidate.quality.passed) fail("CHECKPOINT_MISMATCH", "The model did not return all three checkpoint values exactly.");
				if (candidate.quality.coverage !== "MEASURED_SPAN") fail("SPAN_UNQUALIFIED", "Actual prompt tokens fell outside 60–90% of the requested window; the whole candidate is not qualified by this probe.");
				candidate.state = "PASSED"; candidate.observation = "SUFFICIENT";
				candidate.applicationPin = { provider: "custom", id: candidate.model, context: candidate.context, maxTokens: Math.min(4_096, Math.floor(candidate.context / 4)) };
				progress(`Passed ${candidate.context} profile over ${candidate.probe.promptTokens} measured input tokens`);
			} catch (error) {
				candidate.state = "FAILED"; candidate.error = errorEvidence(error);
				candidate.observation = candidate.probe || candidate.profile !== "NOT_CREATED" ? "INSUFFICIENT" : "ABSENT";
				stopped = true; progress(`${candidate.context} failed: ${candidate.error.code}; larger candidates will be skipped`);
			} finally {
				if (mayUnload && admittedProfile) {
					try {
						if (candidate.profile === "REUSED") {
							// Existing aliases may belong to School. Never explicitly unload them.
							// Wait for our short keep_alive to expire before measuring another window.
							progress(`Waiting for reused ${candidate.context} profile to become idle`);
							const until = performance.now() + 20_000;
							while (await client.running(candidate.model)) {
								if (performance.now() >= until) { candidate.cleanup = "PRESERVED_BUSY_OR_CHANGED"; stopped = true; break; }
								await new Promise((resolve) => setTimeout(resolve, 250));
							}
							candidate.cleanup ??= "IDLE_EXPIRY_OBSERVED";
						} else {
							const cleanup = await client.model(candidate.model), loaded = await client.running(candidate.model);
							if (!loaded) candidate.cleanup = "IDLE_EXPIRY_OBSERVED";
							else if (cleanup.manifestDigest === admittedProfile.manifestDigest && cleanup.configurationDigest === source.configurationDigest && cleanup.configuredContext === candidate.context && typeof loaded.digest === "string" && normalizedDigest(loaded.digest) === normalizedDigest(admittedProfile.manifestDigest) && loaded.context_length === candidate.context) {
								await client.json("/api/generate", { model: candidate.model, keep_alive: 0, stream: false }, true);
								candidate.cleanup = await client.running(candidate.model) ? "UNCONFIRMED" : "UNLOADED_OWN_PROFILE";
								if (candidate.cleanup === "UNCONFIRMED") stopped = true;
							} else { candidate.cleanup = "PRESERVED_BUSY_OR_CHANGED"; stopped = true; }
						}
					} catch { candidate.cleanup = "UNCONFIRMED"; stopped = true; }
					if (candidate.cleanup === "PRESERVED_BUSY_OR_CHANGED" || candidate.cleanup === "UNCONFIRMED") delete candidate.applicationPin;
				}
			}
		}
		const passed = report.candidates.filter((candidate) => candidate.state === "PASSED");
		report.largestPassingContext = passed.at(-1)?.context ?? null;
		const comfortable = passed.filter((candidate) => candidate.applicationPin && candidate.allocation && candidate.allocation.residencyFraction >= 0.98 && candidate.memory?.gpus?.length === 1 && candidate.memory.gpus[0]!.freeMiB >= 1_024 && candidate.memory.ram.freeBytes >= 2 * 1024 ** 3);
		report.recommendedProfile = comfortable.at(-1)?.model ?? null;
		report.outcome = report.candidates.every((candidate) => candidate.state === "PASSED" || candidate.state === "PREPARED") ? "PASSED" : passed.length ? "PARTIAL" : "FAILED";
		report.observation = mode === "prepare" && report.outcome === "PASSED" || passed.length ? "SUFFICIENT" : "INSUFFICIENT";
		report.recommendationBasis = mode === "prepare" ? "Profiles were prepared without loading or generation. No memory-fit claim is made."
			: report.recommendedProfile ? "Largest passing synthetic-span candidate with at least 98% server-reported GPU residency, a single sampled GPU with 1 GiB free, and 2 GiB sampled free RAM. Snapshots are not peak measurements; verify a real School conversation before adoption."
				: "No candidate met both the synthetic-span checks and observed residency/headroom criteria. Inspect per-candidate evidence; absent telemetry is not treated as a pass.";
	} catch (error) { report.outcome = "FAILED"; report.error = errorEvidence(error); report.observation = report.requests.some((entry) => entry.status !== null) ? "INSUFFICIENT" : "ABSENT"; }
	finally {
		try { releaseLock?.(); } catch { /* A retained lock requires manual inspection before another run. */ }
		report.finishedAt = new Date().toISOString(); progress(`Context experiment finished: ${report.outcome}`);
	}
	return report;
}
