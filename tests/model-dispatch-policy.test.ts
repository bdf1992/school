/** Production stream seams with a closed synthetic transport. No provider
 * credentials, model inference, or external network requests are used. */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createProvider, normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { configureProviderSource, piEngineForSpec, piModels, type ModelDispatchPolicy, type PiEngine } from "../src/agent/models.ts";
import { prepareSchoolConnectionEngine } from "../src/agent/school-connections.ts";
import type { SchoolParticipantBindingReceipt, SchoolParticipantState } from "../src/core/school-participants.ts";

const originalFetch = globalThis.fetch;
const baseUrl = "http://127.0.0.1:11434/v1";
const model: Model<Api> = {
	id: "local-fixture", name: "local-fixture", api: "openai-completions", provider: "custom", baseUrl,
	reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 128,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, type: "chat",
};
let authorize: (candidate: Model<Api>) => Promise<ModelDispatchPolicy | void>;
let generationRequests: string[];
function response(): Response {
	return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "fixture" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
const closedTransport: typeof fetch = async (input) => {
	const url = input instanceof Request ? input.url : String(input);
	assert.equal(url, `${baseUrl}/chat/completions`);
	generationRequests.push(url);
	return response();
};
function install(): void {
	configureProviderSource({
		isCustom: (id) => id === "custom",
		sync: (models) => models.setProvider(createProvider({
			id: "custom", name: "fixture", baseUrl, models: [model], api: openAICompletionsApi(),
			auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: { apiKey: "not-needed" }, source: "fixture" }) } },
		})),
		authorizeModel: (candidate) => authorize(candidate),
	});
}
const context = normalizeContext({ messages: [{ role: "user", content: "synthetic", timestamp: 0 }] });
const run = (engine: PiEngine, transport?: typeof fetch) => engine.streamFn(engine.model, context, transport ? { fetch: transport } : {}).result();
beforeEach(() => {
	generationRequests = [];
	globalThis.fetch = async () => { throw new Error("CLOSED: every generation must use its authorized transport"); };
	authorize = async () => ({ fetch: closedTransport });
	install();
});
after(() => { globalThis.fetch = originalFetch; configureProviderSource({ isCustom: () => false, sync: () => {} }); });

test("a denied built-in engine makes no provider request", async () => {
	const builtin = piModels().getModels("openai")[0]!;
	assert.ok(builtin);
	const seen: string[] = [];
	authorize = async (candidate) => { seen.push(candidate.provider); throw new Error("Local Ollama only: provider refused"); };
	const result = await run(piEngineForSpec({ provider: builtin.provider, id: builtin.id }));
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /provider refused/);
	assert.deepEqual(seen, ["openai"]);
	assert.equal(generationRequests.length, 0);
});

test("existing custom engine rechecks changed policy on every operation", async () => {
	const engine = piEngineForSpec({ provider: "custom", id: model.id });
	assert.equal((await run(engine)).stopReason, "stop");
	authorize = async () => { throw new Error("Local policy changed"); };
	const result = await run(engine);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /Local policy changed/);
	assert.equal(generationRequests.length, 1);
});

test("authorized scoped transport overrides a caller-provided transport", async () => {
	let callerRequests = 0;
	const result = await run(piEngineForSpec({ provider: "custom", id: model.id }), async () => { callerRequests++; throw new Error("caller transport must not run"); });
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(generationRequests.length, 1);
	assert.equal(callerRequests, 0);
});

async function explicit(): Promise<PiEngine> {
	const state: SchoolParticipantState = { version: 1, participantId: "learner", revision: "one", model: { provider: "custom", id: model.id }, connection: { id: "fixture-route", revision: "1" }, artifacts: [] };
	const binding: SchoolParticipantBindingReceipt = { participantId: state.participantId, participantSha256: "a".repeat(64), stateRef: { revision: "one" }, stateSha256: "b".repeat(64), connection: state.connection, connectionSha256: "c".repeat(64), memorySha256: "d".repeat(64), modelIdentity: "OWNER_DECLARED" };
	return (await prepareSchoolConnectionEngine({
		state, binding, assertCurrent: () => {}, credential: () => undefined,
		configuredEngine: () => { throw new Error("explicit connection must not resolve a configured provider"); },
		connection: { version: 1, id: "fixture-route", revision: "1", label: "fixture", kind: "openai-compatible", baseUrl, auth: { mode: "keyless" }, contextWindow: 16384, maxOutputTokens: 128, reasoning: false },
	})).engine;
}

test("explicit School participant connections also honor the live policy", async () => {
	const engine = await explicit();
	assert.equal((await run(engine)).stopReason, "stop");
	authorize = async () => { throw new Error("Explicit connection refused by local policy"); };
	const result = await run(engine);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /Explicit connection refused/);
	assert.equal(generationRequests.length, 1);
});

test("explicit connection keeps its redirect refusal under an authorized transport", async () => {
	authorize = async () => ({ fetch: async () => { generationRequests.push("redirect-fixture"); return new Response(null, { status: 307, headers: { location: "https://example.invalid/paid" } }); } });
	const result = await run(await explicit());
	assert.equal(result.stopReason, "error");
	assert.ok(result.errorMessage, "the SDK may normalize a transport refusal to a connection error");
	assert.deepEqual(generationRequests, ["redirect-fixture"]);
});
