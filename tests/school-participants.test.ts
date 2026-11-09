/** Production registry, binding and Pi adapter tests. HTTP is restricted to two
 * owned loopback servers; no configured account or external model is used. */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, normalizeContext } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { parseSchoolConnectionDefinition, SchoolParticipantError, schoolConnectionCredentialVariable, type SchoolConnectionDefinition } from "../src/core/school-participants.ts";
import { SchoolParticipantStore, schoolRegistrySha256 } from "../src/store/school-participants.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "school-participants-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { ...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}), NODE_ENV: "test", HOME: scratch, LH_DATA_DIR: scratch, LH_AUTH_FILE: path.join(scratch, "auth.json"), LH_IGNORE_ENV_KEYS: "1", NO_PROXY: "localhost,127.0.0.1,::1" };
globalThis.fetch = async () => { throw new Error("CLOSED: no external fetch in participant tests"); };
const { pinSchoolParticipant, schoolParticipantEngine, schoolParticipantGet, schoolParticipantPost } = await import("../src/server/school-participants.ts");
after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; rmSync(scratch, { recursive: true, force: true }); });
let serial = 0;
const registry = () => new SchoolParticipantStore(path.join(scratch, `registry-${++serial}`));
const connection = (id = "local-a", baseUrl = "http://127.0.0.1:9/v1", revision = "1", authenticated = false): SchoolConnectionDefinition => ({ version: 1, id, revision, label: id, kind: "openai-compatible", baseUrl, auth: authenticated ? { mode: "environment", variable: schoolConnectionCredentialVariable(id, revision) } : { mode: "keyless" }, contextWindow: 8192, maxOutputTokens: 512, reasoning: false });
function register(store: SchoolParticipantStore, id = "learner", route = connection(), memory = "PRIVATE_LEARNER_MEMORY") {
	store.createParticipant({ version: 1, id, label: id, kind: "model" });
	store.createConnection(route);
	const state = { version: 1, participantId: id, revision: "base", model: { provider: route.kind === "configured" ? route.provider : "custom", id: "same-model", thinkingLevel: "off" as const }, connection: { id: route.id, revision: route.revision }, artifacts: [], memory: { text: memory, sourceIds: ["owner-note-1"] } };
	store.createState(state);
	return { participant: { id, model: state.model, stateRef: { revision: state.revision } }, state };
}
const noConfiguredEngine = (): never => { throw new Error("Named connection must never consult the global configured endpoint"); };
const context = () => normalizeContext({ messages: [{ role: "user", content: "say fixture", timestamp: 1 }], tools: [] });
const complete = (engine: PiEngine) => engine.streamFn(engine.model, context(), { maxTokens: 32, maxRetries: 0 }).result();

test("immutable identities, states, lineage and memory survive restart without rewriting evidence", () => {
	const store = registry(), { participant, state } = register(store);
	const pinned = pinSchoolParticipant(participant, store)!;
	assert.equal(pinSchoolParticipant({ id: "legacy", model: participant.model }, store), undefined);
	assert.equal(store.createState(state).created, false);
	assert.throws(() => store.createParticipant({ version: 1, id: participant.id, label: "renamed", kind: "model" }), /different definition/);
	assert.throws(() => store.createState({ ...state, memory: { text: "silently changed", sourceIds: [] } }), /different definition/);
	assert.throws(() => store.createState({ ...state, revision: "bad-parent", parent: { revision: "missing" } }), /Parent state/);
	store.createState({ ...state, revision: "memory-v2", parent: { revision: "base" }, memory: { text: "next explicit memory", sourceIds: ["evidence:episode-3"] } });
	const restarted = new SchoolParticipantStore(store.root);
	assert.equal(restarted.inspectState(participant.id, "base")?.sha256, pinned.receipt.stateSha256);
	assert.equal(restarted.inspectState(participant.id, "memory-v2")?.definition.parent?.revision, "base");
	assert.equal(pinned.state.memory?.text, "PRIVATE_LEARNER_MEMORY");
	assert.ok(Object.isFrozen(pinned.state.memory));
	assert.ok(!JSON.stringify(restarted.list()).includes("PRIVATE_LEARNER_MEMORY"));
	assert.ok(!JSON.stringify(pinned.receipt).includes("PRIVATE_LEARNER_MEMORY"));
	assert.throws(() => pinSchoolParticipant({ ...participant, model: { ...participant.model, id: "other-model" } }, restarted), /exactly match/);
});

test("named endpoint credentials are explicit, revision-specific and never inherited from global provider variables", () => {
	const definition = connection("local-a", "http://127.0.0.1:9/v1", "1", true);
	assert.equal(definition.kind === "openai-compatible" && definition.auth.mode === "environment" && definition.auth.variable, "SCHOOL_CONNECTION_LOCAL_A_1_API_KEY");
	assert.throws(() => parseSchoolConnectionDefinition({ ...definition, auth: { mode: "environment", variable: "OPENAI_API_KEY" } }), /requires credential variable/);
	assert.throws(() => parseSchoolConnectionDefinition({ ...definition, revision: "2" }), /requires credential variable/);
	assert.throws(() => parseSchoolConnectionDefinition({ ...definition, baseUrl: "https://user:secret@example.com/v1" }), /without credentials/);
	assert.throws(() => parseSchoolConnectionDefinition({ ...definition, apiKey: "must-not-be-persisted" }), /unknown field/);
	assert.throws(() => parseSchoolConnectionDefinition({ version: 1, id: "global", revision: "1", label: "Global", kind: "configured", provider: "custom" }), /mutable global custom endpoint/);
	assert.throws(() => schoolConnectionCredentialVariable("local_a", "1"), /lowercase/);
	assert.throws(() => schoolConnectionCredentialVariable("local-a", "01"), /positive decimal/);
});

test("claimed incomplete paths, corruption, symlinks and changed immutable identities refuse", () => {
	const store = registry(), { participant } = register(store);
	const pinned = pinSchoolParticipant(participant, store)!;
	const filename = path.join(store.root, "states", participant.id, "base", "definition.json");
	const record = JSON.parse(readFileSync(filename, "utf8"));
	record.definition.model.id = "replacement";
	record.sha256 = schoolRegistrySha256(record.definition);
	writeFileSync(filename, JSON.stringify(record));
	assert.throws(() => store.assertBinding(pinned), (error) => error instanceof SchoolParticipantError && error.code === "PARTICIPANT_BINDING_DRIFT");
	const broken = registry();
	mkdirSync(path.join(broken.root, "participants", "claimed"), { recursive: true });
	assert.throws(() => broken.createParticipant({ version: 1, id: "claimed", label: "No replacement", kind: "model" }), /incomplete or corrupt/);
	symlinkSync(path.join(scratch, "missing-target"), path.join(broken.root, "participants", "linked"));
	assert.throws(() => broken.createParticipant({ version: 1, id: "linked", label: "No replacement", kind: "model" }), /regular directory/);
});

test("owner HTTP route rejects cross-site mutations and separates private memory inspection from list", async () => {
	const store = registry(), { participant } = register(store);
	const url = "http://localhost:3000/api/school/participants";
	assert.equal(schoolParticipantGet(new Request(url, { headers: { origin: "https://untrusted.example", "sec-fetch-site": "cross-site" } }), { registry: store }).status, 403);
	assert.equal((await schoolParticipantPost(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), { registry: store })).status, 403);
	const list = schoolParticipantGet(new Request(url), { registry: store });
	assert.equal(list.status, 200);
	assert.equal(list.headers.get("cache-control"), "no-store");
	assert.ok(!(await list.text()).includes("PRIVATE_LEARNER_MEMORY"));
	const inspected = schoolParticipantGet(new Request(`${url}?kind=state&id=${participant.id}&revision=base`), { registry: store });
	assert.equal((await inspected.json()).definition.memory.text, "PRIVATE_LEARNER_MEMORY");
	const mutation = (body: unknown) => schoolParticipantPost(new Request(url, { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body) }), { registry: store });
	assert.equal((await mutation({ action: "register-connection", definition: { ...connection(), secret: "unaccepted" } })).status, 400);
	assert.equal((await mutation({ action: "revoke-connection", id: "local-a", revision: "1" })).status, 200);
	assert.throws(() => pinSchoolParticipant(participant, store), /revoked/);
	assert.equal(schoolParticipantGet(new Request(`${url}?kind=state&id=${participant.id}&revision=base&revision=other`), { registry: store }).status, 400);
});

interface Endpoint { server: Server; origin: string; requests: { authorization?: string; model: unknown; messages: unknown }[]; errors: string[] }
async function endpoint(answer: string, redirect?: () => string): Promise<Endpoint> {
	const requests: Endpoint["requests"] = [], errors: string[] = [];
	const server = createServer(async (request, response) => {
		try {
			assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/chat/completions");
			let bytes = ""; for await (const part of request) bytes += part;
			const body = JSON.parse(bytes); requests.push({ authorization: request.headers.authorization, model: body.model, messages: body.messages });
			if (redirect) { response.writeHead(307, { location: redirect() }); response.end(); return; }
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
		} catch (error) { errors.push(String(error)); response.writeHead(500); response.end("fixture failed"); }
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address === "object");
	return { server, origin: `http://127.0.0.1:${address.port}`, requests, errors };
}
async function close(...endpoints: Endpoint[]): Promise<void> {
	globalThis.fetch = async () => { throw new Error("CLOSED: owned endpoints stopped"); };
	await Promise.all(endpoints.map(({ server }) => { server.closeAllConnections(); return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }));
}
function allowOnly(...endpoints: Endpoint[]): void {
	globalThis.fetch = async (input, init) => {
		const target = input instanceof Request ? input.url : String(input);
		assert.ok(endpoints.some((entry) => entry.origin === new URL(target).origin), "test cannot reach an external endpoint");
		return originalFetch(input, init);
	};
}

test("two named production Pi routes with the same model ID remain isolated and retain secret-free receipts", { timeout: 10000 }, async () => {
	const a = await endpoint("from-a"), b = await endpoint("from-b"); allowOnly(a, b);
	try {
		const store = registry(), left = register(store, "learner-a", connection("local-a", `${a.origin}/v1`, "1", true)), right = register(store, "learner-b", connection("local-b", `${b.origin}/v1`, "1", true));
		process.env.SCHOOL_CONNECTION_LOCAL_A_1_API_KEY = "only-a-secret";
		process.env.SCHOOL_CONNECTION_LOCAL_B_1_API_KEY = "only-b-secret";
		process.env.OPENAI_API_KEY = "unrelated-global-secret";
		const boundA = pinSchoolParticipant(left.participant, store)!, boundB = pinSchoolParticipant(right.participant, store)!;
		const preparedA = await schoolParticipantEngine(left.participant, boundA, { registry: store, configuredEngine: noConfiguredEngine });
		const preparedB = await schoolParticipantEngine(right.participant, boundB, { registry: store, configuredEngine: noConfiguredEngine });
		const [replyA, replyB] = await Promise.all([complete(preparedA.engine), complete(preparedB.engine)]);
		assert.equal(replyA.stopReason, "stop", replyA.errorMessage); assert.equal(replyB.stopReason, "stop", replyB.errorMessage);
		assert.deepEqual(replyA.content.map((part) => part.type === "text" ? part.text : ""), ["from-a"]);
		assert.deepEqual(replyB.content.map((part) => part.type === "text" ? part.text : ""), ["from-b"]);
		assert.equal(a.requests[0]?.authorization, "Bearer only-a-secret"); assert.equal(b.requests[0]?.authorization, "Bearer only-b-secret");
		assert.equal(a.requests[0]?.model, "same-model"); assert.equal(b.requests[0]?.model, "same-model");
		assert.notEqual(preparedA.receipt.configurationSha256, preparedB.receipt.configurationSha256);
		assert.equal(preparedA.receipt.loadedArtifact, "NOT_ATTESTED");
		assert.ok(!JSON.stringify({ list: store.list(), a: preparedA.receipt, b: preparedB.receipt }).includes("secret"));
		delete process.env.SCHOOL_CONNECTION_LOCAL_A_1_API_KEY;
		const removed = await complete(preparedA.engine);
		assert.equal(removed.stopReason, "error"); assert.match(removed.errorMessage ?? "", /dedicated credential is unavailable/); assert.equal(a.requests.length, 1);
		store.revokeConnection("local-b", "1");
		const revoked = await complete(preparedB.engine);
		assert.equal(revoked.stopReason, "error"); assert.match(revoked.errorMessage ?? "", /revoked/); assert.equal(b.requests.length, 1);
		assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
	} finally { delete process.env.OPENAI_API_KEY; delete process.env.SCHOOL_CONNECTION_LOCAL_A_1_API_KEY; delete process.env.SCHOOL_CONNECTION_LOCAL_B_1_API_KEY; await close(a, b); }
});

test("keyless routes never inherit a key and redirects cannot forward dedicated credentials", { timeout: 10000 }, async () => {
	const destination = await endpoint("destination"), redirecting = await endpoint("unused", () => `${destination.origin}/v1/chat/completions`); allowOnly(destination, redirecting);
	try {
		const store = registry(), plain = register(store, "plain", connection("plain", `${destination.origin}/v1`));
		process.env.OPENAI_API_KEY = "global-must-not-leak";
		const engine = await schoolParticipantEngine(plain.participant, pinSchoolParticipant(plain.participant, store)!, { registry: store, configuredEngine: noConfiguredEngine });
		assert.equal((await complete(engine.engine)).stopReason, "stop");
		assert.equal(destination.requests[0]?.authorization, "Bearer not-needed");
		const other = register(store, "redirecting", connection("redirecting", `${redirecting.origin}/v1`, "1", true));
		process.env.SCHOOL_CONNECTION_REDIRECTING_1_API_KEY = "bound-to-first-endpoint";
		const redirected = await schoolParticipantEngine(other.participant, pinSchoolParticipant(other.participant, store)!, { registry: store, configuredEngine: noConfiguredEngine });
		assert.equal((await complete(redirected.engine)).stopReason, "error");
		assert.equal(redirecting.requests.length, 1); assert.equal(destination.requests.length, 1, "redirect made no second request");
	} finally { delete process.env.OPENAI_API_KEY; delete process.env.SCHOOL_CONNECTION_REDIRECTING_1_API_KEY; await close(destination, redirecting); }
});

test("configured routes reuse the actual callback and refuse runtime drift or withdrawn permission before dispatch", async () => {
	const store = registry(), fixture = createFauxCore({ tokensPerSecond: 100000 });
	const named: SchoolConnectionDefinition = { version: 1, id: "hosted", revision: "1", label: "Hosted", kind: "configured", provider: "fixture" };
	const { participant } = register(store, "hosted-learner", named), binding = pinSchoolParticipant(participant, store)!;
	let route = "https://first.invalid/v1", permitted = true, dispatched = 0;
	const configured = (): PiEngine => {
		if (!permitted) throw new Error("Permission withdrawn");
		return { model: { ...fixture.getModel(), provider: "fixture", id: "same-model", baseUrl: route }, level: "off", streamFn: (model, context, options) => { dispatched++; fixture.setResponses([fauxAssistantMessage("ok")]); return fixture.streamSimple(model, context, options); } };
	};
	const prepared = await schoolParticipantEngine(participant, binding, { registry: store, configuredEngine: configured });
	route = "https://second.invalid/v1";
	assert.equal((await complete(prepared.engine)).stopReason, "error"); assert.equal(dispatched, 0);
	await assert.rejects(schoolParticipantEngine(participant, binding, { registry: store, configuredEngine: configured, expectedRuntime: prepared.receipt }), /changed after admission/);
	route = "https://first.invalid/v1";
	permitted = false;
	assert.match((await complete(prepared.engine)).errorMessage ?? "", /Permission withdrawn/); assert.equal(dispatched, 0);
	permitted = true;
	assert.equal((await complete(prepared.engine)).stopReason, "stop"); assert.equal(dispatched, 1);
});

test("a crashed registration leaves only staging residue, and the registry still lists and registers", () => {
	const store = registry();
	mkdirSync(path.join(store.root, "staging", "crashed-registration"), { recursive: true });
	writeFileSync(path.join(store.root, "staging", "crashed-registration", "definition.json"), "{\"partial\":");
	assert.deepEqual(store.list(), { participants: [], states: [], connections: [] });
	register(store);
	const listed = store.list();
	assert.deepEqual([listed.participants.length, listed.states.length, listed.connections.length], [1, 1, 1]);
	assert.equal(store.createParticipant({ version: 1, id: "learner", label: "learner", kind: "model" }).created, false);
	assert.deepEqual(readdirSync(path.join(store.root, "staging")), ["crashed-registration"]);
});
