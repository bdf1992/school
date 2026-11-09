import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { admitSchoolClassEpisode, parseSchoolClass, parseSchoolClassRef, SchoolClassError, type SchoolClassDefinition, type SchoolClassRef } from "../src/core/school-class.ts";
import { SchoolClassStore, schoolClassSha256 } from "../src/store/school-classes.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "school-classes-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let serial = 0;
const store = () => new SchoolClassStore(path.join(scratch, `store-${++serial}`));
const fixture = (): SchoolClassDefinition => ({
	version: 1, id: "bit-school", revision: "v1", title: "Bit reasoning class",
	roster: [
		{ participantId: "private-learner-a", roles: ["learner"] },
		{ participantId: "private-learner-b", roles: ["learner"] },
		{ participantId: "private-teacher", roles: ["teacher", "learner"] },
	],
	curriculum: {
		id: "byte-reasoning", revision: "v1", title: "From bits to bytes",
		units: [
			{ id: "parity", title: "Parity", objectives: ["Compute parity from observed bits"], prerequisites: [], world: { id: "bits", revision: "v1" } },
			{ id: "machines", title: "Parity machines", objectives: ["Construct a checkable parity machine"], prerequisites: ["parity"], world: { id: "machines", revision: "v2" } },
		],
	},
	schedule: { mode: "self-paced" },
	assessment: { evaluator: "trimmed-exact-v1", scale: "case-count" },
	peerPolicy: { work: "private" },
});
const reference = (): SchoolClassRef => ({ classId: "bit-school", revision: "v1", unitId: "parity" });
const input = () => ({ learnerId: "private-learner-a", teacherId: "private-teacher", world: { id: "bits", revision: "v1" }, now: "2026-11-09T12:00:00Z" });
const scheduled = (): SchoolClassDefinition => ({ ...fixture(), schedule: { mode: "scheduled", sessions: [{ id: "morning", unitId: "parity", startsAt: "2026-11-09T06:00:00-06:00", endsAt: "2026-11-09T07:00:00-06:00" }] } });
function errorCode(action: () => unknown, code: string): void { assert.throws(action, (error: unknown) => error instanceof SchoolClassError && error.code === code); }

test("class definitions retain a shared curriculum while participant projections exclude the private roster", () => {
	const raw = fixture();
	const parsed = parseSchoolClass(raw);
	const admission = admitSchoolClassEpisode(parsed, reference(), input());
	assert.equal(admission.view.class.title, raw.title);
	assert.equal(admission.view.curriculum.revision, "v1");
	assert.deepEqual(admission.view.unit.objectives, ["Compute parity from observed bits"]);
	assert.deepEqual(admission.view.assessment, { evaluator: "trimmed-exact-v1", scale: "case-count" });
	assert.deepEqual(admission.view.peerPolicy, { work: "private" });
	assert.ok(!JSON.stringify(admission.view).includes("private-learner"));
	assert.ok(!JSON.stringify(admission.view).includes("private-teacher"));
	assert.equal(admission.definition.roster.length, 3, "owner evidence retains the exact admitted roster");
	assert.equal(admission.admittedAt, "2026-11-09T12:00:00.000Z");
	assert.ok(Object.isFrozen(admission));
	assert.ok(Object.isFrozen(admission.definition.roster[0]!.roles));
	assert.ok(Object.isFrozen(admission.view.unit.objectives));
	raw.roster[0]!.participantId = "changed-after-admission";
	raw.curriculum.units[0]!.objectives[0] = "changed objective";
	assert.equal(admission.definition.roster[0]!.participantId, "private-learner-a");
	assert.equal(admission.view.unit.objectives[0], "Compute parity from observed bits");
	assert.throws(() => admission.view.unit.objectives.push("mutate"), TypeError);
});

test("class parsing rejects unrecognized fields, model bindings, answer keys, and undeclared sharing", () => {
	const raw = fixture();
	for (const value of [
		{ ...raw, credentials: { apiKey: "must-not-be-stored" } },
		{ ...raw, roster: [{ ...raw.roster[0], model: { provider: "local", id: "same-weights" } }, ...raw.roster.slice(1)] },
		{ ...raw, curriculum: { ...raw.curriculum, units: [{ ...raw.curriculum.units[0], expected: "answer-key" }, raw.curriculum.units[1]] } },
		{ ...raw, peerPolicy: { work: "shared" } },
		{ ...raw, assessment: { evaluator: "model-opinion", scale: "case-count" } },
		{ ...raw, assessment: { ...raw.assessment, targetCases: 3 } },
	]) errorCode(() => parseSchoolClass(value), "INVALID_CLASS");
});

test("class identities, memberships, and roles are explicit and unambiguous", () => {
	const raw = fixture();
	for (const value of [
		{ ...raw, id: "../outside" }, { ...raw, revision: "../outside" },
		{ ...raw, roster: [...raw.roster, raw.roster[0]] },
		{ ...raw, roster: [{ participantId: "learner", roles: ["learner", "learner"] }, raw.roster[2]] },
		{ ...raw, roster: [{ participantId: "learner", roles: ["owner"] }] },
		{ ...raw, roster: raw.roster.slice(0, 2) },
		{ ...raw, roster: [] },
	]) errorCode(() => parseSchoolClass(value), "INVALID_CLASS");
	errorCode(() => parseSchoolClassRef({ ...reference(), sessionId: "../session" }), "INVALID_CLASS");
	errorCode(() => parseSchoolClassRef({ ...reference(), teacherId: "smuggled-role" }), "INVALID_CLASS");
});

test("curriculum prerequisites resolve across units and reject cycles or missing identities", () => {
	const raw = fixture();
	const reordered = { ...raw, curriculum: { ...raw.curriculum, units: [...raw.curriculum.units].reverse() } };
	assert.deepEqual(parseSchoolClass(reordered).curriculum.units[0]!.prerequisites, ["parity"], "references need not follow array order");
	for (const prerequisite of ["missing", "parity", "machines"]) {
		const invalid = fixture();
		invalid.curriculum.units[0]!.prerequisites = [prerequisite];
		errorCode(() => parseSchoolClass(invalid), "INVALID_CLASS");
	}
	const duplicate = fixture(); duplicate.curriculum.units.push(duplicate.curriculum.units[0]!);
	errorCode(() => parseSchoolClass(duplicate), "INVALID_CLASS");
	const repeated = fixture(); repeated.curriculum.units[1]!.prerequisites = ["parity", "parity"];
	errorCode(() => parseSchoolClass(repeated), "INVALID_CLASS");
});

test("admission binds enrolled roles, class revision, unit, and the unit's world revision", () => {
	const def = fixture();
	errorCode(() => admitSchoolClassEpisode(def, reference(), { ...input(), learnerId: "outside-learner" }), "CLASS_PARTICIPANT_NOT_ENROLLED");
	errorCode(() => admitSchoolClassEpisode(def, reference(), { ...input(), teacherId: "private-learner-b" }), "CLASS_ROLE_REQUIRED");
	errorCode(() => admitSchoolClassEpisode(def, { ...reference(), revision: "v2" }, input()), "CLASS_MISMATCH");
	errorCode(() => admitSchoolClassEpisode(def, { ...reference(), unitId: "missing" }, input()), "CLASS_UNIT_NOT_FOUND");
	errorCode(() => admitSchoolClassEpisode(def, reference(), { ...input(), world: { id: "bits", revision: "v2" } }), "CLASS_WORLD_MISMATCH");
	errorCode(() => admitSchoolClassEpisode(def, { ...reference(), unitId: "machines" }, input()), "CLASS_WORLD_MISMATCH");
	const advanced = admitSchoolClassEpisode(def, { ...reference(), unitId: "machines" }, { ...input(), world: { id: "machines", revision: "v2" } });
	assert.deepEqual(advanced.view.unit.prerequisites, ["parity"], "dependencies are retained; this admission does not invent mastery evidence");
	assert.equal(admitSchoolClassEpisode(def, reference(), { ...input(), learnerId: "private-learner-b" }).definition.roster.length, 3);
});

test("dated sessions normalize timezones and admit only within the selected [start, end) window", () => {
	const def = parseSchoolClass(scheduled());
	assert.equal(def.schedule.mode, "scheduled");
	if (def.schedule.mode !== "scheduled") throw new Error("scheduled fixture");
	assert.equal(def.schedule.sessions[0]!.startsAt, "2026-11-09T12:00:00.000Z");
	assert.equal(def.schedule.sessions[0]!.endsAt, "2026-11-09T13:00:00.000Z");
	const ref = { ...reference(), sessionId: "morning" };
	const admission = admitSchoolClassEpisode(def, ref, input());
	assert.equal(admission.view.schedule.mode, "scheduled");
	assert.equal(admitSchoolClassEpisode(def, ref, { ...input(), now: new Date("2026-11-09T12:59:59.999Z") }).reference.sessionId, "morning");
	errorCode(() => admitSchoolClassEpisode(def, ref, { ...input(), now: "2026-11-09T11:59:59.999Z" }), "CLASS_SESSION_CLOSED");
	errorCode(() => admitSchoolClassEpisode(def, ref, { ...input(), now: Date.parse("2026-11-09T13:00:00Z") }), "CLASS_SESSION_CLOSED");
	assert.equal(admission.admittedAt, "2026-11-09T12:00:00.000Z", "later admission failures do not revoke an already recorded start");
	errorCode(() => admitSchoolClassEpisode(def, reference(), input()), "CLASS_SESSION_REQUIRED");
	errorCode(() => admitSchoolClassEpisode(def, { ...ref, sessionId: "other-session" }, input()), "CLASS_SESSION_NOT_FOUND");
	errorCode(() => admitSchoolClassEpisode(def, { ...ref, unitId: "machines" }, { ...input(), world: { id: "machines", revision: "v2" } }), "CLASS_SESSION_MISMATCH");
});

test("schedules reject timezone ambiguity, invalid dates, unknown units, and reversed windows", () => {
	for (const startsAt of ["2026-11-09T12:00:00", "2026-02-30T12:00:00Z", "2026-11-09T24:00:00Z", "2026-11-09T12:00:00+24:00", "not-a-date", "2026-11-09T13:00:00Z"]) {
		const def = scheduled();
		if (def.schedule.mode !== "scheduled") throw new Error("scheduled fixture");
		def.schedule.sessions[0]!.startsAt = startsAt;
		errorCode(() => parseSchoolClass(def), "INVALID_CLASS");
	}
	const missing = scheduled();
	if (missing.schedule.mode !== "scheduled") throw new Error("scheduled fixture");
	missing.schedule.sessions[0]!.unitId = "missing";
	errorCode(() => parseSchoolClass(missing), "INVALID_CLASS");
	const duplicate = scheduled();
	if (duplicate.schedule.mode !== "scheduled") throw new Error("scheduled fixture");
	duplicate.schedule.sessions.push(duplicate.schedule.sessions[0]!);
	errorCode(() => parseSchoolClass(duplicate), "INVALID_CLASS");
	errorCode(() => parseSchoolClass({ ...fixture(), schedule: { mode: "self-paced", sessions: [] } }), "INVALID_CLASS");
});

test("self-paced classes still require valid admission time and cannot invent dated sessions", () => {
	errorCode(() => admitSchoolClassEpisode(fixture(), { ...reference(), sessionId: "invented" }, input()), "CLASS_SESSION_UNEXPECTED");
	errorCode(() => admitSchoolClassEpisode(fixture(), reference(), { ...input(), now: NaN }), "INVALID_CLASS");
	errorCode(() => admitSchoolClassEpisode(fixture(), reference(), { ...input(), now: "2026-11-09T12:00:00" }), "INVALID_CLASS");
	assert.deepEqual(admitSchoolClassEpisode(fixture(), reference(), input()).view.schedule, { mode: "self-paced" });
});

test("numeric and Date admission clocks produce timestamps that can be admitted again", () => {
	for (const year of [-1, 10000]) {
		const time = Date.UTC(year, 0, 1);
		for (const now of [time, new Date(time), new Date(time).toISOString()]) errorCode(() => admitSchoolClassEpisode(fixture(), reference(), { ...input(), now }), "INVALID_CLASS");
	}
	const admitted = admitSchoolClassEpisode(fixture(), reference(), { ...input(), now: Date.UTC(9999, 0, 1) });
	assert.equal(admitted.admittedAt, "9999-01-01T00:00:00.000Z");
	assert.deepEqual(admitSchoolClassEpisode(fixture(), reference(), { ...input(), now: admitted.admittedAt }), admitted);
});

test("class storage is idempotent, survives reopening, and keeps every explicit revision", () => {
	const records = store();
	assert.deepEqual(records.list(), []);
	assert.equal(existsSync(records.root), false, "listing does not create storage");
	const first = records.create(fixture());
	assert.equal(first.created, true);
	const { title, ...fields } = fixture();
	const reordered = { title, ...fields };
	assert.equal(records.create(reordered).created, false);
	assert.equal(records.inspect("bit-school", "v1")?.sha256, first.sha256);
	const next = fixture(); next.revision = "v2"; next.title = "Second class revision";
	assert.equal(records.create(next).created, true);
	const reopened = new SchoolClassStore(records.root);
	assert.deepEqual(reopened.get("bit-school", "v1"), fixture());
	assert.equal(reopened.get("bit-school", "v2")?.title, "Second class revision");
	assert.equal(reopened.get("bit-school", "missing"), null);
	assert.deepEqual(reopened.list().map(({ id, revision }) => ({ id, revision })), [{ id: "bit-school", revision: "v1" }, { id: "bit-school", revision: "v2" }]);
});

test("changed contents under an existing class revision are refused without overwriting its record", () => {
	const records = store(); records.create(fixture());
	const file = path.join(records.root, "bit-school", "v1", "definition.json");
	const original = readFileSync(file, "utf8");
	const changed = fixture(); changed.roster[0]!.participantId = "replacement-learner";
	errorCode(() => records.create(changed), "CLASS_REVISION_CONFLICT");
	assert.equal(readFileSync(file, "utf8"), original);
	assert.equal(records.get("bit-school", "v1")?.roster[0]?.participantId, "private-learner-a");
});

test("equivalent timezone encodings and object key order retain the class definition digest", () => {
	const def = scheduled(), normalized = parseSchoolClass(def);
	assert.equal(schoolClassSha256(def), schoolClassSha256(normalized));
	const reversed = Object.fromEntries(Object.entries(def).reverse()) as unknown as SchoolClassDefinition;
	assert.equal(schoolClassSha256(reversed), schoolClassSha256(def));
	const changed = fixture(); changed.curriculum.units[0]!.objectives[0] = "A different objective";
	assert.notEqual(schoolClassSha256(changed), schoolClassSha256(fixture()));
});

test("incomplete claims and corrupted definitions fail explicitly and are never replaced", () => {
	const incomplete = store();
	mkdirSync(path.join(incomplete.root, "bit-school", "v1"), { recursive: true });
	errorCode(() => incomplete.get("bit-school", "v1"), "INCOMPLETE_OR_CORRUPT_CLASS");
	errorCode(() => incomplete.create(fixture()), "INCOMPLETE_OR_CORRUPT_CLASS");
	assert.equal(existsSync(path.join(incomplete.root, "bit-school", "v1", "definition.json")), false);
	const corrupt = store(); corrupt.create(fixture());
	const file = path.join(corrupt.root, "bit-school", "v1", "definition.json");
	const record = JSON.parse(readFileSync(file, "utf8")); record.definition.title = "Tampered";
	writeFileSync(file, JSON.stringify(record));
	errorCode(() => corrupt.get("bit-school", "v1"), "INCOMPLETE_OR_CORRUPT_CLASS");
	errorCode(() => corrupt.create(fixture()), "INCOMPLETE_OR_CORRUPT_CLASS");
	errorCode(() => corrupt.list(), "INCOMPLETE_OR_CORRUPT_CLASS");
	assert.equal(JSON.parse(readFileSync(file, "utf8")).definition.title, "Tampered", "the reader does not silently repair an untrusted record");
});

test("storage refuses files in class or revision directory positions and bounds definitions", () => {
	const classConflict = store(); mkdirSync(classConflict.root); writeFileSync(path.join(classConflict.root, "bit-school"), "existing file");
	errorCode(() => classConflict.create(fixture()), "CLASS_STORE_CONFLICT");
	errorCode(() => classConflict.get("bit-school", "v1"), "CLASS_STORE_CONFLICT");
	const revisionConflict = store(); mkdirSync(path.join(revisionConflict.root, "bit-school"), { recursive: true }); writeFileSync(path.join(revisionConflict.root, "bit-school", "v1"), "existing file");
	errorCode(() => revisionConflict.create(fixture()), "CLASS_STORE_CONFLICT");
	const oversized = store();
	errorCode(() => oversized.create({ ...fixture(), title: "x".repeat(65536) }), "CLASS_TOO_LARGE");
	assert.equal(existsSync(oversized.root), false, "invalid input never claims a class revision");
	errorCode(() => oversized.get("../outside", "v1"), "INVALID_CLASS");
});

test("dangling links occupy class identities and revisions instead of appearing absent", (t) => {
	for (const location of ["class", "revision"]) {
		const records = store();
		const parent = location === "class" ? records.root : path.join(records.root, "bit-school");
		mkdirSync(parent, { recursive: true });
		const link = path.join(parent, location === "class" ? "bit-school" : "v1");
		try { symlinkSync(path.join(scratch, "missing-directory"), link, "dir"); }
		catch (error) {
			if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("Windows did not grant directory-symlink creation"); return; }
			throw error;
		}
		errorCode(() => records.get("bit-school", "v1"), "CLASS_STORE_CONFLICT");
		errorCode(() => records.create(fixture()), "CLASS_STORE_CONFLICT");
		errorCode(() => records.list(), "CLASS_STORE_CONFLICT");
		assert.equal(lstatSync(link).isSymbolicLink(), true, "inspection and creation preserve the occupied path");
	}
});
