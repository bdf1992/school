import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { authorizeLocalOllamaModel, discoverLocalOllamaModels, localOllamaOrigin } from "../src/server/ollama-local.ts";

const originalFetch = globalThis.fetch;
const base = "http://127.0.0.1:11434/v1";
const ids = ["qwen-16k:latest", "qwen-32k:latest", "qwen-64k:latest"];
const limits = [16384, 32768, 65536];
let requests: { url: string; body: Record<string, unknown> | undefined; authorization: string | null }[];
let remoteAlias: boolean;
let configured: boolean;
let redirectGeneration: boolean;
const rows = () => [...ids.map((name) => ({ name, size: 12_000_000_000, details: { format: "gguf" } })),
	{ name: "hidden-remote:latest", size: 123, remote_model: "paid-model", remote_host: "https://example.invalid" },
	{ name: "gpt-oss:120b-cloud", size: 123 }, { name: "nomic-embed-text:latest", size: 270_000_000 }];

beforeEach(() => {
	requests = []; remoteAlias = false; configured = true; redirectGeneration = false;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.redirect, "manual");
		assert.ok(request.url.startsWith("http://127.0.0.1:11434/"), "closed fake: never contact an external host");
		const body = request.method === "POST" ? await request.json() as Record<string, unknown> : undefined;
		requests.push({ url: request.url, body, authorization: request.headers.get("authorization") });
		if (request.url.endsWith("/api/tags")) return Response.json({ models: rows() });
		if (request.url.endsWith("/api/ps")) return Response.json({ models: [{ name: ids[0], context_length: 65536 }] });
		if (request.url.endsWith("/api/show")) {
			const index = ids.indexOf(String(body?.model));
			return Response.json({
				...(remoteAlias ? { remote_model: "changed-to-cloud" } : {}),
				details: { format: "gguf" }, model_info: { "general.architecture": "qwen35", "qwen35.context_length": 262144 },
				parameters: configured && index >= 0 ? `temperature 0.7\nnum_ctx ${limits[index]}\n` : "",
				capabilities: index >= 0 ? ["completion", "vision", "thinking"] : ["embedding"],
			});
		}
		if (request.url.endsWith("/v1/chat/completions")) return redirectGeneration
			? new Response(null, { status: 307, headers: { location: "https://example.invalid/paid" } }) : Response.json({ choices: [] });
		throw new Error(`Unexpected fake route: ${request.url}`);
	};
});
after(() => { globalThis.fetch = originalFetch; });

test("native discovery distinguishes configured, active, and native context and filters nonlocal/nonchat entries", async () => {
	const models = await discoverLocalOllamaModels(base);
	assert.deepEqual(models.map((model) => model.id), ids);
	assert.deepEqual(models.map((model) => model.context), limits);
	assert.equal(models[0]!.ollama!.activeContext, 65536);
	assert.equal(models[0]!.ollama!.configuredContext, 16384, "a previous wider native request cannot enlarge the next OpenAI request's profile");
	assert.equal(models[0]!.ollama!.nativeContext, 262144);
	assert.equal(models[0]!.image, true); assert.equal(models[0]!.reasoning, true);
	assert.ok(!requests.some((request) => request.body?.model === "hidden-remote:latest"));
	assert.ok(requests.every((request) => request.authorization === null));
});

test("unconfigured runtime never inherits the native or currently loaded window", async () => {
	configured = false;
	const models = await discoverLocalOllamaModels(base);
	assert.equal(models[0]!.context, undefined);
	assert.equal(models[0]!.ollama!.nativeContext, 262144);
	await assert.rejects(authorizeLocalOllamaModel(base, ids[0]!, 8192), /no explicit num_ctx/);
	assert.ok(!requests.some((request) => request.url.endsWith("/chat/completions")));
});

test("remote destinations, auth URLs, alternate paths and manual cloud IDs cannot bypass local discovery", async () => {
	for (const url of ["https://api.example.invalid/v1", "http://localhost.evil/v1", "http://user:secret@localhost/v1", "http://127.0.0.1:11434/proxy/v1", `${base}?x=1`]) {
		assert.throws(() => localOllamaOrigin(url), /Local Ollama/);
	}
	assert.equal(requests.length, 0);
	assert.equal(localOllamaOrigin("http://[::1]:11434/v1"), "http://[::1]:11434");
	await assert.rejects(discoverLocalOllamaModels(base, ["gpt-oss:120b-cloud"]), /cannot bypass/);
});

test("a formerly local alias that becomes remote is refused before generation", async () => {
	await discoverLocalOllamaModels(base);
	remoteAlias = true;
	await assert.rejects(authorizeLocalOllamaModel(base, ids[0]!, 16384), /not a verified local/);
	assert.ok(!requests.some((request) => request.url.endsWith("/chat/completions")));
});

test("budget pins cannot exceed the backend's configured context", async () => {
	await assert.rejects(authorizeLocalOllamaModel(base, ids[0]!, 65536), /exceeds.*16384/);
	assert.ok(!requests.some((request) => request.url.endsWith("/chat/completions")));
});

test("authorized transport checks final destination/model, strips auth, and refuses redirects", async () => {
	const policy = await authorizeLocalOllamaModel(base, ids[0]!, 16384);
	const options = { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer should-never-leave" }, body: JSON.stringify({ model: ids[0], messages: [] }) };
	await assert.rejects(policy.fetch("https://example.invalid/paid", options), /cannot change.*destination/);
	await assert.rejects(policy.fetch(`${base}/chat/completions`, { ...options, body: JSON.stringify({ model: "gpt-oss:120b-cloud" }) }), /cannot change.*model/);
	assert.ok(!requests.some((request) => request.url.endsWith("/chat/completions")));
	assert.equal((await policy.fetch(`${base}/chat/completions`, options)).status, 200);
	assert.equal(requests.at(-1)!.authorization, null);
	redirectGeneration = true;
	await assert.rejects(policy.fetch(`${base}/chat/completions`, options), /redirects are disabled/);
});

test("native metadata redirects fail without following them", async () => {
	let calls = 0;
	globalThis.fetch = async (_input, init) => { calls++; assert.equal(init?.redirect, "manual"); return new Response(null, { status: 302, headers: { location: "https://example.invalid/paid" } }); };
	await assert.rejects(discoverLocalOllamaModels(base), /inspection failed/);
	assert.equal(calls, 2, "only the two same-host metadata reads were attempted");
});
