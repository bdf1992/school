import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { SchoolCallRecord, SchoolEpisodeRecord } from "../src/core/school-episode.ts";
import { generateSchoolExperiment, schoolExposureForCall, validateSchoolExperimentEvidence, type SchoolExperimentCondition, type SchoolExperimentManifest } from "../src/core/school-experiment.ts";
import { schoolGradebook } from "../src/core/school-gradebook.ts";
import { SchoolClassStore } from "../src/store/school-classes.ts";
import { SchoolEpisodeStore } from "../src/store/school-episodes.ts";
import { SchoolParticipantStore } from "../src/store/school-participants.ts";
import { createScriptedFactorizedEngine, FACTORIZED_FIXTURE_LESSON, FACTORIZED_HARMFUL_RULE, type FactorizedFixtureControl } from "../examples/school/scripted-factorized.ts";

// All replies traverse the production participant/episode/store path. Account
// configuration and external requests are unavailable in this test process.
const scratch = mkdtempSync(path.join(tmpdir(), "school-experiment-test-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { ...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}), NODE_ENV: "test", HOME: scratch, LH_DATA_DIR: scratch, LH_AUTH_FILE: path.join(scratch, "auth.json"), LH_IGNORE_ENV_KEYS: "1" };
globalThis.fetch = async () => { throw new Error("CLOSED: no network in School experiment tests"); };
const { runSchoolEpisode } = await import("../src/server/school-episodes.ts");
after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; rmSync(scratch, { recursive: true, force: true }); });

const classStore = new SchoolClassStore(path.join(scratch, "classes"));
classStore.create(JSON.parse(readFileSync(new URL("../examples/school/factorized-class.json", import.meta.url), "utf8")));
let serial = 0;
function manifest(control: FactorizedFixtureControl = "helpful"): SchoolExperimentManifest {
	const model = { provider: "school-fixture", id: `scripted-factorized-${control}-v1`, thinkingLevel: "off" as const };
	return generateSchoolExperiment({ seed: 19, operationId: `factor-${++serial}`, learner: { id: "local-learner", model }, teacher: { id: "teacher", model } });
}
const evidenceStore = () => new SchoolEpisodeStore(path.join(scratch, `episodes-${++serial}`));
const condition = (record: SchoolEpisodeRecord, name: SchoolExperimentCondition) => record.experiment!.conditions.find((item) => item.condition === name)!;
const options = (control: FactorizedFixtureControl = "helpful") => ({ classStore, store: evidenceStore(), evidence: "SCRIPTED_FIXTURE" as const, engineFor: createScriptedFactorizedEngine(control) });
class Snapshots extends SchoolEpisodeStore {
	readonly snapshots: SchoolEpisodeRecord[] = [];
	override write(record: SchoolEpisodeRecord) { super.write(record); this.snapshots.push(structuredClone(record)); }
}

test("helpful control runs baseline, teaching, assisted, cold, then fresh transfer through the real runner", async () => {
	const source = manifest(), snapshots = new Snapshots(path.join(scratch, "snapshots"));
	const { record } = await runSchoolEpisode(source, { ...options(), store: snapshots });
	assert.equal(record.status, "COMPLETED", record.error);
	assert.equal(record.evidence, "SCRIPTED_FIXTURE");
	assert.equal(record.calls.length, 17);
	assert.deepEqual(record.calls.map((call) => call.phase), [...Array(4).fill("baseline"), "lesson", ...Array(4).fill("retry"), ...Array(4).fill("cold"), ...Array(4).fill("transfer")]);
	assert.equal(record.comparison?.outcome, "CONTEXTUAL_GAIN");
	assert.equal(condition(record, "baseline").target.correct, 0);
	assert.equal(condition(record, "assisted").target.correct, 3);
	assert.equal(condition(record, "cold").target.correct, 0);
	assert.equal(condition(record, "transfer").target.correct, 3);
	assert.equal(condition(record, "transfer").assistance, "lesson");
	for (const result of record.experiment!.conditions) { assert.equal(result.coverage, "SUFFICIENT"); assert.equal(result.retention.correct, 1); }
	assert.equal(record.experiment?.weightLearning, "NOT_PERFORMED");
	assert.equal(record.experiment?.persistence, "NOT_ESTABLISHED");
	assert.equal(record.experiment?.generalization, "NOT_ESTABLISHED");
	for (const call of record.calls.filter((item) => item.role === "learner")) {
		const raw = snapshots.snapshots.find((saved) => saved.events.at(-1)?.kind === "RAW_REPLY_COMMITTED" && saved.events.at(-1)?.callId === call.id)!;
		assert.ok(raw.calls.find((item) => item.id === call.id)!.reply);
		assert.equal(raw.calls.find((item) => item.id === call.id)!.grade, undefined);
	}
	assert.deepEqual(snapshots.read(source.operationId), record);
});

test("sealed inputs and grades never enter teacher diagnostics or unrelated learner views", async () => {
	const source = manifest(), base = createScriptedFactorizedEngine();
	const { record } = await runSchoolEpisode(source, { ...options(), engineFor: (participant, call) => {
		const view = call.view as Record<string, unknown>, serialized = JSON.stringify(view);
		assert.ok(!Object.hasOwn(view, "experiment"));
		assert.ok(!Object.hasOwn(view, "evaluation"));
		assert.ok(!Object.hasOwn(view, "transfer"));
		assert.ok(!Object.hasOwn(view, "savedMemory"));
		if (call.role === "teacher") {
			for (const item of [...source.evaluation, ...source.experiment.transfer]) assert.ok(!serialized.includes(item.id));
			assert.ok(serialized.includes(source.teaching[0]!.id));
		} else {
			assert.ok(!serialized.includes('"expected"'));
			assert.ok(!serialized.includes('"split"'));
			assert.equal(Object.hasOwn(view, "lesson"), call.phase === "retry" || call.phase === "transfer");
			for (const item of source.experiment.transfer) if (call.caseId !== item.id) assert.ok(!serialized.includes(item.id));
		}
		return base(participant, call);
	} });
	assert.equal(record.status, "COMPLETED", record.error);
	assert.equal(record.calls.filter((call) => call.role === "teacher").length, 1);
	assert.ok(record.calls.findIndex((call) => call.role === "teacher") < record.calls.findIndex((call) => call.phase === "transfer"));
});

test("every requested condition has a reproducible exposure receipt before its raw reply", async () => {
	const snapshots = new Snapshots(path.join(scratch, "exposure-snapshots"));
	const { record } = await runSchoolEpisode(manifest(), { ...options(), store: snapshots });
	assert.equal(record.exposures!.length, 17);
	for (const [index, call] of record.calls.entries()) {
		assert.deepEqual(record.exposures![index], await schoolExposureForCall(call, index));
		const requested = snapshots.snapshots.find((saved) => saved.events.at(-1)?.kind === "CALL_REQUESTED" && saved.events.at(-1)?.callId === call.id)!;
		assert.deepEqual(requested.exposures?.at(-1), record.exposures![index]);
		assert.equal(requested.calls.at(-1)?.reply, undefined);
	}
	const baseline = record.exposures![0]!, cold = record.exposures!.find((receipt) => receipt.condition === "cold" && receipt.caseId === baseline.caseId)!;
	assert.equal(baseline.viewSha256, cold.viewSha256, "the cold call has exactly the unassisted prepared view");
	assert.equal(cold.lessonSha256, undefined); assert.equal(cold.memorySha256, undefined);
});

test("a harmful teaching control cannot hide lost retention behind target gains", async () => {
	const { record } = await runSchoolEpisode(manifest("harmful"), options("harmful"));
	assert.equal(record.status, "COMPLETED", record.error);
	assert.equal(record.comparison?.outcome, "REGRESSION");
	assert.ok(record.calls.find((call) => call.phase === "lesson")!.text!.includes(FACTORIZED_HARMFUL_RULE));
	assert.equal(condition(record, "assisted").target.correct, 3);
	assert.equal(condition(record, "assisted").retention.correct, 0);
	assert.deepEqual(condition(record, "assisted").regressions, [record.manifest.evaluation.at(-1)!.id]);
	assert.equal(condition(record, "cold").retention.correct, 1);
	assert.equal(condition(record, "transfer").retention.correct, 0);
});

test("a memorizing control improves diagnostics but fails every new target instance", async () => {
	const { record } = await runSchoolEpisode(manifest("memorizing"), options("memorizing"));
	assert.equal(record.status, "COMPLETED", record.error);
	assert.equal(record.comparison?.outcome, "CONTEXTUAL_GAIN");
	assert.equal(condition(record, "assisted").target.correct, 3);
	assert.equal(condition(record, "transfer").target.correct, 0);
	assert.equal(condition(record, "transfer").retention.correct, 1);
	assert.equal(record.experiment?.generalization, "NOT_ESTABLISHED");
});

test("identical operation replays all raw evidence, grades and exposure receipts without another call", async () => {
	const source = manifest(), runOptions = options();
	const first = await runSchoolEpisode(source, runOptions);
	const replay = await runSchoolEpisode(source, { ...runOptions, engineFor: () => { throw new Error("A terminal replay must not dispatch"); } });
	assert.equal(replay.replayed, true); assert.deepEqual(replay.record, first.record);
	const changed = structuredClone(source); changed.experiment.transfer[0]!.expected = "0";
	await assert.rejects(runSchoolEpisode(changed, runOptions), /differs/);
});

test("a stopped final phase reports missing coverage instead of fabricated wrong answers", async () => {
	const base = createScriptedFactorizedEngine();
	const { record } = await runSchoolEpisode(manifest(), { ...options(), engineFor: (participant, call) => {
		if (call.phase === "transfer") throw new Error("scripted refusal before transfer dispatch");
		return base(participant, call);
	} });
	assert.equal(record.status, "FAILED");
	assert.equal(condition(record, "assisted").coverage, "SUFFICIENT");
	assert.equal(condition(record, "transfer").coverage, "ABSENT");
	assert.equal(condition(record, "transfer").target.correct, null);
	assert.equal(record.calls.at(-1)!.completion, "NO_CALL_ADMITTED");
	assert.equal(record.exposures!.at(-1)!.delivery, "NOT_ATTESTED");
	assert.equal(record.comparison, undefined);
});

function registerMemory(source: SchoolExperimentManifest, memoryText: string, root = path.join(scratch, `registry-${++serial}`)): SchoolParticipantStore {
	const registry = new SchoolParticipantStore(root);
	registry.createParticipant({ version: 1, id: source.learner.id, label: "Scripted learner", kind: "model" });
	registry.createConnection({ version: 1, id: "fixture", revision: "1", label: "Scripted transport only", kind: "configured", provider: "school-fixture" });
	registry.createState({ version: 1, participantId: source.learner.id, revision: "memory-1", model: source.learner.model, connection: { id: "fixture", revision: "1" }, memory: { text: memoryText, sourceIds: ["owner-authored-fixture-memory"] }, artifacts: [] });
	source.learner.stateRef = { revision: "memory-1" };
	return registry;
}

test("registered saved memory is isolated to the memory condition while all other contexts stay clean", async () => {
	const source = manifest(); source.experiment.memory = true;
	const memoryText = `${FACTORIZED_FIXTURE_LESSON} MEMORY_ONLY_4937`, registry = registerMemory(source, memoryText);
	const { record } = await runSchoolEpisode(source, { ...options(), registry });
	assert.equal(record.status, "COMPLETED", `${record.error ?? ""} ${record.calls.at(-1)?.reply?.errorMessage ?? ""}`);
	assert.equal(record.calls.length, 21);
	assert.equal(condition(record, "baseline").target.correct, 0);
	assert.equal(condition(record, "cold").target.correct, 0);
	assert.equal(condition(record, "memory").target.correct, 3);
	assert.equal(condition(record, "memory").assistance, "saved-memory");
	assert.ok(record.bindings?.learner?.memorySha256);
	for (const call of record.calls) {
		const view = call.view as { savedMemory?: { text: string }; lesson?: string };
		assert.equal(JSON.stringify(view).includes("MEMORY_ONLY_4937"), call.phase === "memory");
		if (call.phase === "memory") { assert.equal(view.savedMemory?.text, memoryText); assert.equal(view.lesson, undefined); }
	}
	assert.equal(record.exposures!.filter((receipt) => receipt.memorySha256).length, 4);
	assert.equal(record.experiment?.weightLearning, "NOT_PERFORMED");
});

test("a requested memory condition with missing or empty saved memory refuses before any dispatch", async () => {
	const source = manifest(); source.experiment.memory = true;
	const runOptions = options(); let called = false;
	const engineFor = (_participant: unknown, _call: SchoolCallRecord): never => { called = true; throw new Error("must not dispatch"); };
	await assert.rejects(runSchoolEpisode(source, { ...runOptions, engineFor }), /nonempty saved memory/);
	const registry = registerMemory(source, "   ");
	await assert.rejects(runSchoolEpisode(source, { ...runOptions, registry, engineFor }), /nonempty saved memory/);
	assert.equal(called, false);
	assert.equal(runOptions.store.read(source.operationId), null);
});

test("gradebook refuses inflated transfer summaries and grades that contradict retained raw answers", async () => {
	const { record } = await runSchoolEpisode(manifest("memorizing"), options("memorizing"));
	const definition = classStore.get("learning-dynamics", "1")!;
	const book = schoolGradebook(definition, [record]);
	assert.equal(book.learners[0]!.episodes[0]!.experiment!.conditions.find((item) => item.condition === "transfer")!.target.correct, 0);
	assert.doesNotMatch(JSON.stringify(book), /"observations"|"systemPrompt"|"view"|"reply"|"expected"\s*:\s*"|"lesson"\s*:/);
	const inflated = structuredClone(record);
	inflated.experiment!.conditions.find((item) => item.condition === "transfer")!.target.correct = 3;
	assert.throws(() => schoolGradebook(definition, [inflated]), { code: "GRADEBOOK_RECORD_CONFLICT" });
	const forged = structuredClone(inflated);
	for (const call of forged.calls.filter((item) => item.phase === "transfer" && item.grade?.split === "target")) call.grade!.correct = true;
	assert.throws(() => schoolGradebook(definition, [forged]), { code: "GRADEBOOK_RECORD_CONFLICT" });
	const missingRaw = structuredClone(record);
	delete missingRaw.calls.find((item) => item.phase === "transfer")!.reply;
	assert.throws(() => schoolGradebook(definition, [missingRaw]), { code: "GRADEBOOK_RECORD_CONFLICT" });
});

test("stored experimental views and every receipt field remain bound after reopening", async () => {
	const runOptions = options(), { record } = await runSchoolEpisode(manifest(), runOptions);
	const filename = path.join(runOptions.store.root, record.operationId, "record.json");
	for (const mutate of [
		(copy: SchoolEpisodeRecord) => { copy.exposures![0]!.viewSha256 = "0".repeat(64); },
		(copy: SchoolEpisodeRecord) => { copy.exposures![0]!.problemSha256 = "0".repeat(64); },
		(copy: SchoolEpisodeRecord) => { copy.exposures![0]!.condition = "transfer"; },
		(copy: SchoolEpisodeRecord) => { (copy.exposures![0] as unknown as { delivery: string }).delivery = "DELIVERED"; },
		(copy: SchoolEpisodeRecord) => { copy.exposures!.pop(); },
		(copy: SchoolEpisodeRecord) => { (copy.calls[0]!.view as { problem: { question: string } }).problem.question = "a changed task"; },
	]) {
		const changed = structuredClone(record); mutate(changed);
		writeFileSync(filename, JSON.stringify(changed));
		assert.throws(() => new SchoolEpisodeStore(runOptions.store.root).read(record.operationId), /incomplete or corrupt/);
	}
	writeFileSync(filename, JSON.stringify(record));
	assert.deepEqual(new SchoolEpisodeStore(runOptions.store.root).read(record.operationId), record);
});

test("a fresh exposure hash cannot relabel assisted work as cold or disguise a changed experiment plan", async () => {
	const runOptions = options(), { record } = await runSchoolEpisode(manifest(), runOptions);
	assert.deepEqual(validateSchoolExperimentEvidence(record), { memoryChecks: [] });
	const forged = structuredClone(record), coldIndex = forged.calls.findIndex((call) => call.phase === "cold");
	(forged.calls[coldIndex]!.view as Record<string, unknown>).lesson = forged.calls.find((call) => call.phase === "lesson")!.text;
	forged.exposures![coldIndex] = await schoolExposureForCall(forged.calls[coldIndex]!, coldIndex);
	assert.throws(() => validateSchoolExperimentEvidence(forged), /view does not match its declared condition/);
	const lateTeacher = structuredClone(record), teacher = structuredClone(lateTeacher.calls.find((call) => call.phase === "lesson")!);
	teacher.id = `${lateTeacher.operationId}-${lateTeacher.calls.length + 1}`; lateTeacher.calls.push(teacher);
	lateTeacher.exposures!.push(await schoolExposureForCall(teacher, lateTeacher.calls.length - 1));
	assert.throws(() => validateSchoolExperimentEvidence(lateTeacher), /call plan/);
	const missingFinal = structuredClone(record); missingFinal.calls = missingFinal.calls.filter((call) => call.phase !== "transfer"); missingFinal.exposures = missingFinal.exposures!.slice(0, missingFinal.calls.length);
	assert.throws(() => validateSchoolExperimentEvidence(missingFinal), /call plan/);
	const changedPrompt = structuredClone(record); changedPrompt.calls[coldIndex]!.systemPrompt += " Use the lesson secretly.";
	assert.throws(() => validateSchoolExperimentEvidence(changedPrompt), /system prompt changed/);
	const premature = structuredClone(record); delete premature.calls[0]!.grade;
	assert.throws(() => validateSchoolExperimentEvidence(premature), /retained grade/);
	const filename = path.join(runOptions.store.root, record.operationId, "record.json");
	writeFileSync(filename, JSON.stringify(forged));
	assert.throws(() => new SchoolEpisodeStore(runOptions.store.root).read(record.operationId), { code: "INCOMPLETE_OR_CORRUPT_RECORD" });
	assert.throws(() => schoolGradebook(classStore.get("learning-dynamics", "1")!, [forged]), { code: "GRADEBOOK_RECORD_CONFLICT" });
	writeFileSync(filename, JSON.stringify(record));
});

test("recomputed view receipts cannot replace the saved memory pinned at admission", async () => {
	const source = manifest(); source.experiment.memory = true;
	const registry = registerMemory(source, FACTORIZED_FIXTURE_LESSON), runOptions = { ...options(), registry };
	const { record } = await runSchoolEpisode(source, runOptions), changed = structuredClone(record);
	assert.equal(record.status, "COMPLETED", record.error);
	for (const [index, call] of changed.calls.entries()) if (call.phase === "memory") {
		(call.view as { savedMemory: { text: string } }).savedMemory.text += " This was changed after admission.";
		changed.exposures![index] = await schoolExposureForCall(call, index);
	}
	const checks = validateSchoolExperimentEvidence(changed).memoryChecks;
	assert.equal(checks.length, 4, "the pure validator delegates pinned-memory hash checks to the store");
	assert.ok(checks.every((check) => check.expectedSha256 === record.bindings!.learner!.memorySha256));
	const filename = path.join(runOptions.store.root, record.operationId, "record.json");
	writeFileSync(filename, JSON.stringify(changed));
	assert.throws(() => new SchoolEpisodeStore(runOptions.store.root).read(record.operationId), { code: "INCOMPLETE_OR_CORRUPT_RECORD" });
	writeFileSync(filename, JSON.stringify(record));
});

test("the CLI generates, checks, runs and replays production fixtures including a registered memory state", () => {
	const root = path.join(scratch, "cli-school"), filename = path.join(scratch, "cli-factorized.json");
	const noNetwork = path.join(scratch, "no-network.mjs");
	writeFileSync(noNetwork, 'globalThis.fetch = async () => { throw new Error("CLOSED: no CLI fixture network"); };\n');
	const command = (...args: string[]) => spawnSync(process.execPath, ["--import", noNetwork, "--import", "tsx", "scripts/school-experiment.ts", ...args], { cwd: process.cwd(), encoding: "utf8", timeout: 15000, env: { ...process.env, NODE_ENV: "test" } });
	const run = (...args: string[]): Record<string, unknown> => {
		const child = command(...args); assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
	};
	assert.equal(run("generate", "--seed", "23", "--operation", "cli-factor-23", "--output", filename).plannedCalls, 17);
	assert.equal(run("check", filename).answerKeyCheck, "INDEPENDENT_EXACT_ARITHMETIC");
	const args = ["run", filename, "--fixture", "helpful", "--class", "examples/school/factorized-class.json", "--school", root];
	const first = run(...args); assert.equal(first.status, "COMPLETED"); assert.equal(first.calls, 17); assert.equal(first.evidence, "SCRIPTED_FIXTURE");
	const replay = run(...args); assert.equal(replay.replayed, true);
	const duplicate = command("generate", "--seed", "24", "--operation", "another", "--output", filename);
	assert.equal(duplicate.status, 1); assert.match(duplicate.stderr, /EEXIST/);
	const source = manifest(); source.experiment.memory = true;
	registerMemory(source, FACTORIZED_FIXTURE_LESSON, path.join(root, "registry"));
	const memoryFile = path.join(scratch, "cli-memory.json"); writeFileSync(memoryFile, JSON.stringify(source));
	const memory = run("run", memoryFile, "--fixture", "helpful", "--school", root);
	assert.equal(memory.status, "COMPLETED"); assert.equal(memory.calls, 21);
	const saved = new SchoolEpisodeStore(path.join(root, "episodes")).read(source.operationId)!;
	assert.deepEqual(saved.manifest.learner.stateRef, source.learner.stateRef);
	assert.equal(condition(saved, "memory").target.correct, 3);
});
