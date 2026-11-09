import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { parseSchoolClass, type SchoolClassDefinition } from "../src/core/school-class.ts";
import { schoolGradebook } from "../src/core/school-gradebook.ts";
import type { SchoolEpisodeRecord } from "../src/core/school-episode.ts";
import { SchoolClassStore } from "../src/store/school-classes.ts";
import { SchoolEpisodeStore } from "../src/store/school-episodes.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "school-gradebook-"));
process.env.LH_DATA_DIR = path.join(temporary, "profile");
process.env.LH_AUTH_FILE = path.join(temporary, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { schoolClassGet, schoolClassPost } = await import("../src/server/school-classes.ts");
const { runSchoolEpisode } = await import("../src/server/school-episodes.ts");
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function definition(revision = "r1"): SchoolClassDefinition {
	return parseSchoolClass({
		version: 1, id: "bit-class", revision, title: "Constructing bit systems",
		roster: [{ participantId: "learner-a", roles: ["learner"] }, { participantId: "learner-b", roles: ["learner"] }, { participantId: "teacher", roles: ["teacher"] }],
		curriculum: { id: "bits", revision: "v1", title: "Bit systems", units: [{ id: "parity", title: "Parity", objectives: ["Check parity"], prerequisites: [], world: { id: "bit-world", revision: "v1" } }] },
		schedule: { mode: "self-paced" }, assessment: { evaluator: "trimmed-exact-v1", scale: "case-count" }, peerPolicy: { work: "private" },
	});
}
function stores(name: string) {
	const root = path.join(temporary, name);
	return { root, classStore: new SchoolClassStore(path.join(root, "classes")), episodeStore: new SchoolEpisodeStore(path.join(root, "episodes")) };
}
async function completed(name: string, revision = "r1") {
	const state = stores(name), selected = definition(revision);
	state.classStore.create(selected);
	const result = await runSchoolEpisode({
		version: 2, operationId: name, class: { classId: selected.id, revision, unitId: "parity" },
		world: { id: "bit-world", revision: "v1", subject: "Bits", instructions: "Check the supplied task" },
		learner: { id: "learner-a", model: { provider: "school-fixture", id: "fixture-v1" }, edition: "declared-edition-a" },
		teacher: { id: "teacher", model: { provider: "school-fixture", id: "fixture-v1" } },
		teaching: [{ id: "example", question: "A teaching example", observations: [], expected: "teaching-key-canary" }],
		evaluation: [
			{ id: "target", split: "target", question: "Private target question canary", observations: [], expected: "target-key-canary" },
			{ id: "retention", split: "retention", question: "Private retention question canary", observations: [], expected: "retention-key-canary" },
		],
		limits: { maxOutputTokens: 32, callTimeoutMs: 10000, episodeTimeoutMs: 30000 },
	}, {
		store: state.episodeStore, classStore: state.classStore, evidence: "SCRIPTED_FIXTURE",
		engineFor: (_participant, call) => {
			const text = call.phase === "lesson" ? "private-lesson-canary" : call.caseId === "retention" ? "retention-key-canary" : call.phase === "retry" ? "target-key-canary" : "wrong-answer-canary";
			const faux = createFauxCore({}); faux.setResponses([fauxAssistantMessage(text)]);
			return { model: faux.getModel(), streamFn: faux.streamSimple };
		},
	});
	assert.equal(result.record.status, "COMPLETED");
	return { ...state, definition: selected, record: result.record };
}
const request = (query = "", init?: RequestInit) => new Request(`http://localhost:3000/api/school/classes${query}`, init);
function post(body: unknown, headers: Record<string, string> = {}) { return request("", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json", ...headers }, body: JSON.stringify(body) }); }

test("gradebook projects actual episode grades and keeps an untaught peer visible without inventing a grade", async () => {
	const fixture = await completed("gradebook-complete");
	const book = schoolGradebook(fixture.definition, fixture.episodeStore.list());
	assert.equal(book.learners.length, 2);
	const a = book.learners.find((learner) => learner.participantId === "learner-a")!;
	assert.equal(a.status, "EPISODES");
	assert.equal(a.episodes.length, 1);
	assert.deepEqual(a.episodes[0]!.baseline.counts, { target: { expected: 1, graded: 1, correct: 0 }, retention: { expected: 1, graded: 1, correct: 1 } });
	assert.equal(a.episodes[0]!.retry.counts.target.correct, 1);
	assert.equal(a.episodes[0]!.comparison?.outcome, "CONTEXTUAL_GAIN");
	assert.equal(a.episodes[0]!.learner.edition, "declared-edition-a");
	assert.equal(a.episodes[0]!.evidence, "SCRIPTED_FIXTURE");
	assert.deepEqual(book.learners.find((learner) => learner.participantId === "learner-b"), { participantId: "learner-b", status: "NO_EPISODES", episodes: [] });
	assert.doesNotMatch(JSON.stringify(book), /canary|systemPrompt|"view"|"reply"|"expected"\s*:\s*"/);
});

test("running and failed episodes retain missing and ungraded cases rather than scoring them zero", async () => {
	const fixture = await completed("gradebook-incomplete");
	const running = structuredClone(fixture.record);
	running.operationId = "running"; running.manifest.operationId = "running"; running.status = "RUNNING"; running.calls = []; delete running.comparison;
	const failed = structuredClone(running);
	failed.operationId = "failed"; failed.manifest.operationId = "failed"; failed.status = "FAILED"; failed.error = "provider-error-canary";
	const partial = structuredClone(fixture.record.calls[0]!);
	partial.state = "FAILED"; partial.completion = "UNKNOWN"; partial.error = "call-error-canary"; delete partial.grade; delete partial.reply; delete partial.text;
	failed.calls = [partial];
	const book = schoolGradebook(fixture.definition, [running, failed]);
	const rows = book.learners[0]!.episodes;
	assert.deepEqual(rows.map((row) => row.status).sort(), ["FAILED", "RUNNING"]);
	for (const row of rows) {
		assert.deepEqual(row.baseline.counts.target, { expected: 1, graded: 0, correct: null });
		assert.equal(row.retry.cases[0]!.state, "NOT_ATTEMPTED");
		assert.equal(row.comparison, null);
	}
	const failedCase = rows.find((row) => row.status === "FAILED")!.baseline.cases[0]!;
	assert.equal(failedCase.state, "FAILED"); assert.equal(failedCase.completion, "UNKNOWN"); assert.equal(failedCase.grade, null);
	assert.doesNotMatch(JSON.stringify(book), /canary|"error"|"text"/);
});

test("class revisions and unclassified historical records never share a gradebook", async () => {
	const fixture = await completed("gradebook-revisions");
	assert.equal(schoolGradebook(definition("r2"), [fixture.record]).learners[0]!.status, "NO_EPISODES");
	const historical = structuredClone(fixture.record) as unknown as Record<string, unknown>;
	historical.version = 1; delete historical.classContext;
	const manifest = historical.manifest as Record<string, unknown>; manifest.version = 1; delete manifest.class;
	assert.equal(schoolGradebook(fixture.definition, [historical as unknown as SchoolEpisodeRecord]).learners[0]!.status, "NO_EPISODES");
});

test("conflicting case grades, duplicate episodes and altered class context refuse instead of inflating scores", async () => {
	const fixture = await completed("gradebook-conflicts");
	assert.throws(() => schoolGradebook(fixture.definition, [fixture.record, fixture.record]), /more than once/);
	const duplicate = structuredClone(fixture.record); duplicate.calls.push(structuredClone(duplicate.calls[0]!));
	assert.throws(() => schoolGradebook(fixture.definition, [duplicate]), /conflicting baseline/);
	const badGrade = structuredClone(fixture.record); badGrade.calls[0]!.grade!.split = "retention";
	assert.throws(() => schoolGradebook(fixture.definition, [badGrade]), /invalid retained grade/);
	const badComparison = structuredClone(fixture.record); badComparison.comparison!.retry.target = 99;
	assert.throws(() => schoolGradebook(fixture.definition, [badComparison]), /conflicting comparison/);
	const badClass = structuredClone(fixture.record);
	assert.equal(badClass.version, 2);
	if (badClass.version !== 2) throw new Error("Expected class-bound record");
	assert.ok(badClass.classContext);
	badClass.classContext.definition.title = "A different class definition";
	assert.throws(() => schoolGradebook(fixture.definition, [badClass]), /does not match/);
});

test("a grade without a complete retained reply is refused even when its completion label claims retention", async () => {
	const fixture = await completed("gradebook-missing-reply");
	for (const mutate of [
		(record: SchoolEpisodeRecord) => { record.calls[0]!.state = "REQUESTED"; },
		(record: SchoolEpisodeRecord) => { delete record.calls[0]!.reply; },
		(record: SchoolEpisodeRecord) => { delete record.calls[0]!.text; },
		(record: SchoolEpisodeRecord) => { record.calls[0]!.reply!.stopReason = "length"; },
	]) {
		const changed = structuredClone(fixture.record); delete changed.comparison; mutate(changed);
		assert.throws(() => schoolGradebook(fixture.definition, [changed]), /retained grade evidence/);
	}
});

test("retained raw reply, extracted text, and exact-key correctness must agree", async () => {
	const fixture = await completed("gradebook-forged-grade");
	for (const mutate of [
		(record: SchoolEpisodeRecord) => { record.calls[0]!.grade!.correct = true; },
		(record: SchoolEpisodeRecord) => { record.calls[0]!.text = "target-key-canary"; },
		(record: SchoolEpisodeRecord) => { record.calls[0]!.reply!.content = [{ type: "text", text: "target-key-canary" }]; },
	]) {
		const changed = structuredClone(fixture.record); delete changed.comparison; mutate(changed);
		assert.throws(() => schoolGradebook(fixture.definition, [changed]), /retained grade evidence/);
	}
});

test("a captured participant's changed edition or model cannot be attributed to the manifest learner", async () => {
	const fixture = await completed("gradebook-participant-drift");
	for (const mutate of [
		(record: SchoolEpisodeRecord) => { record.calls[0]!.participant.edition = "another-edition"; },
		(record: SchoolEpisodeRecord) => { record.calls[0]!.participant.model.id = "another-model"; },
	]) {
		const changed = structuredClone(fixture.episodeStore.read(fixture.record.operationId)!); delete changed.comparison; mutate(changed);
		assert.throws(() => schoolGradebook(fixture.definition, [changed]), /case ownership/);
	}
});

test("a failed-after-reply attempt retains its valid grade and failure status", async () => {
	const fixture = await completed("gradebook-failed-after-reply");
	const changed = structuredClone(fixture.record);
	changed.status = "FAILED"; delete changed.comparison;
	changed.calls[0]!.state = "FAILED"; changed.calls[0]!.error = "post-grade-bookkeeping-canary";
	const row = schoolGradebook(fixture.definition, [changed]).learners[0]!.episodes[0]!;
	assert.equal(row.status, "FAILED");
	assert.equal(row.baseline.cases[0]!.state, "FAILED");
	assert.equal(row.baseline.cases[0]!.grade?.correct, false);
	assert.deepEqual(row.baseline.counts.target, { expected: 1, graded: 1, correct: 0 });
	assert.doesNotMatch(JSON.stringify(row), /canary/);
});

test("owner class API registers immutable revisions and serves only an exact gradebook selection", async () => {
	const fixture = await completed("gradebook-http");
	const added = await schoolClassPost(post(definition("r2")), fixture);
	assert.equal(added.status, 201); assert.equal(added.headers.get("cache-control"), "no-store");
	assert.equal((await schoolClassPost(post(definition("r2")), fixture)).status, 200);
	assert.equal((await schoolClassPost(post({ ...definition("r2"), title: "Changed" }), fixture)).status, 409);
	const listing = await schoolClassGet(request(), fixture).json(); assert.equal(listing.classes.length, 2);
	const shown = await schoolClassGet(request("?classId=bit-class&revision=r1"), fixture).json();
	assert.equal(shown.definition.id, "bit-class"); assert.match(shown.sha256, /^[a-f0-9]{64}$/);
	const grades = schoolClassGet(request("?classId=bit-class&revision=r1&gradebook=true"), fixture);
	assert.equal(grades.status, 200); assert.equal(grades.headers.get("cache-control"), "no-store");
	assert.equal((await grades.json()).gradebook.learners[0].episodes.length, 1);
	assert.equal(schoolClassGet(request("?classId=bit-class&revision=missing"), fixture).status, 404);
	for (const query of ["?classId=bit-class", "?revision=r1", "?gradebook=true", "?classId=bit-class&revision=r1&gradebook=false", "?classId=bit-class&classId=other&revision=r1", "?unknown=1"]) assert.equal(schoolClassGet(request(query), fixture).status, 400, query);
});

test("class API rejects cross-origin, malformed and oversized input before storage", async () => {
	const fixture = stores("gradebook-http-refusals");
	assert.equal((await schoolClassPost(post(definition(), { origin: "https://other.example" }), fixture)).status, 403);
	assert.equal((await schoolClassPost(post(definition(), { "sec-fetch-site": "cross-site" }), fixture)).status, 403);
	assert.equal(schoolClassGet(request("", { headers: { origin: "https://other.example" } }), fixture).status, 403);
	assert.equal((await schoolClassPost(post(definition(), { "content-type": "text/plain" }), fixture)).status, 415);
	assert.equal((await schoolClassPost(request("", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: "{" }), fixture)).status, 400);
	assert.equal((await schoolClassPost(post({ padding: "x".repeat(65536) }), fixture)).status, 413);
	assert.deepEqual(fixture.classStore.list(), []);
	assert.equal(fs.existsSync(fixture.root), false);
});

test("desktop class access requires the exact local capability", async () => {
	const fixture = stores("gradebook-desktop"), previousServer = process.env.LH_DESKTOP_SERVER, previousSecret = process.env.LH_DESKTOP_API_SECRET;
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "a".repeat(64);
	try {
		assert.equal(schoolClassGet(request(), fixture).status, 403);
		assert.equal((await schoolClassPost(post(definition()), fixture)).status, 403);
		const capability = { "x-learnharness-desktop": process.env.LH_DESKTOP_API_SECRET };
		assert.equal((await schoolClassPost(post(definition(), capability), fixture)).status, 201);
		assert.equal(schoolClassGet(request("", { headers: capability }), fixture).status, 200);
	} finally {
		if (previousServer === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = previousServer;
		if (previousSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = previousSecret;
	}
});

test("gradebook storage corruption is an explicit refusal, never silent omission", async () => {
	const fixture = await completed("gradebook-corrupt");
	fs.mkdirSync(path.join(fixture.episodeStore.root, "unfinished-operation"));
	const response = schoolClassGet(request("?classId=bit-class&revision=r1&gradebook=true"), fixture);
	assert.equal(response.status, 409);
	assert.equal((await response.json()).code, "INCOMPLETE_OR_CORRUPT_RECORD");
});

test("class CLI registers, inspects and derives grades using one explicit School root", async () => {
	const fixture = await completed("gradebook-cli");
	const source = path.join(temporary, "class-r2.json"); fs.writeFileSync(source, JSON.stringify(definition("r2")));
	const run = (...args: string[]) => {
		const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/school-class.ts", ...args], { cwd: process.cwd(), encoding: "utf8", timeout: 15000, env: { ...process.env, NODE_ENV: "test" } });
		assert.equal(child.status, 0, child.stderr);
		return child.stdout;
	};
	assert.match(run("--help"), /--school/);
	assert.equal(JSON.parse(run("register", source, "--school", fixture.root)).created, true);
	assert.equal(JSON.parse(run("show", "bit-class", "r1", "--school", fixture.root)).definition.revision, "r1");
	assert.equal(JSON.parse(run("list", "--school", fixture.root)).classes.length, 2);
	const grades = JSON.parse(run("grades", "bit-class", "r1", "--school", fixture.root)).gradebook;
	assert.equal(grades.learners[0].episodes[0].comparison.outcome, "CONTEXTUAL_GAIN");
	assert.doesNotMatch(JSON.stringify(grades), /canary/);
});
