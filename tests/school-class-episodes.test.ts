/** Class admission through the real bounded episode runner; synthetic engines,
 * isolated files and no external network. Includes exact historical replay. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { parseSchoolEpisode, SchoolEpisodeError, type SchoolEpisodeRecord } from "../src/core/school-episode.ts";
import { SchoolClassError } from "../src/core/school-class.ts";
import { SchoolClassStore, schoolClassSha256 } from "../src/store/school-classes.ts";
import { SchoolEpisodeStore } from "../src/store/school-episodes.ts";
import { schoolGradebook } from "../src/core/school-gradebook.ts";
import { scriptedParityEngine } from "../examples/school/scripted-parity.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "school-class-episodes-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { ...originalEnv, NODE_ENV: "test", LH_DATA_DIR: scratch, LH_AUTH_FILE: path.join(scratch, "auth.json"), LH_IGNORE_ENV_KEYS: "1" };
globalThis.fetch = async () => { throw new Error("CLOSED: no network in class episode tests"); };
const { runSchoolEpisode } = await import("../src/server/school-episodes.ts");
after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; rmSync(scratch, { recursive: true, force: true }); });

const source = JSON.parse(readFileSync(new URL("../examples/school/byte-parity.json", import.meta.url), "utf8"));
const classSource = JSON.parse(readFileSync(new URL("../examples/school/byte-parity-class.json", import.meta.url), "utf8"));
let serial = 0;
function setup(scheduled = false) {
	const root = path.join(scratch, `school-${++serial}`);
	const classStore = new SchoolClassStore(path.join(root, "classes")), store = new SchoolEpisodeStore(path.join(root, "episodes"));
	const raw = structuredClone(classSource);
	if (scheduled) raw.schedule = { mode: "scheduled", sessions: [{ id: "session-1", unitId: "byte-parity", startsAt: "2026-11-09T12:00:00Z", endsAt: "2026-11-09T13:00:00Z" }] };
	const { definition } = classStore.create(raw);
	const input = { ...structuredClone(source), operationId: `class-episode-${serial}` };
	if (scheduled) input.class.sessionId = "session-1";
	return { input, definition, store, classStore };
}
const fixture = { evidence: "SCRIPTED_FIXTURE" as const, engineFor: scriptedParityEngine };

test("two peers share a class while retaining independent work, private views and an explicit regression", async () => {
	const state = setup();
	let calls = 0;
	const first = await runSchoolEpisode(state.input, { ...state, ...fixture, engineFor: (participant, call) => {
		calls++;
		const view = call.view as { class: { id: string }; unit: { id: string } };
		assert.equal(view.class.id, state.definition.id);
		assert.equal(view.unit.id, "byte-parity");
		assert.doesNotMatch(JSON.stringify(view), /local-peer|"roster"|"grades"|"classContext"/);
		return scriptedParityEngine(participant, call);
	} });
	assert.equal(first.record.status, "COMPLETED");
	assert.equal(first.record.version, 2);
	const beforePeer = state.store.read(first.record.operationId)!;
	const beforeBook = schoolGradebook(state.definition, state.store.list());
	assert.deepEqual(beforeBook.learners.find((learner) => learner.participantId === "local-peer"), { participantId: "local-peer", status: "NO_EPISODES", episodes: [] });

	const peer = structuredClone(state.input);
	peer.operationId += "-peer"; peer.learner.id = "local-peer";
	const second = await runSchoolEpisode(peer, { ...state, ...fixture, engineFor: (participant, call) => {
		calls++;
		if (call.phase === "retry" && call.caseId === "retention-even") {
			const faux = createFauxCore({}); faux.setResponses([fauxAssistantMessage("ODD")]);
			return { model: faux.getModel(), streamFn: faux.streamSimple };
		}
		return scriptedParityEngine(participant, call);
	} });
	assert.equal(second.record.status, "COMPLETED");
	assert.equal(second.record.comparison?.outcome, "REGRESSION");
	assert.deepEqual(state.store.read(first.record.operationId), beforePeer, "a peer episode cannot alter existing evidence");
	const book = schoolGradebook(state.definition, state.store.list());
	assert.deepEqual(book.learners.map((learner) => [learner.participantId, learner.episodes.length, learner.episodes[0]?.comparison?.outcome]), [["local-learner", 1, "CONTEXTUAL_GAIN"], ["local-peer", 1, "REGRESSION"]]);
	assert.equal(calls, 14);
	assert.equal((await runSchoolEpisode(state.input, { ...state, ...fixture, engineFor: () => { throw new Error("replay must not call a provider"); } })).replayed, true);
	assert.equal(state.store.list().length, 2);
});

test("class admission failures dispatch no calls and create no episode or successful grade", async () => {
	const state = setup(true);
	let calls = 0;
	const options = { ...state, ...fixture, now: () => new Date("2026-11-09T12:30:00Z"), engineFor: () => { calls++; throw new Error("must not dispatch"); } };
	const mutations: [string, (input: typeof state.input) => void][] = [
		["CLASS_NOT_FOUND", (input) => { input.class.classId = "missing"; }],
		["CLASS_PARTICIPANT_NOT_ENROLLED", (input) => { input.learner.id = "stranger"; }],
		["CLASS_ROLE_REQUIRED", (input) => { input.teacher.id = "local-learner"; }],
		["CLASS_UNIT_NOT_FOUND", (input) => { input.class.unitId = "missing-unit"; }],
		["CLASS_WORLD_MISMATCH", (input) => { input.world.revision = "changed"; }],
		["CLASS_SESSION_REQUIRED", (input) => { delete input.class.sessionId; }],
	];
	for (const [code, mutate] of mutations) {
		const input = structuredClone(state.input); input.operationId += `-${code}`; mutate(input);
		await assert.rejects(runSchoolEpisode(input, options), (error: unknown) => error instanceof SchoolClassError && error.code === code);
	}
	await assert.rejects(runSchoolEpisode(state.input, { ...options, now: () => new Date("2026-11-09T13:00:00Z") }), (error: unknown) => error instanceof SchoolClassError && error.code === "CLASS_SESSION_CLOSED");
	const missing = structuredClone(state.input); delete missing.class;
	assert.throws(() => parseSchoolEpisode(missing), SchoolClassError);
	assert.equal(calls, 0);
	assert.deepEqual(state.store.list(), []);
	assert.ok(schoolGradebook(state.definition, state.store.list()).learners.every((learner) => learner.status === "NO_EPISODES"));
});

test("a scheduled episode pins its admission and exact replay survives session closure and unavailable class storage", async () => {
	const state = setup(true);
	const first = await runSchoolEpisode(state.input, { ...state, ...fixture, now: () => new Date("2026-11-09T12:00:00Z") });
	assert.equal(first.record.status, "COMPLETED");
	assert.equal(first.record.classContext?.admittedAt, "2026-11-09T12:00:00.000Z");
	let calls = 0;
	const closed = { ...state, ...fixture, now: () => new Date("2026-11-09T13:00:00Z"), engineFor: () => { calls++; throw new Error("must not dispatch"); } };
	assert.deepEqual((await runSchoolEpisode(state.input, closed)).record, first.record);
	await assert.rejects(runSchoolEpisode({ ...state.input, operationId: "new-after-close" }, closed), (error: unknown) => error instanceof SchoolClassError && error.code === "CLASS_SESSION_CLOSED");
	rmSync(state.classStore.root, { recursive: true });
	assert.equal((await runSchoolEpisode(state.input, closed)).replayed, true, "replay uses the admitted snapshot, not current enrollment or schedule");
	assert.equal(calls, 0);
});

test("the archived v1 fixture remains byte-equivalent evidence and new classless work is refused", async () => {
	const state = setup();
	const historical = JSON.parse(readFileSync(new URL("../docs/evidence/school-byte-parity-fixture.json", import.meta.url), "utf8")) as SchoolEpisodeRecord;
	state.store.claim(historical);
	const file = path.join(state.store.root, historical.operationId, "record.json");
	const before = readFileSync(file);
	let calls = 0;
	const options = { ...state, ...fixture, engineFor: () => { calls++; throw new Error("must not dispatch"); } };
	const replayed = await runSchoolEpisode(historical.manifest, options);
	assert.equal(replayed.replayed, true);
	assert.deepEqual(replayed.record, historical);
	assert.deepEqual(readFileSync(file), before);
	await assert.rejects(runSchoolEpisode({ ...historical.manifest, operationId: "new-v1" }, options), (error: unknown) => error instanceof SchoolEpisodeError && error.code === "CLASS_REQUIRED");
	await assert.rejects(runSchoolEpisode({ ...historical.manifest, world: { ...historical.manifest.world, revision: "different" } }, options), (error: unknown) => error instanceof SchoolEpisodeError && error.code === "OPERATION_COLLISION");
	assert.equal(calls, 0);
	assert.equal(schoolGradebook(state.definition, state.store.list()).learners[0]?.status, "NO_EPISODES", "historical evidence is not silently reassigned");
});

test("an admitted class snapshot cannot be rewritten even with a matching replacement digest", async () => {
	const state = setup();
	const finished = (await runSchoolEpisode(state.input, { ...state, ...fixture })).record;
	assert.equal(finished.version, 2);
	if (finished.version !== 2) throw new Error("Expected class-bound evidence");
	const record = structuredClone(finished); record.status = "RUNNING";
	const interrupted = new SchoolEpisodeStore(path.join(scratch, "interrupted-class"));
	interrupted.claim(record);
	const replacement = structuredClone(record);
	replacement.classContext.definition.title = "Changed while running";
	replacement.classContext.view.class.title = replacement.classContext.definition.title;
	replacement.classContext.definitionSha256 = schoolClassSha256(replacement.classContext.definition);
	assert.throws(() => interrupted.write(replacement), (error: unknown) => error instanceof SchoolEpisodeError && error.code === "CLASS_CONTEXT_DRIFT");
	assert.deepEqual(interrupted.read(record.operationId), record);
	const corrupt = structuredClone(record); corrupt.classContext.definitionSha256 = "wrong";
	writeFileSync(path.join(interrupted.root, record.operationId, "record.json"), JSON.stringify(corrupt));
	assert.throws(() => interrupted.read(record.operationId), (error: unknown) => error instanceof SchoolEpisodeError && error.code === "INCOMPLETE_OR_CORRUPT_RECORD");
});
