/** Cross-layer tests: production episode orchestration, persisted registry,
 * immutable binding receipts and the actual binding wrapper. Model replies are
 * explicitly scripted; no provider account or outside HTTP is used. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { PiEngine } from "../src/agent/models.ts";
import { parseSchoolEpisode, SchoolEpisodeError, type SchoolCallRecord, type SchoolEpisodeRecord, type SchoolParticipant } from "../src/core/school-episode.ts";
import { generateSchoolExperiment } from "../src/core/school-experiment.ts";
import { SchoolClassStore } from "../src/store/school-classes.ts";
import { SchoolEpisodeStore } from "../src/store/school-episodes.ts";
import { SchoolParticipantStore, schoolRegistrySha256 } from "../src/store/school-participants.ts";
import { scriptedParityEngine } from "../examples/school/scripted-parity.ts";
import { createScriptedFactorizedEngine } from "../examples/school/scripted-factorized.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "school-bound-episode-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { ...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}), NODE_ENV: "test", HOME: scratch, LH_DATA_DIR: scratch, LH_AUTH_FILE: path.join(scratch, "auth.json"), LH_IGNORE_ENV_KEYS: "1" };
globalThis.fetch = async () => { throw new Error("CLOSED: bound episode tests make no network requests"); };
const { runSchoolEpisode } = await import("../src/server/school-episodes.ts");
after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; rmSync(scratch, { recursive: true, force: true }); });
let serial = 0;
class Snapshots extends SchoolEpisodeStore {
	readonly snapshots: SchoolEpisodeRecord[] = [];
	override write(record: SchoolEpisodeRecord) { super.write(record); this.snapshots.push(structuredClone(record)); }
}
function setup(experiment = false) {
	const root = path.join(scratch, `case-${++serial}`), registry = new SchoolParticipantStore(path.join(root, "registry")), classStore = new SchoolClassStore(path.join(root, "classes")), store = new Snapshots(path.join(root, "episodes"));
	const definition = JSON.parse(readFileSync(new URL(experiment ? "../examples/school/factorized-class.json" : "../examples/school/byte-parity-class.json", import.meta.url), "utf8"));
	classStore.create(definition);
	const manifest = experiment ? generateSchoolExperiment({ seed: 17, operationId: `bound-${serial}`, memory: true }) : parseSchoolEpisode({ ...JSON.parse(readFileSync(new URL("../examples/school/byte-parity.json", import.meta.url), "utf8")), operationId: `bound-${serial}` });
	const model = { provider: "school-fixture", id: experiment ? "scripted-factorized-helpful-v1" : "scripted-parity-v1", thinkingLevel: "off" as const };
	for (const role of ["learner", "teacher"] as const) {
		const id = manifest[role].id;
		registry.createParticipant({ version: 1, id, label: role, kind: "model" });
		registry.createConnection({ version: 1, id: `${role}-route`, revision: "1", label: role, kind: "configured", provider: model.provider });
		registry.createState({ version: 1, participantId: id, revision: "base", model, edition: "scripted-test", connection: { id: `${role}-route`, revision: "1" }, artifacts: [], memory: { text: `${role.toUpperCase()}_PRIVATE_MEMORY`, sourceIds: [`${role}-note`] } });
		manifest[role] = { id, model: { ...model }, edition: "scripted-test", stateRef: { revision: "base" } };
	}
	return { registry, classStore, store, manifest };
}

test("bound episode persists each role's state and exact memory view; replay remains read-only after revocation", async () => {
	const state = setup(); let dispatched = 0;
	const result = await runSchoolEpisode(state.manifest, { ...state, evidence: "SCRIPTED_FIXTURE", engineFor: (participant, call) => {
		const engine = scriptedParityEngine(participant, call);
		return { ...engine, streamFn: (model, context, options) => {
			dispatched++;
			const payload = JSON.stringify(context);
			assert.ok(payload.includes(`${call.role.toUpperCase()}_PRIVATE_MEMORY`));
			assert.ok(!payload.includes(call.role === "learner" ? "TEACHER_PRIVATE_MEMORY" : "LEARNER_PRIVATE_MEMORY"));
			return engine.streamFn(model, context, options);
		} };
	} });
	assert.equal(result.record.status, "COMPLETED", result.record.error); assert.equal(dispatched, 7);
	assert.ok(result.record.bindings?.learner); assert.ok(result.record.bindings?.teacher);
	assert.notEqual(result.record.bindings.learner.stateSha256, result.record.bindings.teacher.stateSha256);
	for (const call of result.record.calls) {
		assert.deepEqual(call.runtime?.participant, result.record.bindings[call.role]);
		assert.equal(call.runtime?.loadedArtifact, "NOT_ATTESTED");
		const admitted = state.store.snapshots.find((snapshot) => snapshot.events.at(-1)?.kind === "CALL_ADMITTED" && snapshot.events.at(-1)?.callId === call.id)!;
		assert.deepEqual(admitted.calls.find((saved) => saved.id === call.id)?.runtime, call.runtime, "receipt is durable before dispatch");
	}
	const saved = state.registry.inspectState(state.manifest.learner.id, "base")!;
	state.registry.createState({ ...saved.definition, revision: "memory-2", parent: { revision: "base" }, memory: { text: "NEW_STATE_MEMORY", sourceIds: ["new-source"] } });
	state.registry.revokeConnection("learner-route", "1"); state.registry.revokeConnection("teacher-route", "1");
	const replay = await runSchoolEpisode(state.manifest, { ...state, evidence: "SCRIPTED_FIXTURE", engineFor: () => { throw new Error("Completed replay must not resolve a provider"); } });
	assert.equal(replay.replayed, true); assert.deepEqual(replay.record, result.record); assert.equal(dispatched, 7);
	assert.deepEqual(new SchoolEpisodeStore(state.store.root).read(state.manifest.operationId), result.record);
	assert.throws(() => state.store.write({ ...result.record, error: "rewritten result" }), /cannot be rewritten/);
});

test("registered memory is absent from baseline, assisted, cold, transfer and teacher views unless the memory condition admits it", async () => {
	const state = setup(true), scripted = createScriptedFactorizedEngine("helpful"); let dispatched = 0;
	const result = await runSchoolEpisode(state.manifest, { ...state, evidence: "SCRIPTED_FIXTURE", engineFor: (participant, call) => {
		const engine = scripted(participant, call);
		return { ...engine, streamFn: (model, context, options) => {
			dispatched++;
			const payload = JSON.stringify(context);
			assert.equal(payload.includes("LEARNER_PRIVATE_MEMORY"), call.phase === "memory");
			assert.ok(!payload.includes("TEACHER_PRIVATE_MEMORY"));
			return engine.streamFn(model, context, options);
		} };
	} });
	assert.equal(result.record.status, "COMPLETED", result.record.error); assert.equal(dispatched, 21);
	assert.equal(result.record.exposures?.length, 21);
	for (const exposure of result.record.exposures ?? []) assert.equal(exposure.memorySha256 !== undefined, exposure.condition === "memory");
	assert.equal(result.record.experiment?.conditions.find((condition) => condition.condition === "memory")?.assistance, "saved-memory");
});

test("running episode binding and admitted runtime snapshots cannot be rewritten", async () => {
	const state = setup();
	await runSchoolEpisode(state.manifest, { ...state, evidence: "SCRIPTED_FIXTURE", engineFor: scriptedParityEngine });
	const admitted = state.store.snapshots.find((snapshot) => snapshot.events.at(-1)?.kind === "CALL_ADMITTED")!;
	assert.ok(admitted.calls[0]?.runtime);
	const paused = new SchoolEpisodeStore(path.join(scratch, `paused-${++serial}`));
	paused.claim(structuredClone(admitted));
	const changedBinding = structuredClone(admitted);
	changedBinding.bindings!.learner!.participantSha256 = "a".repeat(64);
	changedBinding.calls[0]!.runtime!.participant.participantSha256 = "a".repeat(64);
	assert.throws(() => paused.write(changedBinding), (error) => error instanceof SchoolEpisodeError && error.code === "PARTICIPANT_BINDING_DRIFT");
	const changedRuntime = structuredClone(admitted);
	changedRuntime.calls[0]!.runtime!.configurationSha256 = "b".repeat(64);
	assert.throws(() => paused.write(changedRuntime), (error) => error instanceof SchoolEpisodeError && error.code === "RUNTIME_BINDING_DRIFT");
	assert.deepEqual(paused.read(admitted.operationId), admitted);
});

for (const drift of ["registry-state", "runtime-route", "revocation"] as const) test(`${drift} after the first call prevents any second dispatch and retains admitted evidence`, async () => {
	const state = setup(); let dispatched = 0, changed = false;
	const engineFor = (participant: SchoolParticipant, call: SchoolCallRecord): PiEngine => {
		const engine = scriptedParityEngine(participant, call);
		return { ...engine, model: { ...engine.model, baseUrl: changed && drift === "runtime-route" ? "https://changed.invalid/v1" : "https://original.invalid/v1" }, streamFn: (model, context, options) => {
			dispatched++;
			if (!changed) {
				changed = true;
				if (drift === "revocation") state.registry.revokeConnection("learner-route", "1");
				if (drift === "registry-state") {
					const filename = path.join(state.registry.root, "states", state.manifest.learner.id, "base", "definition.json");
					const record = JSON.parse(readFileSync(filename, "utf8"));
					record.definition.memory.text = "ILLEGAL_REPLACEMENT"; record.sha256 = schoolRegistrySha256(record.definition);
					writeFileSync(filename, JSON.stringify(record));
				}
			}
			return engine.streamFn(model, context, options);
		} };
	};
	const result = await runSchoolEpisode(state.manifest, { ...state, evidence: "SCRIPTED_FIXTURE", engineFor });
	assert.equal(result.record.status, "FAILED"); assert.equal(dispatched, 1); assert.equal(result.record.calls.length, 2);
	assert.equal(result.record.calls[0]?.completion, "REPLY_RETAINED"); assert.ok(result.record.calls[0]?.grade);
	assert.equal(result.record.calls[1]?.completion, "NO_CALL_ADMITTED"); assert.equal(result.record.calls[1]?.runtime, undefined);
	assert.match(result.record.error ?? "", drift === "revocation" ? /revoked/ : /changed/);
	assert.deepEqual(new SchoolEpisodeStore(state.store.root).read(state.manifest.operationId), result.record);
	assert.equal((await runSchoolEpisode(state.manifest, { ...state, evidence: "SCRIPTED_FIXTURE", engineFor: () => { throw new Error("No failed replay dispatch"); } })).replayed, true);
});
