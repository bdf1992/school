import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { parseSchoolEpisode, SchoolEpisodeError, type SchoolEpisodeRecord } from "../src/core/school-episode.ts";
import { SchoolEpisodeStore, schoolManifestSha256 } from "../src/store/school-episodes.ts";
import { admitSchoolClassEpisode } from "../src/core/school-class.ts";
import { schoolClassSha256 } from "../src/store/school-classes.ts";
import { scriptedParityEngine } from "../examples/school/scripted-parity.ts";

// No account credentials, real home, configured endpoints, or external fetches.
const scratch = mkdtempSync(path.join(tmpdir(), "school-episode-test-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { ...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}), NODE_ENV: "test", HOME: scratch, LH_DATA_DIR: scratch, LH_AUTH_FILE: path.join(scratch, "auth.json"), LH_IGNORE_ENV_KEYS: "1" };
globalThis.fetch = async () => { throw new Error("CLOSED: no network in School episode unit tests"); };
const { runSchoolEpisode, schoolEpisodePost, schoolEpisodeGet } = await import("../src/server/school-episodes.ts");
const { schoolClasses } = await import("../src/server/school-state.ts");
schoolClasses.create(JSON.parse(readFileSync(new URL("../examples/school/byte-parity-class.json", import.meta.url), "utf8")));
after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; rmSync(scratch, { recursive: true, force: true }); });
const source = JSON.parse(readFileSync(new URL("../examples/school/byte-parity.json", import.meta.url), "utf8"));
let serial = 0;
const manifest = () => parseSchoolEpisode({ ...structuredClone(source), operationId: `case-${++serial}` });
const store = () => new SchoolEpisodeStore(path.join(scratch, `evidence-${++serial}`));
const fixture = { engineFor: scriptedParityEngine, evidence: "SCRIPTED_FIXTURE" as const };
function replyEngine(reply: AssistantMessage): PiEngine {
	const faux = createFauxCore({ tokensPerSecond: 100000, tokenSize: { min: 1024, max: 1024 } });
	faux.setResponses([reply]);
	return { model: faux.getModel(), level: "high", streamFn: faux.streamSimple };
}
class Snapshots extends SchoolEpisodeStore {
	readonly snapshots: SchoolEpisodeRecord[] = [];
	override write(record: SchoolEpisodeRecord) { super.write(record); this.snapshots.push(structuredClone(record)); }
}

test("the bounded fixture commits raw answers before independent grades and compares retention", async () => {
	const input = manifest(), evidence = new Snapshots(path.join(scratch, "snapshot-evidence"));
	const contexts: TranscriptContext[] = [];
	const result = await runSchoolEpisode(input, { store: evidence, ...fixture, engineFor: (participant, call) => {
		const engine = scriptedParityEngine(participant, call);
		return { ...engine, streamFn: (model, context, options) => {
			contexts.push(context);
			assert.equal(options?.maxTokens, 512);
			assert.equal(options?.maxRetries, 0);
			assert.equal(options?.timeoutMs, 30000);
			assert.equal(options?.sessionId, call.id);
			assert.equal(context.messages.filter((m) => m.role === "user").length, 1, "every answer is a fresh context");
			assert.ok(context.messages.every((m) => m.role === "user" || m.role === "system"));
			return engine.streamFn(model, context, options);
		} };
	} });
	assert.equal(result.record.status, "COMPLETED", result.record.error);
	assert.equal(result.record.evidence, "SCRIPTED_FIXTURE");
	assert.equal(contexts.length, 7);
	assert.deepEqual(result.record.comparison, { baseline: { target: 1, retention: 1 }, retry: { target: 2, retention: 1 }, total: { target: 2, retention: 1 }, regressedCases: [], outcome: "CONTEXTUAL_GAIN", weightLearning: "NOT_PERFORMED", adoption: "NOT_REQUESTED", generalization: "NOT_ESTABLISHED" });
	for (const call of result.record.calls.filter((c) => c.role === "learner")) {
		const raw = evidence.snapshots.find((r) => r.events.at(-1)?.kind === "RAW_REPLY_COMMITTED" && r.events.at(-1)?.callId === call.id)!;
		const saved = raw.calls.find((c) => c.id === call.id)!;
		assert.ok(saved.reply);
		assert.equal(saved.grade, undefined, "raw reply was durable before evaluator execution");
		const kinds = result.record.events.filter((e) => e.callId === call.id).map((e) => e.kind);
		assert.deepEqual(kinds, ["CALL_REQUESTED", "CALL_ADMITTED", "RAW_REPLY_COMMITTED", "EVALUATOR_GRADED"]);
	}
	assert.deepEqual(evidence.read(input.operationId), result.record);
});

test("participant projections exclude withheld expected answers and teacher receives no evaluation problems", async () => {
	const input = manifest();
	input.teaching[0]!.expected = "TEACHING_ANSWER_VISIBLE_TO_TEACHER_ONLY";
	input.evaluation[0]!.expected = "EVALUATOR_SECRET_1703";
	input.evaluation[0]!.question = "HELD_OUT_PROBLEM_5294";
	input.evaluation[0]!.observations[0]!.content = "HELD_OUT_OBSERVATION_8142";
	let inspected = 0;
	await runSchoolEpisode(input, { store: store(), ...fixture, engineFor: (_participant, call) => {
		const serialized = JSON.stringify(call.view);
		assert.ok(!serialized.includes("EVALUATOR_SECRET_1703"));
		if (call.role === "teacher") {
			assert.ok(serialized.includes("TEACHING_ANSWER_VISIBLE_TO_TEACHER_ONLY"));
			assert.ok(!serialized.includes("HELD_OUT_PROBLEM_5294"));
			assert.ok(!serialized.includes("HELD_OUT_OBSERVATION_8142"));
			assert.ok(!serialized.includes(input.evaluation[0]!.id));
		} else {
			assert.ok(!serialized.includes("TEACHING_ANSWER_VISIBLE_TO_TEACHER_ONLY"));
			assert.ok(!serialized.includes('"expected"'));
			assert.ok(!serialized.includes('"split"'));
		}
		inspected++;
		return replyEngine(fauxAssistantMessage("EVEN"));
	} });
	assert.equal(inspected, 7);
});

test("completed retry returns identical evidence with no provider calls and collision refuses", async () => {
	const input = manifest(), evidence = store();
	let calls = 0;
	const options = { store: evidence, ...fixture, engineFor: (p: Parameters<typeof scriptedParityEngine>[0], c: Parameters<typeof scriptedParityEngine>[1]) => { calls++; return scriptedParityEngine(p, c); } };
	const first = await runSchoolEpisode(input, options);
	const again = await runSchoolEpisode(input, options);
	assert.equal(again.replayed, true);
	assert.deepEqual(again.record, first.record);
	assert.equal(calls, 7);
	input.evaluation[0]!.expected = "different answer";
	await assert.rejects(runSchoolEpisode(input, options), (error: unknown) => error instanceof SchoolEpisodeError && error.code === "OPERATION_COLLISION");
	assert.equal(calls, 7);
	assert.throws(() => evidence.write(first.record), /cannot be rewritten/);
});

test("an interrupted locally admitted call is never automatically replayed after restart", async () => {
	const input = manifest(), observed = new Snapshots(path.join(scratch, "restart-origin"));
	await runSchoolEpisode(input, { store: observed, ...fixture });
	const interrupted = observed.snapshots.find((r) => r.events.at(-1)?.kind === "CALL_ADMITTED")!;
	assert.equal(interrupted.calls[0]!.completion, "UNKNOWN");
	const crashedStore = store();
	crashedStore.claim(interrupted);
	let called = false;
	const afterRestart = new SchoolEpisodeStore(crashedStore.root);
	await assert.rejects(runSchoolEpisode(input, { store: afterRestart, ...fixture, engineFor: () => { called = true; throw new Error("must not run"); } }), (error: unknown) => error instanceof SchoolEpisodeError && error.code === "OPERATION_INCOMPLETE");
	assert.equal(called, false);
});

test("a concurrent duplicate operation refuses while its first execution is active", async () => {
	const input = manifest(), evidence = store();
	const running = runSchoolEpisode(input, { store: evidence, ...fixture });
	await assert.rejects(runSchoolEpisode(input, { store: evidence, ...fixture }), /running or interrupted/);
	assert.equal((await running).record.status, "COMPLETED");
});

test("target gain cannot hide regression on a previously correct retention case", async () => {
	const input = manifest();
	const result = await runSchoolEpisode(input, { store: store(), ...fixture, engineFor: (p, c) => c.phase === "retry" && c.caseId === "retention-even" ? replyEngine(fauxAssistantMessage("ODD")) : scriptedParityEngine(p, c) });
	assert.equal(result.record.comparison?.outcome, "REGRESSION");
	assert.deepEqual(result.record.comparison?.regressedCases, ["retention-even"]);
	assert.deepEqual(result.record.comparison?.retry, { target: 2, retention: 0 });
});

test("a ceiling baseline does not manufacture improvement or weight learning", async () => {
	const input = manifest();
	const result = await runSchoolEpisode(input, { store: store(), ...fixture, engineFor: (p, c) => c.phase === "baseline" && c.caseId === "target-even" ? replyEngine(fauxAssistantMessage(" EVEN \n")) : scriptedParityEngine(p, c) });
	assert.equal(result.record.comparison?.outcome, "NO_MEASURED_GAIN");
	assert.equal(result.record.comparison?.weightLearning, "NOT_PERFORMED");
});

for (const [name, reply] of [
	["tool call", fauxAssistantMessage(fauxToolCall("grade_me", { correct: true }), { stopReason: "toolUse" })],
	["truncation", fauxAssistantMessage("EVEN", { stopReason: "length" })],
	["provider error", fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic upstream error" })],
	["blank answer", fauxAssistantMessage("   ")],
] as const) test(`${name} is retained before refusal and never graded`, async () => {
	const input = manifest(), evidence = store();
	const result = await runSchoolEpisode(input, { store: evidence, ...fixture, engineFor: () => replyEngine(reply) });
	assert.equal(result.record.status, "FAILED");
	assert.equal(result.record.calls.length, 1);
	assert.equal(result.record.calls[0]!.completion, "REPLY_RETAINED");
	assert.ok(result.record.calls[0]!.reply);
	assert.equal(result.record.calls[0]!.grade, undefined);
	assert.equal(result.record.comparison, undefined);
	assert.equal((await runSchoolEpisode(input, { store: evidence, ...fixture, engineFor: () => { throw new Error("must not run again"); } })).replayed, true);
});

test("local timer settles a non-cooperative provider and records unknown completion", async () => {
	const input = manifest(); input.limits.callTimeoutMs = 10;
	let signal: AbortSignal | undefined;
	const engine = replyEngine(fauxAssistantMessage("unused"));
	engine.streamFn = (_model, _context, options) => {
		signal = options?.signal;
		return { result: () => new Promise<AssistantMessage>(() => {}) } as ReturnType<PiEngine["streamFn"]>;
	};
	const result = await runSchoolEpisode(input, { store: store(), ...fixture, engineFor: () => engine });
	assert.equal(signal?.aborted, true);
	assert.equal(result.record.status, "FAILED");
	assert.equal(result.record.calls[0]!.completion, "UNKNOWN");
	assert.equal(result.record.calls[0]!.reply, undefined);
	assert.match(result.record.error!, /time limit/);
});

test("an oversized terminal reply retains a bounded fingerprint without pretending completion is unknown", async () => {
	const input = manifest();
	const engine = replyEngine(fauxAssistantMessage("unused"));
	engine.streamFn = () => ({ result: async () => fauxAssistantMessage("x".repeat(256 * 1024)) }) as ReturnType<PiEngine["streamFn"]>;
	const result = await runSchoolEpisode(input, { store: store(), ...fixture, engineFor: () => engine });
	const call = result.record.calls[0]!;
	assert.equal(result.record.status, "FAILED");
	assert.equal(call.completion, "TERMINAL_REPLY_REJECTED");
	assert.ok(call.rejectedReply!.bytes > 256 * 1024);
	assert.match(call.rejectedReply!.sha256, /^[0-9a-f]{64}$/);
	assert.equal(call.reply, undefined); assert.equal(call.grade, undefined);
});

test("pre-cancelled episodes and missing configured providers spend no model calls", async () => {
	let called = false;
	const aborted = await runSchoolEpisode(manifest(), { store: store(), ...fixture, signal: AbortSignal.abort(new Error("cancelled before admission")), engineFor: () => { called = true; throw new Error("must not run"); } });
	assert.equal(called, false); assert.equal(aborted.record.calls.length, 0); assert.equal(aborted.record.status, "FAILED");
	const input = manifest(); input.learner.model = { provider: "anthropic", id: "claude-haiku-4-5" };
	const unavailable = await runSchoolEpisode(input, { store: store() });
	assert.equal(unavailable.record.status, "FAILED");
	assert.equal(unavailable.record.calls[0]!.completion, "NO_CALL_ADMITTED");
	assert.match(unavailable.record.error!, /Configure and enable/);
});

test("elapsed deadlines stop a synchronous provider even before timer callbacks can run", async () => {
	const input = manifest(); input.limits.callTimeoutMs = 10; input.limits.episodeTimeoutMs = 10;
	const base = replyEngine(fauxAssistantMessage("EVEN"));
	let calls = 0;
	const engine: PiEngine = { ...base, streamFn: () => {
		calls++;
		const end = performance.now() + 15;
		while (performance.now() < end) { /* simulate a blocking provider adapter */ }
		return { result: async () => fauxAssistantMessage("EVEN") } as ReturnType<PiEngine["streamFn"]>;
	} };
	const result = await runSchoolEpisode(input, { store: store(), ...fixture, engineFor: () => engine });
	assert.equal(calls, 1);
	assert.equal(result.record.status, "FAILED");
	assert.equal(result.record.calls[0]!.completion, "REPLY_RETAINED");
	assert.equal(result.record.calls[0]!.grade, undefined);
	assert.match(result.record.error!, /time limit/);
});

test("manifest boundaries reject hidden fields, duplicate held-out inputs and invalid limits", () => {
	const input = manifest();
	assert.throws(() => parseSchoolEpisode({ ...input, solution: "secret" }), /unknown field/);
	assert.throws(() => parseSchoolEpisode({ ...input, operationId: "../escape" }), /letters/);
	assert.throws(() => parseSchoolEpisode({ ...input, limits: { maxOutputTokens: 4097 } }), /maxOutputTokens/);
	assert.throws(() => parseSchoolEpisode({ ...input, evaluation: input.evaluation.filter((c) => c.split === "target") }), /Both target and retention/);
	const duplicate = structuredClone(input);
	duplicate.teaching[0] = { ...duplicate.evaluation[0]!, id: "new-example", observations: duplicate.evaluation[0]!.observations.map((o) => ({ ...o, id: "renamed-evidence" })) };
	delete (duplicate.teaching[0] as unknown as Record<string, unknown>).split;
	assert.throws(() => parseSchoolEpisode(duplicate), /cannot also be a teaching example/);
	input.teaching[0]!.observations[0] = { id: "source", status: "ABSENT", content: "contradiction" };
	assert.throws(() => parseSchoolEpisode(input), /ABSENT/);
});

test("HTTP entry requires a trusted JSON mutation, bounds bytes, and returns stored evidence", async () => {
	const input = manifest(), evidence = store();
	const req = (body = JSON.stringify(input), headers: Record<string, string> = {}) => new Request("http://localhost/api/school/episodes", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json", ...headers }, body });
	assert.equal((await schoolEpisodePost(req(undefined, { origin: "https://other.example" }), { store: evidence, ...fixture })).status, 403);
	assert.equal((await schoolEpisodePost(req(undefined, { "content-type": "text/plain" }), { store: evidence, ...fixture })).status, 415);
	assert.equal((await schoolEpisodePost(req("["), { store: evidence, ...fixture })).status, 400);
	assert.equal((await schoolEpisodePost(req(JSON.stringify({ oversized: "x".repeat(65536) })), { store: evidence, ...fixture })).status, 413);
	const result = await schoolEpisodePost(req(), { store: evidence, ...fixture });
	assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "no-store");
	const saved = schoolEpisodeGet(new Request(`http://localhost/api/school/episodes?operationId=${input.operationId}`), evidence);
	assert.equal(saved.status, 200);
	assert.deepEqual((await saved.json()).record, (await result.json()).record);
	assert.equal(schoolEpisodeGet(new Request(`http://localhost/api/school/episodes?operationId=${input.operationId}`, { headers: { origin: "https://other.example" } }), evidence).status, 403);
});

test("manifest fingerprints ignore key insertion order and reject mutation after admission", () => {
	const input = manifest();
	assert.equal(input.version, 2);
	if (input.version !== 2) throw new Error("Expected a class-bound fixture");
	assert.equal(schoolManifestSha256(input), schoolManifestSha256({ ...input, world: { instructions: input.world.instructions, subject: input.world.subject, revision: input.world.revision, id: input.world.id } }));
	const evidence = store(), now = new Date().toISOString();
	const definition = schoolClasses.get(input.class.classId, input.class.revision)!;
	const classContext = { ...admitSchoolClassEpisode(definition, input.class, { learnerId: input.learner.id, teacherId: input.teacher.id, world: input.world, now }), definitionSha256: schoolClassSha256(definition) };
	const initial: SchoolEpisodeRecord = { version: 2, operationId: input.operationId, manifest: input, classContext, manifestSha256: schoolManifestSha256(input), evidence: "SCRIPTED_FIXTURE", status: "RUNNING", createdAt: now, updatedAt: now, calls: [], events: [] };
	evidence.claim(initial);
	input.world.revision = "changed";
	assert.throws(() => evidence.write(initial), /manifest cannot change/);
});
