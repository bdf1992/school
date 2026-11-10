/** Native Ollama protocol fakes only. No real model, GPU, cloud, or provider credentials. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
	CONTEXT_BODY_LIMIT, buildContextPrompt, checkContextAnswer, contextCandidates, localOllamaUrl, probeOllamaContexts,
	type MemorySample,
} from "../src/agent/ollama-context.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const source = "qwen38-27b-ctx8k:latest", weight = "ab".repeat(32);
type FakeModel = { context: number; weight: string; remote?: string; native?: number; format?: string; capabilities?: string[]; extraModelfile?: string; };
type FakeCall = { path: string; body: Record<string, unknown> | null; authorization: string | undefined; };
const snapshot = async (): Promise<MemorySample> => ({
	at: "2026-11-10T00:00:00.000Z", ram: { totalBytes: 32 * 1024 ** 3, freeBytes: 10 * 1024 ** 3 },
	gpus: [{ index: 0, name: "Synthetic test GPU", totalMiB: 16_384, usedMiB: 13_000, freeMiB: 3_384 }], gpuObservation: "SUFFICIENT", measurement: "SNAPSHOT_NOT_PEAK",
});
async function fakeOllama(t: TestContext, settings: { remoteTag?: boolean; remoteShow?: boolean; badAnswerAt?: number; allocationCap?: number; reportedPromptFraction?: number; stallChat?: boolean; oversizedTags?: boolean; redirectTags?: string; runningDigest?: string; replaceAfterProbe?: boolean; autoExpire?: boolean } = {}) {
	const calls: FakeCall[] = [], models = new Map<string, FakeModel>([[source, { context: 8_192, weight, native: 262_144 }]]);
	let loaded: string | undefined, generationActive = 0, maxGenerationActive = 0;
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : null;
		calls.push({ path: request.url ?? "", body, authorization: request.headers.authorization });
		const json = (value: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
		const id = typeof body?.model === "string" ? body.model : "", model = models.get(id);
		switch (request.url) {
			case "/api/tags":
				if (settings.redirectTags) { response.writeHead(307, { location: settings.redirectTags }); response.end(); return; }
				if (settings.oversizedTags) { response.writeHead(200, { "content-length": CONTEXT_BODY_LIMIT + 1 }); response.end(); return; }
				return json({ models: [...models].map(([name, item]) => ({ name, model: name, size: 12_000_000_000, digest: digest(`${name}-${item.context}-${item.weight}`), ...(settings.remoteTag && name === source ? { remote_model: "hidden-hosted-model", remote_host: "https://paid.example" } : {}) })) });
			case "/api/show":
				if (!model) { response.writeHead(404); response.end(); return; }
				return json({ details: { format: model.format ?? "gguf", quantization_level: "Q3_K_S" }, capabilities: model.capabilities ?? ["completion"],
					modelfile: `FROM C:\\Users\\test\\.ollama\\models\\blobs\\sha256-${model.weight}\n${model.extraModelfile ?? ""}`,
					parameters: `temperature 0.7\nnum_ctx ${model.context}`, template: "unchanged template", system: "unchanged system",
					model_info: { "general.parameter_count": 27_000_000_000, "general.architecture": "qwen35", "qwen35.context_length": model.native },
					...(settings.remoteShow && id === source ? { remote_model: "hidden-hosted-model" } : {}) });
			case "/api/version": return json({ version: "test-only" });
			case "/api/create": {
				const base = models.get(String(body?.from)); assert.ok(base);
				assert.equal(body?.stream, false); assert.deepEqual(Object.keys(body!).sort(), ["from", "model", "parameters", "stream"]);
				models.set(id, { ...base, context: Number((body?.parameters as { num_ctx?: number })?.num_ctx) });
				return json({ status: "success" });
			}
			case "/api/chat": {
				assert.ok(model); generationActive++; maxGenerationActive = Math.max(maxGenerationActive, generationActive);
				if (settings.stallChat) { response.on("close", () => { generationActive--; }); return; }
				assert.equal(body?.think, false); assert.equal(body?.stream, false);
				assert.equal((body?.options as Record<string, unknown>).num_ctx, undefined, "probe must exercise stored alias allocation, not override it");
				const prompt = String((body?.messages as { content: string }[])[0]!.content);
				const expected = Object.fromEntries([...prompt.matchAll(/CHECKPOINT (begin|middle|end)=([a-f0-9]+)/g)].map((match) => [match[1], match[2]]));
				if (settings.badAnswerAt === model.context) expected.begin = "incorrect";
				loaded = id; generationActive--;
				if (settings.replaceAfterProbe && prompt.length > 6_000) model.weight = "cd".repeat(32);
				if (settings.autoExpire && body?.keep_alive === "10s") setTimeout(() => { if (loaded === id) loaded = undefined; }, 100).unref();
				return json({ model: id, done: true, message: { role: "assistant", content: JSON.stringify(expected) },
					prompt_eval_count: settings.reportedPromptFraction ? Math.floor(model.context * settings.reportedPromptFraction) : Math.round(prompt.length / 4),
					eval_count: 50, prompt_eval_duration: 2e9, eval_duration: 1e9, total_duration: 4e9, load_duration: 1e9 });
			}
			case "/api/ps": return json({ models: loaded ? [{ name: loaded, digest: settings.runningDigest ?? digest(`${loaded}-${models.get(loaded)!.context}-${models.get(loaded)!.weight}`), context_length: Math.min(models.get(loaded)!.context, settings.allocationCap ?? Infinity), size: 14_000_000_000, size_vram: 14_000_000_000 }] : [] });
			case "/api/generate": assert.equal(body?.keep_alive, 0); loaded = undefined; return json({ done: true });
			default: response.writeHead(404); response.end();
		}
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
	const address = server.address(); assert.ok(address && typeof address === "object");
	return { endpoint: `http://127.0.0.1:${address.port}`, calls, models, maximumParallel: () => maxGenerationActive, setLoaded: (id: string) => { loaded = id; } };
}

test("only canonical loopback root endpoints and bounded candidate sets are accepted", () => {
	assert.equal(localOllamaUrl("http://localhost:11434/"), "http://127.0.0.1:11434");
	assert.equal(localOllamaUrl("http://[::1]:11434"), "http://[::1]:11434");
	for (const url of ["https://ollama.com", "http://192.168.1.5:11434", "http://127.0.0.1:11434/v1", "http://secret@localhost:11434", "http://localhost:11434/?key=secret", "http://localhost.evil:11434"]) assert.throws(() => localOllamaUrl(url));
	assert.deepEqual(contextCandidates([65_536, 16_384, 32_768, 16_384]), [16_384, 32_768, 65_536]);
	for (const invalid of [[], [0], [1.1], [1_048_577], Array(9).fill(8_192)]) assert.throws(() => contextCandidates(invalid));
});
test("inspect identifies local weights without loading, creating, resolving credentials, or inferring fit", async (t) => {
	const server = await fakeOllama(t);
	const report = await probeOllamaContexts({ model: source, endpoint: server.endpoint, memory: snapshot });
	assert.equal(report.outcome, "PASSED"); assert.equal(report.model?.weightDigest, weight); assert.equal(report.model?.nativeContext, 262_144);
	assert.equal(report.largestPassingContext, null); assert.equal(report.recommendedProfile, null); assert.equal(report.settingsChanged, false);
	assert.ok(report.candidates.every((candidate) => candidate.state === "SKIPPED" && candidate.profile === "NOT_CREATED"));
	assert.deepEqual(server.calls.map((call) => call.path), ["/api/tags", "/api/show", "/api/version"]);
	assert.ok(server.calls.every((call) => !call.authorization));
});
test("cloud names and hidden upstream aliases are refused before creation or generation", async (t) => {
	await assert.rejects(probeOllamaContexts({ model: "gpt-oss:120b-cloud", mode: "run", memory: snapshot }), /Cloud model/);
	for (const settings of [{ remoteTag: true }, { remoteShow: true }]) {
		const server = await fakeOllama(t, settings), report = await probeOllamaContexts({ model: source, endpoint: server.endpoint, mode: "run", memory: snapshot });
		assert.equal(report.outcome, "FAILED"); assert.equal(report.error?.code, "REMOTE_MODEL_REFUSED");
		assert.ok(server.calls.every((call) => ["/api/tags", "/api/show"].includes(call.path)));
	}
});
test("a loopback endpoint redirect cannot dispatch to its destination", async (t) => {
	const destination = await fakeOllama(t), redirect = await fakeOllama(t, { redirectTags: `${destination.endpoint}/api/tags` });
	const report = await probeOllamaContexts({ model: source, endpoint: redirect.endpoint, mode: "run", memory: snapshot });
	assert.equal(report.error?.code, "REDIRECT_REFUSED"); assert.equal(destination.calls.length, 0);
});
test("positive local weight and completion evidence is required; no model is downloaded", async (t) => {
	for (const change of [{ weight: "remote-model" }, { capabilities: ["embedding"] }, { format: "unknown" }]) {
		const server = await fakeOllama(t); Object.assign(server.models.get(source)!, change);
		const report = await probeOllamaContexts({ model: source, endpoint: server.endpoint, mode: "run", memory: snapshot });
		assert.equal(report.outcome, "FAILED"); assert.ok(["LOCAL_WEIGHTS_UNCONFIRMED", "NOT_CHAT_MODEL"].includes(report.error!.code));
		assert.ok(!server.calls.some((call) => /create|chat|pull/.test(call.path)));
	}
});
test("prepare reuses existing weights and exact profiles, preserving any conflicting profile", async (t) => {
	const server = await fakeOllama(t);
	const first = await probeOllamaContexts({ model: source, endpoint: server.endpoint, mode: "prepare", contexts: [16_384, 32_768, 65_536], memory: snapshot });
	assert.equal(first.outcome, "PASSED"); assert.ok(first.candidates.every((candidate) => candidate.profile === "CREATED" && candidate.state === "PREPARED"));
	assert.ok(!server.calls.some((call) => /chat|generate|pull/.test(call.path)));
	const second = await probeOllamaContexts({ model: source, endpoint: server.endpoint, mode: "prepare", contexts: [16_384], memory: snapshot });
	assert.equal(second.candidates[0]?.profile, "REUSED");
	const existing = server.models.get(first.candidates[0]!.model)!; existing.context = 8_192;
	const beforeCreates = server.calls.filter((call) => call.path === "/api/create").length;
	const conflict = await probeOllamaContexts({ model: source, endpoint: server.endpoint, mode: "prepare", contexts: [16_384], memory: snapshot });
	assert.equal(conflict.candidates[0]?.error?.code, "PROFILE_CONFLICT");
	assert.equal(server.calls.filter((call) => call.path === "/api/create").length, beforeCreates); assert.equal(existing.context, 8_192);
});
test("preloaded aliases are preserved and reused idle aliases expire without explicit unload", async (t) => {
	const busy = await fakeOllama(t), prepared = await probeOllamaContexts({ model: source, endpoint: busy.endpoint, mode: "prepare", contexts: [16_384], memory: snapshot });
	busy.setLoaded(prepared.candidates[0]!.model);
	const refused = await probeOllamaContexts({ model: source, endpoint: busy.endpoint, mode: "run", contexts: [16_384], memory: snapshot });
	assert.equal(refused.candidates[0]?.error?.code, "PROFILE_BUSY"); assert.ok(!busy.calls.some((call) => /chat|generate/.test(call.path)));
	const idle = await fakeOllama(t, { autoExpire: true });
	await probeOllamaContexts({ model: source, endpoint: idle.endpoint, mode: "prepare", contexts: [16_384], memory: snapshot });
	const measured = await probeOllamaContexts({ model: source, endpoint: idle.endpoint, mode: "run", contexts: [16_384], memory: snapshot });
	assert.equal(measured.outcome, "PASSED"); assert.equal(measured.candidates[0]?.cleanup, "IDLE_EXPIRY_OBSERVED");
	assert.ok(!idle.calls.some((call) => call.path === "/api/generate"));
});
test("a concurrent probe is refused while the endpoint lock is held", async (t) => {
	const server = await fakeOllama(t, { stallChat: true });
	const first = probeOllamaContexts({ model: source, endpoint: server.endpoint, mode: "run", contexts: [16_384], timeoutMs: 1_000, memory: snapshot });
	while (!server.calls.some((call) => call.path === "/api/chat")) await new Promise((resolve) => setTimeout(resolve, 5));
	const before = server.calls.length;
	const second = await probeOllamaContexts({ model: source, endpoint: server.endpoint, mode: "prepare", contexts: [32_768], memory: snapshot });
	assert.equal(second.error?.code, "PROBE_BUSY"); assert.equal(server.calls.length, before);
	await first;
	assert.equal((await probeOllamaContexts({ model: source, endpoint: server.endpoint, mode: "prepare", contexts: [32_768], memory: snapshot })).outcome, "PASSED");
});
test("adapter and baked-message differences cannot reuse a supposedly matching profile", async (t) => {
	for (const directive of ['ADAPTER /private/other-adapter.gguf\n', 'MESSAGE user "different baked history"\n']) {
		const server = await fakeOllama(t), prepared = await probeOllamaContexts({ model: source, endpoint: server.endpoint, mode: "prepare", contexts: [16_384], memory: snapshot });
		server.models.get(prepared.candidates[0]!.model)!.extraModelfile = directive;
		const conflict = await probeOllamaContexts({ model: source, endpoint: server.endpoint, mode: "run", contexts: [16_384], memory: snapshot });
		assert.equal(conflict.candidates[0]?.error?.code, "PROFILE_CONFLICT"); assert.ok(!server.calls.some((call) => /chat|generate/.test(call.path)));
	}
});
test("changed aliases and mismatched running manifests are unqualified and not unloaded", async (t) => {
	for (const [settings, code] of [[{ runningDigest: "cd".repeat(32) }, "RUNNING_MODEL_CHANGED"], [{ replaceAfterProbe: true }, "PROFILE_CHANGED"]] as const) {
		const server = await fakeOllama(t, settings);
		const report = await probeOllamaContexts({ model: source, endpoint: server.endpoint, mode: "run", contexts: [16_384], memory: snapshot });
		assert.equal(report.candidates[0]?.error?.code, code); assert.equal(report.recommendedProfile, null);
		assert.equal(report.candidates[0]?.cleanup, "PRESERVED_BUSY_OR_CHANGED"); assert.ok(!server.calls.some((call) => call.path === "/api/generate"));
	}
});
test("16k, 32k and 64k run sequentially and expose reproducible span, allocation and memory evidence", async (t) => {
	const server = await fakeOllama(t), updates: string[] = [];
	const report = await probeOllamaContexts({ model: source, endpoint: server.endpoint, mode: "run", memory: snapshot, onProgress: (_report, message) => updates.push(message) });
	assert.equal(report.outcome, "PASSED"); assert.equal(report.largestPassingContext, 65_536); assert.equal(server.maximumParallel(), 1);
	assert.equal(report.recommendedProfile, report.candidates[2]?.model);
	for (const result of report.candidates) {
		assert.equal(result.state, "PASSED"); assert.equal(result.allocation?.context, result.context);
		assert.equal(result.quality.coverage, "MEASURED_SPAN"); assert.equal(result.probe?.outputTokensPerSecond, 50);
		assert.deepEqual(JSON.parse(result.probe!.answer), result.quality.expected);
		assert.ok(result.probe!.promptTokens! >= result.context * 0.6 && result.probe!.promptTokens! <= result.context * 0.9);
		assert.equal(result.memory?.measurement, "SNAPSHOT_NOT_PEAK"); assert.equal(result.applicationPin?.context, result.context);
	}
	assert.equal(server.calls.filter((call) => call.path === "/api/chat").length, 6);
	assert.ok(updates.some((item) => item.includes("65536"))); assert.ok(!server.calls.some((call) => /pull|push|delete/.test(call.path)));
});
test("a failed long-context answer preserves smaller passes and stops larger allocations", async (t) => {
	const server = await fakeOllama(t, { badAnswerAt: 32_768 });
	const report = await probeOllamaContexts({ model: source, endpoint: server.endpoint, mode: "run", memory: snapshot });
	assert.equal(report.outcome, "PARTIAL"); assert.equal(report.largestPassingContext, 16_384);
	assert.equal(report.candidates[1]?.error?.code, "CHECKPOINT_MISMATCH"); assert.equal(report.candidates[2]?.state, "SKIPPED");
	assert.ok(!server.calls.some((call) => call.path === "/api/create" && (call.body?.parameters as { num_ctx: number }).num_ctx === 65_536));
});
test("allocation mismatch and inadequate actual prompt span cannot qualify a profile", async (t) => {
	for (const [settings, code] of [[{ allocationCap: 8_192 }, "ALLOCATION_TOO_SMALL"], [{ reportedPromptFraction: 0.1 }, "SPAN_UNQUALIFIED"]] as const) {
		const server = await fakeOllama(t, settings);
		const report = await probeOllamaContexts({ model: source, endpoint: server.endpoint, mode: "run", contexts: [16_384], memory: snapshot });
		assert.equal(report.outcome, "FAILED"); assert.equal(report.candidates[0]?.error?.code, code); assert.equal(report.recommendedProfile, null);
	}
});
test("absent GPU telemetry does not become a confident GPU-fit recommendation", async (t) => {
	const server = await fakeOllama(t);
	const report = await probeOllamaContexts({ model: source, endpoint: server.endpoint, mode: "run", contexts: [16_384], memory: async () => ({ ...await snapshot(), gpus: null, gpuObservation: "ABSENT" }) });
	assert.equal(report.outcome, "PASSED"); assert.equal(report.largestPassingContext, 16_384); assert.equal(report.recommendedProfile, null);
});
test("a displayed GPU with less than 1 GiB sampled headroom does not receive a recommendation", async (t) => {
	const server = await fakeOllama(t);
	const report = await probeOllamaContexts({ model: source, endpoint: server.endpoint, mode: "run", contexts: [16_384], memory: async () => {
		const value = await snapshot(); value.gpus![0]!.freeMiB = 512; return value;
	} });
	assert.equal(report.outcome, "PASSED"); assert.equal(report.largestPassingContext, 16_384); assert.equal(report.recommendedProfile, null);
});
test("native context limits, bounded bodies and stalled generation fail with retained evidence", async (t) => {
	const native = await fakeOllama(t); native.models.get(source)!.native = 8_192;
	const unsupported = await probeOllamaContexts({ model: source, endpoint: native.endpoint, mode: "run", contexts: [16_384], memory: snapshot });
	assert.equal(unsupported.candidates[0]?.error?.code, "EXCEEDS_NATIVE_CONTEXT"); assert.ok(!native.calls.some((call) => call.path === "/api/create"));
	const oversized = await fakeOllama(t, { oversizedTags: true });
	assert.equal((await probeOllamaContexts({ model: source, endpoint: oversized.endpoint, memory: snapshot })).error?.code, "RESPONSE_TOO_LARGE");
	const stalled = await fakeOllama(t, { stallChat: true });
	const timed = await probeOllamaContexts({ model: source, endpoint: stalled.endpoint, mode: "run", contexts: [16_384], timeoutMs: 1_000, memory: snapshot });
	assert.equal(timed.candidates[0]?.error?.code, "TIMEOUT"); assert.equal(timed.recommendedProfile, null);
});
test("the answer checker uses exact externally chosen checkpoint values", () => {
	const expected = { begin: "begin-value", middle: "middle-value", end: "end-value" }, prompt = buildContextPrompt(8_000, expected);
	assert.ok(prompt.indexOf("begin-value") < prompt.indexOf("middle-value") && prompt.indexOf("middle-value") < prompt.indexOf("end-value"));
	assert.equal(checkContextAnswer(JSON.stringify(expected), expected), true);
	for (const answer of [JSON.stringify({ ...expected, middle: "wrong" }), JSON.stringify({ ...expected, extra: true }), "Here is " + JSON.stringify(expected), JSON.stringify({ begin: "begin-value", end: "end-value" })]) assert.equal(checkContextAnswer(answer, expected), false);
});
function cli(args: string[]) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", "scripts/school-context.ts", ...args], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, NODE_ENV: "test" } });
		let stdout = "", stderr = "";
		child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
		child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}
test("CLI requires explicit run/output, protects occupied reports, and writes final refusal receipts", async (t) => {
	const root = mkdtempSync(path.join(tmpdir(), "school-context-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const server = await fakeOllama(t), output = path.join(root, "report.json");
	const noOutput = await cli(["--model", source, "--endpoint", server.endpoint, "--run"]);
	assert.equal(noOutput.code, 1); assert.equal(server.calls.length, 0);
	writeFileSync(output, "preserve this");
	const occupied = await cli(["--model", source, "--endpoint", server.endpoint, "--prepare", "--output", output]);
	assert.equal(occupied.code, 1); assert.equal(server.calls.length, 0); assert.equal(readFileSync(output, "utf8"), "preserve this");
	const failure = path.join(root, "refused.json"), denied = await cli(["--model", "gpt-oss:120b-cloud", "--endpoint", server.endpoint, "--run", "--output", failure]);
	assert.equal(denied.code, 1); assert.equal(server.calls.length, 0); assert.equal(JSON.parse(readFileSync(failure, "utf8")).outcome, "FAILED");
});
