import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	LearnerViewError, projectLearnerView, type LearnerQuestion, type LearnerViewErrorCode,
} from "../src/core/learner-view.ts";

const PRIVATE = "LEARNER_VIEW_PRIVATE_SENTINEL";
const ACK = "Question posed — the turn ends here; the learner's graded answer arrives as this call's result.";
const toolCall = (name: string, id: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (id: string, content: unknown[], stopReason = "toolUse") => ({ id, role: "assistant", content, stopReason });
const result = (id: string, toolCallId: string, toolName: string, isError = false, details: unknown = null) => ({
	id, role: "toolResult", toolCallId, toolName, isError, details,
	content: [{ type: "text", text: PRIVATE }],
});
const chat = (messages: unknown[], kind: "teach" | "practice" = "teach") => ({
	id: "session-1", version: 1, kind, title: PRIVATE, messages, settings: { secret: PRIVATE },
});
const quiz = () => ({
	question: "Which number is even?",
	options: [
		{ label: " One ", value: " one ", description: PRIVATE, correct: false, extra: { solution: PRIVATE } },
		{ label: " Two ", value: " two ", description: PRIVATE, correct: true, index: 99 },
	],
	correctAnswer: "two", explanation: PRIVATE, details: PRIVATE,
	nodeId: PRIVATE, type: "check", extra: { modelSolution: PRIVATE },
});
const recall = () => ({ question: "Explain why the sky appears blue.", correctAnswer: PRIVATE, details: PRIVATE });
const problem = (statement = "Prove the sum of two even integers is even.") => ({
	statement, mode: "composition", target: [PRIVATE], modelSolution: PRIVATE, extra: PRIVATE,
});
const pose = (id = "p1") => assistant(`a-${id}`, [toolCall("problem", id, problem())]);
const conclude = (id = "end-1") => assistant(`a-${id}`, [toolCall("conclude", id, {
	outcome: "solved", verdict: PRIVATE, rung: null, missClass: null, retest: false,
})]);
const dismissal = (problemCallId = "p1") => ({
	id: "dismiss-1", role: "custom", customType: "problem-dismissed", content: "",
	details: { problemCallId, secret: PRIVATE },
});

function rejects(record: unknown, code: LearnerViewErrorCode) {
	assert.throws(() => projectLearnerView(record), (error: unknown) => {
		assert.ok(error instanceof LearnerViewError);
		assert.equal(error.code, code);
		assert.equal(error.message.includes(PRIVATE), false);
		return true;
	});
}
function freeze(value: unknown): void {
	if (typeof value !== "object" || value === null) return;
	for (const child of Object.values(value)) freeze(child);
	Object.freeze(value);
}

test("production projection copies only pending task fields, excluding nested/private extensions", () => {
	const source = chat([
		{ id: "u1", role: "user", content: PRIVATE },
		assistant("a1", [
			{ type: "thinking", thinking: PRIVATE, signature: PRIVATE },
			{ type: "text", text: PRIVATE },
			toolCall("quiz", "q1", quiz()), toolCall("recall", "q2", recall()),
		]),
	]);
	const before = structuredClone(source);
	freeze(source);
	const view = projectLearnerView(source);
	assert.deepEqual(view, {
		format: "school.learner-view/v1", sessionId: "session-1", status: "pending",
		tasks: [
			{ toolCallId: "q1", tool: "quiz", kind: "quiz", question: "Which number is even?",
				mode: "single-select", options: [{ label: "One", value: "one" }, { label: "Two", value: "two" }] },
			{ toolCallId: "q2", tool: "recall", kind: "explain", question: "Explain why the sky appears blue.", mode: "text", options: [] },
		],
	});
	assert.equal(JSON.stringify(view).includes(PRIVATE), false);
	assert.equal(JSON.stringify(view).includes("correctAnswer"), false);
	(view.tasks[0] as LearnerQuestion).options[0]!.label = "changed copy";
	assert.deepEqual(source, before);
});

test("all five native question tools project, with stable values and no display indices", () => {
	for (const name of ["quiz", "probe", "recall", "explain", "ask_user_question"]) {
		const input = name === "quiz" || name === "probe" ? quiz()
			: name === "ask_user_question" ? { question: "Pick a topic", options: [{ label: " Logic " }, { label: " Art ", value: "" }] }
			: recall();
		const view = projectLearnerView(chat([assistant("a1", [toolCall(name, "q1", input)])]));
		assert.equal(view.tasks[0]!.tool, name);
		assert.equal(JSON.stringify(view).includes('"index"'), false);
		if (name === "ask_user_question") assert.deepEqual((view.tasks[0] as LearnerQuestion).options,
			[{ label: "Logic", value: "Logic" }, { label: "Art", value: "Art" }]);
	}
	const ask = projectLearnerView(chat([assistant("a1", [toolCall("ask_user_question", "q1", { question: "What interests you?" })])]));
	assert.equal((ask.tasks[0] as LearnerQuestion).mode, "text");
});

test("changing a valid answer commitment does not change the observation", () => {
	const input = quiz();
	const first = projectLearnerView(chat([assistant("a1", [toolCall("quiz", "q1", input)])]));
	input.correctAnswer = "one";
	const second = projectLearnerView(chat([assistant("a1", [toolCall("quiz", "q1", input)])]));
	assert.deepEqual(first, second);
	const multi = { ...quiz(), multiSelect: true, correctAnswer: ["one", "two"] };
	assert.equal((projectLearnerView(chat([assistant("a1", [toolCall("quiz", "q1", multi)])])).tasks[0] as LearnerQuestion).mode, "multi-select");
});

test("answered, dismissed, errored, and refused questions never reopen; unanswered siblings remain", () => {
	for (const terminal of [
		result("r1", "q1", "quiz", false, { correct: true, explanation: PRIVATE }),
		result("r1", "q1", "quiz", false, { dismissed: true }),
		result("r1", "q1", "quiz", true),
		result("r1", "q1", "quiz", false, { ok: false, error: PRIVATE }),
	]) {
		const view = projectLearnerView(chat([
			assistant("a1", [toolCall("quiz", "q1", quiz()), toolCall("recall", "q2", recall())]), terminal,
		]));
		assert.deepEqual(view.tasks.map((task) => task.toolCallId), ["q2"]);
		assert.equal(JSON.stringify(view).includes(PRIVATE), false);
	}
});

test("only the newest assistant supplies questions; old unresolved questions are not revived", () => {
	const view = projectLearnerView(chat([
		assistant("a1", [toolCall("quiz", "q1", quiz())]),
		assistant("a2", [{ type: "text", text: PRIVATE }], "stop"),
	]));
	assert.equal(view.status, "idle");
	assert.deepEqual(view.tasks, []);
});

test("exact transient question acknowledgements are ignored; saved results stay terminal", () => {
	const ack = { ...result("c_ack", "q1", "quiz"), content: [{ type: "text", text: ACK }] };
	const messages = [assistant("a1", [toolCall("quiz", "q1", quiz())]), ack];
	assert.equal(projectLearnerView(chat(messages)).tasks.length, 1);
	assert.equal(projectLearnerView(chat([messages[0], { ...ack, id: "saved-ack" }])).tasks.length, 0);
	rejects(chat([messages[0], { ...ack, content: [{ type: "text", text: PRIVATE }] }]), "UNSETTLED_TURN");
});

test("unfinished or failed latest generations cannot create a learner task", () => {
	for (const reason of ["pending", "length", "error", "aborted"]) {
		rejects(chat([assistant("a1", [toolCall("quiz", "q1", quiz())], reason)]), "UNSETTLED_TURN");
		rejects(chat([pose(), result("r1", "p1", "problem"), assistant("a2", [], reason)], "practice"), "UNSETTLED_TURN");
	}
	rejects(chat([assistant("c_live", [toolCall("quiz", "q1", quiz())])]), "UNSETTLED_TURN");
});

test("task validation is strict and errors never echo the malformed/private input", () => {
	for (const input of [
		{ ...quiz(), question: { secret: PRIVATE } },
		{ ...quiz(), correctAnswer: PRIVATE },
		{ ...quiz(), correctAnswer: undefined },
		{ ...quiz(), correctAnswer: ["one", "two"] },
		{ ...quiz(), explanation: undefined },
		{ ...quiz(), multiSelect: "true" },
		{ ...quiz(), options: JSON.stringify(quiz().options) },
		{ ...quiz(), options: [{ label: "one", value: "same" }, { label: "two", value: " same " }] },
		{ ...quiz(), options: [{ label: "one", value: { answer: PRIVATE } }, { label: "two" }] },
		{ ...quiz(), options: [{ label: "one" }, { label: " " }] },
	]) rejects(chat([assistant("a1", [toolCall("quiz", "q1", input)])]), "MALFORMED_TASK");
	rejects(chat([assistant("a1", [{ ...toolCall("recall", "q1", recall()), argumentsError: PRIVATE }])]), "MALFORMED_TASK");
	rejects(chat([assistant("a1", [toolCall("recall", "q1", { question: "Why?" })])]), "MALFORMED_TASK");
});

test("unknown versions, roles, custom markers and native content shapes fail closed", () => {
	for (const version of [0, 2, "1"]) rejects({ ...chat([]), version }, "UNSUPPORTED_RECORD");
	rejects({ ...chat([]), kind: "future" }, "UNSUPPORTED_RECORD");
	rejects(chat([{ id: "a1", role: "system", content: PRIVATE }]), "UNSUPPORTED_RECORD");
	rejects(chat([{ id: "a1", role: "assistant", parts: [] }]), "MALFORMED_RECORD");
	rejects(chat([assistant("a1", [{ type: "future-block", value: PRIVATE }])]), "UNSUPPORTED_RECORD");
	rejects(chat([{ id: "m1", role: "custom", customType: "future-gate", content: PRIVATE }]), "UNSUPPORTED_RECORD");
	assert.equal(projectLearnerView({ ...chat([]), version: undefined }).status, "idle");
});

test("ambiguous message/call/result identity cannot route a learner to the wrong question", () => {
	const a = assistant("a1", [toolCall("quiz", "q1", quiz())]);
	for (const messages of [
		[a, a],
		[a, assistant("a2", [toolCall("quiz", "q1", quiz())])],
		[a, result("r1", "missing", "quiz")],
		[a, result("r1", "q1", "recall")],
		[result("r1", "q1", "quiz"), a],
		[a, result("r1", "q1", "quiz"), result("r2", "q1", "quiz")],
	]) rejects(chat(messages), "AMBIGUOUS_IDENTITY");
});

test("unknown unresolved tools block a sibling question; completed unrelated tool payloads are excluded", () => {
	const a = assistant("a1", [toolCall("future_task", "x1", { secret: PRIVATE }), toolCall("quiz", "q1", quiz())]);
	rejects(chat([a]), "UNRESOLVED_TOOL");
	const view = projectLearnerView(chat([a, result("r1", "x1", "future_task", false, { secret: PRIVATE })]));
	assert.deepEqual(view.tasks.map((task) => task.toolCallId), ["q1"]);
	assert.equal(JSON.stringify(view).includes(PRIVATE), false);
});

test("practice requires a successful ack and exposes only the active statement and mode", () => {
	const source = chat([pose(), result("r1", "p1", "problem"), assistant("a2", [{ type: "text", text: PRIVATE }], "stop")], "practice");
	const before = structuredClone(source);
	freeze(source);
	const view = projectLearnerView(source);
	assert.deepEqual(view.tasks, [{ toolCallId: "p1", tool: "problem", kind: "problem",
		statement: "Prove the sum of two even integers is even.", mode: "composition" }]);
	assert.equal(JSON.stringify(view).includes(PRIVATE), false);
	assert.deepEqual(source, before);
	for (const ack of [result("r1", "p1", "problem", true), result("r1", "p1", "problem", false, { ok: false })]) {
		assert.equal(projectLearnerView(chat([pose(), ack], "practice")).status, "idle");
	}
	rejects(chat([pose()], "practice"), "UNRESOLVED_TOOL");
});

test("clean conclude closes the problem; rejected conclude preserves it; missing conclude result refuses", () => {
	const initial = [pose(), result("r1", "p1", "problem"), conclude()];
	assert.equal(projectLearnerView(chat([...initial, result("r2", "end-1", "conclude")], "practice")).status, "idle");
	for (const ack of [result("r2", "end-1", "conclude", true), result("r2", "end-1", "conclude", false, { ok: false })]) {
		assert.equal(projectLearnerView(chat([...initial, ack], "practice")).tasks[0]!.toolCallId, "p1");
	}
	rejects(chat(initial, "practice"), "UNRESOLVED_TOOL");
	const next = [...initial, result("r2", "end-1", "conclude"), pose("p2"), result("r3", "p2", "problem")];
	assert.equal(projectLearnerView(chat(next, "practice")).tasks[0]!.toolCallId, "p2");
});

test("dismissal and its deferred native conclude pair close exactly their matching problem", () => {
	const initial = [pose(), result("r1", "p1", "problem"), dismissal()];
	assert.equal(projectLearnerView(chat(initial, "practice")).status, "idle");
	const deferred = [
		assistant("a2", [toolCall("conclude", "call_conc_p1", { outcome: "dismissed" })]),
		result("r2", "call_conc_p1", "conclude", false, { outcome: "dismissed", problemCallId: "p1" }),
	];
	assert.equal(projectLearnerView(chat([...initial, ...deferred], "practice")).status, "idle");
	rejects(chat([pose(), result("r1", "p1", "problem"), dismissal("wrong-problem")], "practice"), "AMBIGUOUS_PRACTICE");
});

test("contradictory practice histories and malformed posed problems fail closed", () => {
	rejects(chat([pose(), result("r1", "p1", "problem"), pose("p2"), result("r2", "p2", "problem")], "practice"), "AMBIGUOUS_PRACTICE");
	rejects(chat([conclude(), result("r1", "end-1", "conclude")], "practice"), "AMBIGUOUS_PRACTICE");
	rejects(chat([pose(), result("r1", "p1", "problem"), conclude(), result("r2", "end-1", "conclude", false, { problemCallId: "wrong" })], "practice"), "AMBIGUOUS_PRACTICE");
	rejects(chat([pose(), result("r1", "p1", "problem")]), "AMBIGUOUS_PRACTICE");
	rejects(chat([assistant("a1", [toolCall("quiz", "q1", quiz())])], "practice"), "AMBIGUOUS_PRACTICE");
	for (const input of [{ ...problem(), modelSolution: undefined }, { ...problem(), mode: "future" }, { ...problem(), statement: { private: PRIVATE } }]) {
		rejects(chat([assistant("a1", [toolCall("problem", "p1", input)]), result("r1", "p1", "problem")], "practice"), "MALFORMED_TASK");
	}
});

test("refused replacement practice tools do not supersede the real active problem", () => {
	const view = projectLearnerView(chat([
		pose(), result("r1", "p1", "problem"), pose("p2"), result("r2", "p2", "problem", true),
	], "practice"));
	assert.equal(view.tasks[0]!.toolCallId, "p1");
});

test("CLI reads one explicit file and prints the actual safe projection with no record leakage", () => {
	const directory = mkdtempSync(join(tmpdir(), "school-view-"));
	const cli = fileURLToPath(new URL("../scripts/school-learner-view.ts", import.meta.url));
	try {
		const path = join(directory, "record.json");
		const source = chat([assistant("a1", [toolCall("recall", "q1", recall())])]);
		writeFileSync(path, JSON.stringify(source));
		const run = spawnSync(process.execPath, [cli, path], { encoding: "utf8", cwd: directory });
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stderr, "");
		assert.deepEqual(JSON.parse(run.stdout), projectLearnerView(source));
		assert.equal(run.stdout.includes(PRIVATE), false);
		writeFileSync(path, `${PRIVATE}{broken-json`);
		const invalid = spawnSync(process.execPath, [cli, path], { encoding: "utf8", cwd: directory });
		assert.equal(invalid.status, 1);
		assert.equal(invalid.stdout, "");
		assert.equal(invalid.stderr, "Cannot produce learner view: UNREADABLE_RECORD\n");
		const noPath = spawnSync(process.execPath, [cli], { encoding: "utf8", cwd: directory });
		assert.equal(noPath.status, 2);
		assert.equal(noPath.stdout, "");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
