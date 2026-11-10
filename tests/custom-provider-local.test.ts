import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "school-local-provider-"));
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
process.env = { ...originalEnv, NODE_ENV: "test", LH_DATA_DIR: scratch, LH_AUTH_FILE: path.join(scratch, "auth.json"), LH_IGNORE_ENV_KEYS: "1" };
const { customProviderGet, customProviderMutation } = await import("../src/server/custom-provider-http.ts");
const { installCustomProviderSource } = await import("../src/server/custom-provider.ts");
const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");
const { readSettings, writeSettings, readLocalInferencePolicy } = await import("../src/store/settings.ts");
const { modelCatalog } = await import("../src/server/model-catalog.ts");
const { saveKey } = await import("../src/server/keys.ts");
installCustomProviderSource();
const base = "http://127.0.0.1:11434/v1";
const id = "qwen-64k:latest";
let generations: string[];
let remoteAlias: boolean;
const snapshot = () => customProviderGet(new Request("http://localhost/api/custom-provider"));
const mutate = (payload: object, method = "POST") => customProviderMutation(new Request("http://localhost/api/custom-provider", {
	method, headers: { origin: "http://localhost", "content-type": "application/json", "if-match": snapshot().headers.get("etag")! }, body: JSON.stringify(payload),
}));
const connect = () => mutate({ baseUrl: base, authMode: "keyless", localOnly: true });

beforeEach(() => {
	fs.writeFileSync(path.join(scratch, "settings.json"), JSON.stringify({ version: 1 }));
	fs.writeFileSync(path.join(scratch, "auth.json"), "{}");
	generations = []; remoteAlias = false;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.redirect, "manual");
		assert.ok(request.url.startsWith("http://127.0.0.1:11434/"), "no paid/external transport is available in this test");
		if (request.url.endsWith("/api/tags")) return Response.json({ models: [{ name: id, size: 12_000_000_000 }] });
		if (request.url.endsWith("/api/ps")) return Response.json({ models: [{ name: id, context_length: 65536 }] });
		if (request.url.endsWith("/api/show")) return Response.json({
			...(remoteAlias ? { remote_model: "cloud" } : {}),
			details: { format: "gguf" }, parameters: "num_ctx 65536", capabilities: ["completion"],
			model_info: { "general.architecture": "qwen35", "qwen35.context_length": 262144 },
		});
		if (request.url.endsWith("/chat/completions")) {
			assert.equal(request.headers.get("authorization"), null);
			generations.push(request.url);
			return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "local fixture" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		}
		throw new Error("Unexpected local test route");
	};
});
after(() => { globalThis.fetch = originalFetch; process.env = originalEnv; fs.rmSync(scratch, { recursive: true, force: true }); });

test("connect persists native observations and resolves the 64k profile rather than 8k or native maximum", async () => {
	assert.equal(saveKey("OPENAI_API_KEY", "synthetic-never-sent").ok, true);
	assert.equal((await connect()).status, 200);
	const stored = readSettings()!.customProvider!;
	assert.equal(stored.localOnly, true);
	assert.equal(stored.models![0]!.context, 65536);
	assert.equal(stored.models![0]!.ollama!.nativeContext, 262144);
	assert.equal(piEngineForSpec({ provider: "custom", id }).model.contextWindow, 65536);
	assert.equal((await snapshot().json()).localOnly, true);
	assert.deepEqual(modelCatalog().models.map((model) => `${model.provider}:${model.id}`), [`custom:${id}`], "saved API keys do not expose paid model choices while local-only mode is active");
	assert.equal((await mutate({ overrides: { [id]: { context: 131072 } } }, "PATCH")).status, 400);
});

test("real injected source allows verified local dispatch and blocks builtin or changed cloud aliases", async () => {
	assert.equal((await connect()).status, 200);
	const context = normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 0 }] });
	const engine = piEngineForSpec({ provider: "custom", id });
	assert.equal((await engine.streamFn(engine.model, context, {}).result()).stopReason, "stop");
	const builtin = piModels().getModels("openai")[0]!;
	const paid = piEngineForSpec({ provider: builtin.provider, id: builtin.id });
	assert.equal((await paid.streamFn(paid.model, context, {}).result()).stopReason, "error");
	remoteAlias = true;
	assert.equal((await engine.streamFn(engine.model, context, {}).result()).stopReason, "error");
	assert.equal(generations.length, 1);
});

test("disconnect preserves the local restriction so background routes cannot become paid", async () => {
	assert.equal((await connect()).status, 200);
	assert.equal((await mutate({}, "DELETE")).status, 200);
	assert.deepEqual(readSettings()!.customProvider, { localOnly: true });
	const builtin = piModels().getModels("openai")[0]!;
	const engine = piEngineForSpec({ provider: builtin.provider, id: builtin.id });
	const result = await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 0 }] }), {}).result();
	assert.equal(result.stopReason, "error"); assert.equal(generations.length, 0);
});

test("local-only connect rejects keyed or nonloopback destinations", async () => {
	assert.equal((await mutate({ baseUrl: base, authMode: "apiKey", key: "synthetic", localOnly: true })).status, 400);
	assert.equal((await mutate({ baseUrl: "https://example.invalid/v1", authMode: "keyless", localOnly: true })).status, 400);
	assert.equal(readSettings()!.customProvider, undefined);
});

test("corrupt settings block a previously created API engine and unrelated repairs preserve the restriction", async () => {
	const builtin = piModels().getModels("openai")[0]!;
	const engine = piEngineForSpec({ provider: builtin.provider, id: builtin.id });
	fs.writeFileSync(path.join(scratch, "settings.json"), "{broken");
	assert.equal(readLocalInferencePolicy().ok, false);
	assert.equal((await snapshot().json()).localOnly, true);
	assert.deepEqual(modelCatalog().models, []);
	const result = await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 0 }] }), {}).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /policy cannot be read reliably/);
	assert.equal(generations.length, 0);
	writeSettings({ version: 1, appearance: {} });
	assert.deepEqual(readLocalInferencePolicy(), { ok: true, localOnly: true });
});

test("an explicit reconnect can repair corrupt policy with either local-only or ordinary mode", async () => {
	fs.writeFileSync(path.join(scratch, "settings.json"), "{broken");
	assert.equal((await connect()).status, 200);
	assert.deepEqual(readLocalInferencePolicy(), { ok: true, localOnly: true });
	fs.writeFileSync(path.join(scratch, "settings.json"), "{broken again");
	const nativeFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		if (request.url === `${base}/models`) return Response.json({ data: [{ id }] });
		return nativeFetch(input, init);
	};
	assert.equal((await mutate({ baseUrl: base, authMode: "keyless", localOnly: false })).status, 200);
	assert.deepEqual(readLocalInferencePolicy(), { ok: true, localOnly: false });
	assert.equal(generations.length, 0);
});

test("malformed policy is blocked while first boot remains compatible", () => {
	for (const customProvider of [null, [], "invalid", { localOnly: "false" }]) {
		fs.writeFileSync(path.join(scratch, "settings.json"), JSON.stringify({ version: 1, customProvider }));
		assert.equal(readLocalInferencePolicy().ok, false);
		assert.equal(readSettings()?.customProvider?.localOnly, true);
	}
	fs.unlinkSync(path.join(scratch, "settings.json"));
	assert.deepEqual(readLocalInferencePolicy(), { ok: true, localOnly: false });
});
