import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeSchoolReply, parseSchoolEpisode, type SchoolCallRecord, type SchoolCase } from "../src/core/school-episode.ts";
import { checkFactorizedAnswer, factorizedCaseIdentity, factorizedCaseParameters, factorizedTaskAnswer, generateSchoolExperiment, generatedFactorizedCases, parseFactorizedParameters, parseSchoolExperiment, schoolExperimentCallCount, schoolExposureForCall, summarizeSchoolExperiment, verifyFactorizedCase, type SchoolExperimentManifest } from "../src/core/school-experiment.ts";

const input = () => generateSchoolExperiment({ seed: 19, operationId: "factor-test" });
const protocol = (manifest: SchoolExperimentManifest) => parseSchoolExperiment(manifest.experiment, manifest.teaching, manifest.evaluation, manifest.world);

test("equal present products can have different next steps, checked with exact fractions", () => {
	const parameters = { operation: "step", a: "2", b: "3", x: "1", target: "0", rate: "1/10" };
	// q=6, s=3/5, updates (1/5,9/5); rescaling gives (27/5,-13/5).
	assert.equal(factorizedTaskAnswer(parameters), "9/25");
	assert.equal(factorizedTaskAnswer({ ...parameters, a: "6", b: "1" }), "-351/25");
	assert.equal(factorizedTaskAnswer({ ...parameters, operation: "product" }), "6");
	assert.equal(factorizedTaskAnswer({ ...parameters, operation: "product", a: "6", b: "1" }), "6");
	assert.equal(factorizedTaskAnswer({ ...parameters, a: "1/2", b: "2/3", x: "3", target: "1" }), "1/3", "a zero-error step preserves the exact product");
});

test("the direct-update checker agrees with the independently expanded generator across seeds", () => {
	for (let seed = 1; seed <= 128; seed++) {
		const groups = generatedFactorizedCases(seed), cases = [...groups.teaching, ...groups.evaluation, ...groups.transfer];
		assert.equal(new Set(cases.map(factorizedCaseIdentity)).size, cases.length);
		for (const item of cases) { verifyFactorizedCase(item); assert.ok(checkFactorizedAnswer(item, ` ${item.expected}\n`)); }
		assert.deepEqual(generatedFactorizedCases(seed), groups, "the seed reproduces the full task inventory");
	}
	assert.notDeepEqual(generatedFactorizedCases(18).evaluation, generatedFactorizedCases(19).evaluation);
});

test("the semantic checker refuses a well-formed but wrong answer artifact and key", () => {
	const item = input().teaching[0]!;
	assert.equal(checkFactorizedAnswer(item, "9/25"), true);
	assert.equal(checkFactorizedAnswer(item, "10/25"), false);
	assert.equal(checkFactorizedAnswer(item, "18/50"), false, "the task requires reduced exact output");
	assert.equal(checkFactorizedAnswer(item, { answer: "9/25" }), false);
	assert.throws(() => verifyFactorizedCase({ ...item, expected: "10/25" }), /independent verification/);
	assert.throws(() => verifyFactorizedCase({ ...item, observations: [{ id: "parameters", status: "SUFFICIENT", content: JSON.stringify({ ...factorizedCaseParameters(item), a: "6", b: "1" }) }] }), /independent verification/);
});

test("task identity ignores renamed observations, exchanged factors, and irrelevant product parameters", () => {
	const item = input().teaching[2]!, p = factorizedCaseParameters(item);
	const changed: SchoolCase = { ...item, id: "different-id", observations: [{ id: "different-evidence", status: "SUFFICIENT", content: JSON.stringify({ ...p, a: p.b, b: p.a, x: "99", target: "-72", rate: "1/999" }) }] };
	assert.equal(factorizedCaseIdentity(changed), factorizedCaseIdentity(item));
	assert.notEqual(factorizedCaseIdentity(input().teaching[0]!), factorizedCaseIdentity(input().teaching[1]!));
});

test("experiment parsing binds the world, keys, inventory and splits to its versioned seed", () => {
	const source = input();
	assert.deepEqual(protocol(source), source.experiment);
	assert.deepEqual(parseSchoolEpisode(source), source);
	for (const mutate of [
		(m: SchoolExperimentManifest) => { m.evaluation[0]!.expected = "1"; },
		(m: SchoolExperimentManifest) => { m.experiment.transfer[0]!.expected = "1"; },
		(m: SchoolExperimentManifest) => { m.experiment.transfer[0] = { ...m.evaluation[0]!, id: "renamed-sealed" }; },
		(m: SchoolExperimentManifest) => { m.experiment.transfer[0]!.split = "retention"; },
		(m: SchoolExperimentManifest) => { m.experiment.seed++; },
		(m: SchoolExperimentManifest) => { m.world.instructions = "Use sequential updates"; },
	]) {
		const changed = structuredClone(source); mutate(changed); assert.throws(() => protocol(changed), /differs|does not match/);
	}
	assert.throws(() => parseSchoolExperiment({ ...source.experiment, expected: "leak" }, source.teaching, source.evaluation), /unsupported field/);
	assert.throws(() => parseSchoolExperiment({ ...source.experiment, memory: false }, source.teaching, source.evaluation), /Unsupported experiment protocol/);
	for (const seed of [0, -1, 0.1, 2 ** 32, NaN]) assert.throws(() => generatedFactorizedCases(seed), /Seed/);
});

test("rational inputs are bounded, normalized and require a positive step rate", () => {
	const source = factorizedCaseParameters(input().teaching[0]!);
	assert.equal(parseFactorizedParameters({ ...source, a: "6/3" }).a, "2");
	for (const a of ["1/0", "2/-3", "1.5", "01", "1e3", "9".repeat(81), null]) assert.throws(() => parseFactorizedParameters({ ...source, a }), /rational/);
	assert.throws(() => parseFactorizedParameters({ ...source, rate: "0" }), /positive/);
	assert.throws(() => parseFactorizedParameters({ ...source, solution: "9/25" }), /unsupported/);
});

test("condition reports retain missing coverage, cold loss, fresh transfer, and harmful regressions", () => {
	const manifest = input(), calls: { phase: string; caseId: string; grade?: ReturnType<typeof gradeSchoolReply> }[] = [];
	const absent = summarizeSchoolExperiment(manifest, calls);
	assert.ok(absent.conditions.every((condition) => condition.coverage === "ABSENT" && condition.target.correct === null));
	assert.equal(absent.generalization, "NOT_ESTABLISHED");
	for (const phase of ["baseline", "retry", "cold", "transfer"]) {
		for (const item of phase === "transfer" ? manifest.experiment.transfer : manifest.evaluation) {
			const correct = item.split === "target" ? phase === "retry" || phase === "transfer" : phase !== "retry";
			calls.push({ phase, caseId: item.id, grade: gradeSchoolReply(item, correct ? item.expected : "0") });
		}
	}
	const report = summarizeSchoolExperiment(manifest, calls), byCondition = Object.fromEntries(report.conditions.map((condition) => [condition.condition, condition]));
	assert.deepEqual(byCondition.baseline?.target, { expected: 3, graded: 3, correct: 0 });
	assert.equal(byCondition.assisted?.target.correct, 3);
	assert.equal(byCondition.cold?.target.correct, 0);
	assert.equal(byCondition.transfer?.assistance, "lesson");
	assert.equal(byCondition.transfer?.target.correct, 3);
	assert.deepEqual(byCondition.assisted?.regressions, [manifest.evaluation.at(-1)!.id]);
	assert.equal(report.persistence, "NOT_ESTABLISHED");
	assert.equal(report.weightLearning, "NOT_PERFORMED");
	delete calls[0]!.grade;
	assert.equal(summarizeSchoolExperiment(manifest, calls).conditions[0]!.coverage, "INSUFFICIENT");
	assert.throws(() => summarizeSchoolExperiment(manifest, [...calls, calls[0]!]), /duplicate/);
});

test("memory is a distinct requested condition and queue budgets count every call", () => {
	const manifest = input();
	assert.equal(schoolExperimentCallCount(4), 9);
	assert.equal(schoolExperimentCallCount(4, manifest.experiment), 17);
	manifest.experiment.memory = true;
	assert.equal(schoolExperimentCallCount(4, protocol(manifest)), 21);
	const memory = summarizeSchoolExperiment(manifest, []).conditions.find((condition) => condition.condition === "memory")!;
	assert.equal(memory.assistance, "saved-memory");
	assert.equal(memory.coverage, "ABSENT");
});

test("exposure receipts bind exact supplied views without carrying answer or memory text", async () => {
	const call = { id: "call-1", participant: input().learner, role: "learner" as const, phase: "retry", caseId: "case-1", view: { problem: { id: "case-1", question: "visible problem" }, lesson: "visible lesson", savedMemory: { text: "PRIVATE_MEMORY_6193" } } };
	const receipt = await schoolExposureForCall(call, 0);
	assert.equal(receipt.condition, "assisted");
	for (const key of ["viewSha256", "problemSha256", "lessonSha256", "memorySha256"] as const) assert.match(receipt[key]!, /^[0-9a-f]{64}$/);
	assert.ok(!JSON.stringify(receipt).includes("PRIVATE_MEMORY"));
	assert.deepEqual(receipt, await schoolExposureForCall({ ...call, view: { savedMemory: call.view.savedMemory, lesson: call.view.lesson, problem: call.view.problem } }, 0));
	assert.notEqual(receipt.viewSha256, (await schoolExposureForCall({ ...call, view: { ...call.view, lesson: "another lesson" } }, 0)).viewSha256);
	const cold = await schoolExposureForCall({ ...call, phase: "cold", view: { problem: call.view.problem } }, 1);
	assert.equal(cold.lessonSha256, undefined); assert.equal(cold.memorySha256, undefined);
	assert.equal((await schoolExposureForCall({ ...call, phase: "lesson", role: "teacher" }, 2)).condition, "teaching");
	await assert.rejects(schoolExposureForCall(call as SchoolCallRecord, -1), /nonnegative/);
});
