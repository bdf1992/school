import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { Classroom } from "../components/school/classroom.tsx";
import { ClassroomEvidence } from "../components/school/evidence.tsx";
import { ClassroomGradebook, ExperimentConditions, GradeCount } from "../components/school/gradebook.tsx";
import { ClassroomWorkQueue } from "../components/school/work-queue.tsx";
import { classChoice, prepareClassroomEpisode, type ClassroomRun } from "../components/school/classroom-data.ts";
import type { SchoolClassDefinition } from "../src/core/school-class.ts";
import type { SchoolGradebook, SchoolGradebookEpisode } from "../src/core/school-gradebook.ts";
import type { SchoolEpisodeManifest } from "../src/core/school-episode.ts";
import type { SchoolExperimentReport } from "../src/core/school-experiment.ts";

const dom = parseHTML("<html><head></head><body></body></html>");
const previous = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, Element: globalThis.Element, HTMLElement: globalThis.HTMLElement, HTMLInputElement: globalThis.HTMLInputElement, HTMLTextAreaElement: globalThis.HTMLTextAreaElement };
Object.assign(dom.document, { oninput: null });
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
after(() => Object.assign(globalThis, previous));
const classDefinition = JSON.parse(readFileSync(new URL("../examples/school/byte-parity-class.json", import.meta.url), "utf8")) as SchoolClassDefinition;
const manifest = JSON.parse(readFileSync(new URL("../examples/school/byte-parity.json", import.meta.url), "utf8")) as SchoolEpisodeManifest;
const noGradebook = (definition = classDefinition): SchoolGradebook => ({
	class: { id: definition.id, revision: definition.revision, title: definition.title },
	curriculum: { ...definition.curriculum, units: definition.curriculum.units.map(({ id, title }) => ({ id, title })) },
	assessment: definition.assessment,
	learners: definition.roster.filter((member) => member.roles.includes("learner")).map((member) => ({ participantId: member.participantId, status: "NO_EPISODES", episodes: [] })),
});
const run: ClassroomRun = {
	operationId: "owner-run", status: "QUEUED", class: { classId: classDefinition.id, revision: classDefinition.revision, unitId: classDefinition.curriculum.units[0]!.id },
	learnerId: manifest.learner.id, teacherId: manifest.teacher.id, notBefore: "2026-11-09T00:00:00.000Z", createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z", evidence: "CONFIGURED_PROVIDER", plannedCalls: 7,
};
function mounted() { const container = document.createElement("div"); document.body.appendChild(container); return { container, root: createRoot(container) }; }
function button(container: Element, text: string): HTMLButtonElement { const found = [...container.querySelectorAll("button")].find((element) => element.textContent === text); assert.ok(found, `Button ${text} exists`); return found as HTMLButtonElement; }

test("gradebook distinguishes no evidence from a wrong answer and keeps episode scope and provenance", () => {
	const missing = renderToStaticMarkup(<GradeCount count={{ expected: 4, graded: 0, correct: null }} />);
	const wrong = renderToStaticMarkup(<GradeCount count={{ expected: 4, graded: 1, correct: 0 }} />);
	assert.match(missing, /No grade/); assert.match(missing, /0 graded \/ 4 expected/); assert.doesNotMatch(missing, /0 correct/);
	assert.match(wrong, /0 correct/); assert.match(wrong, /1 graded \/ 4 expected/);
	const gradebook = noGradebook();
	const episode: SchoolGradebookEpisode = {
		operationId: "retained-fixture", class: { ...run.class, sessionId: "selected-session" }, learner: { ...manifest.learner, edition: null }, teacherId: manifest.teacher.id,
		evidence: "SCRIPTED_FIXTURE", status: "FAILED", createdAt: run.createdAt, updatedAt: run.updatedAt, comparison: null,
		baseline: { cases: [], counts: { target: { expected: 2, graded: 1, correct: 0 }, retention: { expected: 1, graded: 0, correct: null } } },
		retry: { cases: [], counts: { target: { expected: 2, graded: 0, correct: null }, retention: { expected: 1, graded: 0, correct: null } } },
	};
	gradebook.learners[0]!.episodes = [episode, { ...episode, operationId: "other-session-private-result", class: { ...run.class, sessionId: "other-session" } }];
	const html = renderToStaticMarkup(<ClassroomGradebook gradebook={gradebook} unitId={run.class.unitId} sessionId="selected-session" onInspect={() => {}} />);
	assert.match(html, /retained-fixture/); assert.match(html, /Scripted fixture/); assert.match(html, /No complete comparison/);
	assert.doesNotMatch(html, /other-session-private-result/); assert.doesNotMatch(html, /Configured provider|average|%/);
});

test("episode import refuses scope changes instead of silently rebinding class or world", () => {
	const raw = JSON.stringify(manifest), unitId = classDefinition.curriculum.units[0]!.id;
	assert.deepEqual(prepareClassroomEpisode({ raw, definition: classDefinition, unitId, sessionId: "" }), manifest);
	assert.throws(() => prepareClassroomEpisode({ raw, definition: { ...classDefinition, revision: "other" }, unitId, sessionId: "" }), /different class revision/);
	assert.throws(() => prepareClassroomEpisode({ raw, definition: classDefinition, unitId: "other", sessionId: "" }), /curriculum unit/);
	const changed = structuredClone(classDefinition); changed.curriculum.units[0]!.world.revision = "different-world";
	assert.throws(() => prepareClassroomEpisode({ raw, definition: changed, unitId, sessionId: "" }), /episode world/);
	assert.equal(JSON.stringify(manifest), raw, "import preparation does not mutate source evidence");
});

test("an explicit state selection binds the saved model revision without changing the task or source manifest", () => {
	const raw = JSON.stringify(manifest);
	const prepared = prepareClassroomEpisode({
		raw, definition: classDefinition, unitId: classDefinition.curriculum.units[0]!.id, sessionId: "",
		learnerState: { participantId: manifest.learner.id, revision: "saved-r2", model: { provider: "custom", id: "selected-local-model" }, connection: { id: "local", revision: "1" }, memorySha256: "memory-receipt", sha256: "state-receipt" },
	});
	assert.deepEqual(prepared.learner, { id: manifest.learner.id, model: { provider: "custom", id: "selected-local-model" }, stateRef: { revision: "saved-r2" } });
	assert.deepEqual(prepared.teacher, manifest.teacher); assert.deepEqual(prepared.evaluation, manifest.evaluation); assert.deepEqual(prepared.class, manifest.class);
	assert.equal(JSON.stringify(manifest), raw);
});

test("experiment results label cold and lesson-assisted transfer separately and retain missing coverage", () => {
	const report: SchoolExperimentReport = {
		version: 1, family: "factorized-scalar-step-v1", seed: 42, disclosure: "after-completion", transferCondition: "LESSON_ASSISTED_FRESH_PARAMETERS", weightLearning: "NOT_PERFORMED", persistence: "NOT_ESTABLISHED", generalization: "NOT_ESTABLISHED", evidenceScope: "THIS_GENERATOR_AND_SEED",
		conditions: [
			{ condition: "cold", assistance: "none", coverage: "ABSENT", target: { expected: 3, graded: 0, correct: null }, retention: { expected: 1, graded: 0, correct: null }, regressions: [] },
			{ condition: "transfer", assistance: "lesson", coverage: "INSUFFICIENT", target: { expected: 3, graded: 2, correct: 1 }, retention: { expected: 1, graded: 0, correct: null }, regressions: [] },
		],
	};
	const html = renderToStaticMarkup(<ExperimentConditions report={report} />);
	assert.match(html, /Cold · no lesson/); assert.match(html, /Transfer · lesson assisted/);
	assert.match(html, /No grade/); assert.match(html, /0 graded \/ 3 expected/); assert.match(html, /2 graded \/ 3 expected/);
	assert.match(html, /Persistence and generalization are not established/); assert.doesNotMatch(html, /0 correct|%/);
});

test("opening and refreshing the classroom only reads; due work requires the explicit action", async () => {
	const requests: { path: string; method: string; body?: unknown }[] = [];
	globalThis.fetch = async (input, init) => {
		const path = String(input); requests.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
		if (init?.method === "POST") return Response.json({ processed: 1, runs: [{ ...run, status: "COMPLETED" }] });
		if (path === "/api/school/classes") return Response.json({ classes: [{ id: classDefinition.id, revision: classDefinition.revision, title: classDefinition.title, sha256: "receipt" }] });
		if (path.includes("gradebook=true")) return Response.json({ gradebook: noGradebook() });
		if (path.startsWith("/api/school/classes?")) return Response.json({ definition: classDefinition, sha256: "receipt" });
		if (path === "/api/school/participants") return Response.json({ participants: [], states: [], connections: [] });
		if (path === "/api/school/runs") return Response.json({ runs: [run] });
		throw new Error(`Unexpected request: ${path}`);
	};
	const { root, container } = mounted();
	try {
		await act(async () => root.render(<Classroom />));
		assert.equal(requests.filter((request) => request.method !== "GET").length, 0);
		assert.match(container.textContent!, /No episodes in this selection. No grade./);
		await act(async () => button(container, "Refresh").click());
		assert.equal(requests.filter((request) => request.method !== "GET").length, 0, "refresh cannot call providers or drain work");
		await act(async () => button(container, "Run due work").click());
		assert.deepEqual(requests.filter((request) => request.method === "POST").map((request) => [request.path, request.body]), [["/api/school/runs", { action: "drain" }]]);
	} finally { await act(async () => root.unmount()); container.remove(); }
});

test("cancellation remains available while a due-work request is waiting for providers", async () => {
	let finishDrain: (response: Response) => void = () => { throw new Error("drain did not start"); };
	const writes: unknown[] = [];
	globalThis.fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as { action: string }; writes.push(body);
		return body.action === "drain" ? new Promise<Response>((resolve) => { finishDrain = resolve; }) : Response.json({ run: { ...run, status: "CANCELLED" } });
	};
	const { root, container } = mounted();
	try {
		await act(async () => root.render(<ClassroomWorkQueue runs={[run]} onRefresh={() => {}} onInspect={() => {}} />));
		assert.equal(writes.length, 0);
		await act(async () => button(container, "Run due work").click());
		assert.equal(button(container, "Cancel").disabled, false);
		await act(async () => button(container, "Cancel").click());
		assert.deepEqual(writes, [{ action: "drain" }, { action: "cancel", operationId: run.operationId }]);
		await act(async () => finishDrain(Response.json({ processed: 1, runs: [{ ...run, status: "CANCELLED" }] })));
	} finally { await act(async () => root.unmount()); container.remove(); }
});

test("reviewed uncertainty needs an explicit note and never retries or relabels the original run", async () => {
	const writes: unknown[] = [];
	const unresolved: ClassroomRun = { ...run, status: "UNRESOLVED", errorCode: "PROVIDER_COMPLETION_UNRESOLVED" };
	const reviewed: ClassroomRun = { ...unresolved, uncertaintyAcknowledgedAt: "2026-11-09T12:00:00.000Z" };
	globalThis.fetch = async (_input, init) => { writes.push(JSON.parse(String(init?.body))); return Response.json({ run: reviewed }); };
	const { root, container } = mounted();
	try {
		await act(async () => root.render(<ClassroomWorkQueue runs={[unresolved]} onRefresh={() => {}} onInspect={() => {}} />));
		assert.equal(writes.length, 0); assert.equal(button(container, "Allow later work after review").disabled, true);
		await act(async () => container.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
		assert.equal(writes.length, 0, "an empty review cannot acknowledge uncertainty");
		const note = container.querySelector("textarea")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Reviewed retained call; provider completion cannot be established.");
			note.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		});
		assert.equal(button(container, "Allow later work after review").disabled, false);
		await act(async () => container.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
		assert.deepEqual(writes, [{ action: "acknowledge-uncertainty", operationId: run.operationId, note: "Reviewed retained call; provider completion cannot be established." }]);
		await act(async () => root.render(<ClassroomWorkQueue runs={[reviewed]} onRefresh={() => {}} onInspect={() => {}} />));
		assert.match(container.textContent!, /Reviewed; later work permitted. Completion remains unknown./);
		assert.match(container.textContent!, /unresolved/); assert.equal(container.querySelector("textarea"), null);
		assert.doesNotMatch(container.textContent!, /No complete comparison|Completed|Retry/);
	} finally { await act(async () => root.unmount()); container.remove(); }
});

test("late evidence reads cannot replace a newly selected episode", async () => {
	let finishOld: (response: Response) => void = () => { throw new Error("first read did not start"); };
	const evidence = (operationId: string, error: string) => ({ operationId, evidence: "SCRIPTED_FIXTURE", status: "FAILED", error, calls: [] });
	globalThis.fetch = async (input) => String(input).includes("old-run") ? new Promise<Response>((resolve) => { finishOld = resolve; }) : Response.json({ record: evidence("new-run", "Current episode evidence") });
	const { root, container } = mounted();
	try {
		await act(async () => root.render(<ClassroomEvidence operationId="old-run" onClose={() => {}} />));
		await act(async () => root.render(<ClassroomEvidence operationId="new-run" onClose={() => {}} />));
		assert.match(container.textContent!, /Current episode evidence/);
		await act(async () => finishOld(Response.json({ record: evidence("old-run", "Stale evidence must stay hidden") })));
		assert.match(container.textContent!, /Current episode evidence/); assert.doesNotMatch(container.textContent!, /Stale evidence/);
	} finally { await act(async () => root.unmount()); container.remove(); }
});

test("a late class response cannot populate the newly selected class revision", async () => {
	const other = { ...structuredClone(classDefinition), id: "other-class", title: "Other class" };
	const pending: ((response: Response) => void)[] = [];
	globalThis.fetch = async (input) => {
		const path = String(input);
		if (path === "/api/school/classes") return Response.json({ classes: [classDefinition, other].map(({ id, revision, title }) => ({ id, revision, title, sha256: "receipt" })) });
		if (path === "/api/school/participants") return Response.json({ participants: [], states: [], connections: [] });
		if (path === "/api/school/runs") return Response.json({ runs: [] });
		if (new URL(path, "http://localhost").searchParams.get("classId") === classDefinition.id) return new Promise<Response>((resolve) => pending.push(resolve));
		return Response.json(path.includes("gradebook=true") ? { gradebook: noGradebook(other) } : { definition: other });
	};
	const { root, container } = mounted();
	try {
		await act(async () => root.render(<Classroom />));
		assert.equal(pending.length, 2);
		const select = container.querySelector("select")!;
		Object.defineProperty(select, "value", { configurable: true, value: classChoice(other.id, other.revision) });
		await act(async () => select.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
		assert.match(container.textContent!, /No episodes in this selection. No grade./);
		const stale = structuredClone(classDefinition); stale.curriculum.units[0]!.title = "Stale curriculum must stay hidden";
		await act(async () => { pending[0]!(Response.json({ definition: stale })); pending[1]!(Response.json({ gradebook: noGradebook(stale) })); });
		assert.doesNotMatch(container.textContent!, /Stale curriculum/);
		assert.match(container.textContent!, /Other class/);
	} finally { await act(async () => root.unmount()); container.remove(); }
});
