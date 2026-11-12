import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { runSchoolParticipant } from "../src/agent/school-participant.ts";

const runtime = process.env.SCHOOL_FOUNDATION_V020;
const cli = "scripts/school-state-space.ts";
const adapter = "scripts/school_state_space.py";
const snapshot = "examples/school/state-space/SPACE.prompt.json";
const x = { input: "x" }, y = { input: "y" };
const op = (name: string, ...args: object[]) => ({ op: name, args });
const sum = op("add", x, y);

test("verified Ollama requests use the explicit output ceiling and chosen thinking level", async () => {
	const faux = createFauxCore({ api: "school-learning-wire-test", provider: "school-fixture",
		models: [{ id: "wire-test" }], tokensPerSecond: 100_000 });
	faux.setResponses([fauxAssistantMessage("{}")]);
	const model = faux.getModel();
	let payload: unknown;
	await runSchoolParticipant({
		model, level: "low", streamFn: (selected, context, options) => {
			payload = options?.onPayload?.({ model: "wire-test", max_completion_tokens: 1000 }, selected);
			return faux.streamSimple(selected, context);
		},
	}, { systemPrompt: "fixture", view: {}, callId: "fixture", maxOutputTokens: 64,
		timeoutMs: 1000, signal: AbortSignal.timeout(1000), ollamaJson: true });
	assert.deepEqual(payload, { model: "wire-test", max_tokens: 64,
		reasoning_effort: "low", response_format: { type: "json_object" } });
});

test("reopened learning episodes assess two operations and replay without new work", {
	skip: runtime ? false : "Set SCHOOL_FOUNDATION_V020 to the Foundation v0.2 directory",
}, (t) => {
	const root = mkdtempSync(path.join(os.tmpdir(), "school-space-learning-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const db = path.join(root, "state-space.sqlite3");
	const call = (action: string, ...args: string[]) => spawnSync(process.execPath,
		["--import", "tsx", cli, action, root, runtime!, ...args], { encoding: "utf8", timeout: 12_000 });
	function ok(action: string, ...args: string[]) {
		const result = call(action, ...args);
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout);
	}
	const file = (name: string, body: object) => {
		const filename = path.join(root, name + ".json");
		writeFileSync(filename, JSON.stringify(body));
		return filename;
	};
	const countEvents = () => Number(spawnSync("python", ["-c",
		"import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('select count(*) from journal').fetchone()[0])", db],
	{ encoding: "utf8" }).stdout.trim());
	ok("init");
	const rejected = ok("learn-prepare", "regression", "local-learner", "square-of-sum");
	const bad = ok("learn-submit", "regression", file("zero", { literal: [0, 0, 0, 0] }));
	assert.equal(bad.assessment.approved, false);
	assert.ok(bad.assessment.cases.some((item: { baseline_pass: boolean; candidate_pass: boolean }) => item.baseline_pass && !item.candidate_pass));
	assert.match(call("learn-adopt", "regression", bad.assessment.assessment_ref).stderr, /pinned acceptance/);
	assert.equal(ok("learn-use", "regression").binding, rejected.binding);

	for (const [task, repair, hamilton, commuting] of [
		["square-of-sum", op("multiply", sum, sum), ["-2/9", "0", "8/3", "8/3"], ["16/9", "-2", "8/3", "8/3"]],
		["ordered-difference", op("subtract", op("multiply", x, y), op("multiply", y, x)), ["0", "4", "2", "-2"], ["0", "0", "0", "0"]],
	] as const) {
		const prepared = ok("learn-prepare", task, "local-learner", task);
		assert.deepEqual(ok("learn-prepare", task, "local-learner", task), prepared);
		assert.equal(prepared.identity.class.unit.id, task);
		const view = ok("learn-view", task);
		assert.deepEqual(view, prepared.view);
		assert.ok(!JSON.stringify(view).includes(prepared.suite));
		assert.ok(!JSON.stringify(view).includes(JSON.stringify(repair)));
		const entry = ok("learn-resolve", task, view.snapshot, view.entry).record;
		assert.ok(ok("learn-resolve", task, view.snapshot, entry.operation).record.body);
		const publicRecord = ok("learn-resolve", task, view.snapshot, entry.probe).record;
		const publicProbe = publicRecord.input;
		assert.notDeepEqual(publicRecord.target, publicRecord.observed);
		const suite = ok("history", prepared.suite).payload;
		const publicInvocation = ok("history", prepared.probe.invocation_ref).payload;
		assert.ok(suite.cases.every((item: { arguments: unknown }) => JSON.stringify(item.arguments) !== JSON.stringify(publicInvocation.arguments)));
		assert.deepEqual(ok("history", publicInvocation.arguments[0].state_ref).payload.coordinates, publicProbe.x);
		assert.match(call("learn-resolve", task, view.snapshot, "/private/assessment").stderr, /outside/);
		const protocol = ok("learn-resolve", task, view.snapshot, entry.protocol).record;
		assert.equal(ok("learn-resolve", task, protocol.source.snapshot, protocol.source.address).record.body.role, "instruction");

		if (task === "ordered-difference") {
			// Simulate a process disappearing after durable claim and before a terminal record.
			const claim = spawnSync("python", ["-B", adapter, runtime!, db, snapshot], {
				input: JSON.stringify({ action: "learn-claim", episode: task, attempt: "interrupted", modelRequest: { stateRevision: "base" } }),
				encoding: "utf8",
			});
			assert.equal(claim.status, 0, claim.stderr);
			assert.match(call("learn-local", task, "interrupted", "base").stderr, /completion is unknown/);
			assert.equal(ok("learn-status", task).attempts[0].terminal, null);
			assert.match(call("learn-local", task, "missing-state", "base").stderr, /Register the requested learner state/);
			assert.equal(ok("learn-status", task).attempts[1].terminal.occurrence, "NOT_DISPATCHED");
		}
		const forged = file(task + "-forged", { ...repair, suite_ref: prepared.suite });
		assert.match(call("learn-submit", task, forged).stderr, /Unknown expression form/);
		assert.equal(ok("learn-status", task).rejections.length, 1);
		const candidate = file(task, repair);
		if (task === "ordered-difference") {
			// Reopen after the durable submission claim, before Foundation assessment.
			const claim = spawnSync("python", ["-c",
				"import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('update school_learning_episode set submission=? where id=?',(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(',',':')),sys.argv[2])); db.commit()",
				db, task], { input: JSON.stringify({ body: repair, attempt: null }), encoding: "utf8" });
			assert.equal(claim.status, 0, claim.stderr);
			assert.equal(ok("learn-status", task).assessment, null);
		}
		const result = ok("learn-submit", task, candidate);
		assert.equal(result.assessment.suite_ref, prepared.suite);
		assert.equal(result.assessment.approved, true);
		assert.equal(result.assessment.candidate_passed, 10);
		const count = countEvents();
		assert.ok(count > 0);
		assert.deepEqual(ok("learn-submit", task, candidate), result);
		assert.equal(countEvents(), count);
		assert.match(call("learn-submit", task, file(task + "-conflict", { literal: [0, 0, 0, 0] })).stderr, /Conflicting episode submission/);
		assert.equal(ok("learn-use", task).binding, prepared.binding);
		const adopted = ok("learn-adopt", task, result.assessment.assessment_ref);
		assert.deepEqual(ok("learn-adopt", task, result.assessment.assessment_ref), adopted);
		const reopened = ok("learn-use", task);
		assert.equal(reopened.slot, prepared.slot);
		assert.equal(reopened.binding, adopted.binding);
		assert.deepEqual(reopened.invocation.value, hamilton);
		assert.deepEqual(ok("learn-use", task, "/contexts/commuting").invocation.value, commuting);
		assert.equal(ok("history", prepared.probe.invocation_ref).payload.binding_ref, prepared.binding);
	}
});
