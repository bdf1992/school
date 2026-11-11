import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const runtime = process.env.SCHOOL_FOUNDATION_V020;
const cli = "scripts/school-state-space.ts";
const source = "examples/school/state-space/SPACE.prompt.json";

test("SPACE imports, assesses, adopts and reopens through the School CLI", {
	skip: runtime ? false : "Set SCHOOL_FOUNDATION_V020 to the extracted Foundation 0.2.0 directory",
}, (t) => {
	const root = mkdtempSync(path.join(os.tmpdir(), "school-state-space-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	function call(command: string, ...args: string[]) {
		const result = spawnSync(process.execPath, ["--import", "tsx", cli, command, root, runtime!, ...args],
			{ encoding: "utf8", timeout: 12_000 });
		if (result.error) throw result.error;
		return result;
	}
	function ok(command: string, ...args: string[]) {
		const result = call(command, ...args);
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout);
	}
	const initialized = ok("init");
	const sourceArtifact = JSON.parse(readFileSync(source, "utf8"));
	const snapshot = initialized.world.snapshot;
	assert.equal(snapshot, sourceArtifact.integrity.digest);
	assert.equal(initialized.world.sourceSha256, createHash("sha256").update(readFileSync(source)).digest("hex"));
	assert.equal(ok("init").class.created, false);
	for (const address of ["/space", "/protocol/enter", "/language/expressions", "/dictionary"]) {
		assert.deepEqual(ok("resolve", snapshot, address), { snapshot, address, record: sourceArtifact.records[address] });
	}
	assert.notEqual(call("resolve", snapshot, "/contexts/../space").status, 0);
	assert.match(call("run", "wrong-learner", "teacher", "good").stderr, /learner role/);

	const bad = ok("run", "bad", "local-learner", "bad");
	assert.equal(bad.assessment.approved, false);
	assert.ok(bad.assessment.cases.some((row: { baseline_pass: boolean; candidate_pass: boolean }) => row.baseline_pass && !row.candidate_pass));
	assert.match(call("adopt", "bad-adoption", "local-learner", bad.assessment.assessment_ref, bad.expectedBinding).stderr, /pinned acceptance/);
	assert.equal(ok("inspect").binding, bad.expectedBinding);

	const bodyFile = path.join(root, "candidate.json");
	writeFileSync(bodyFile, JSON.stringify({ literal: [0, 0, 0, 0], suite_ref: bad.assessment.suite_ref }));
	assert.match(call("run", "override", "local-learner", "body", bodyFile).stderr, /Unknown expression form/);

	const good = ok("run", "good", "local-learner", "good");
	assert.equal(good.assessment.suite_ref, bad.assessment.suite_ref);
	assert.equal(good.assessment.approved, true);
	assert.equal(good.assessment.baseline_passed, 8);
	assert.equal(good.assessment.candidate_passed, 10);
	assert.equal(ok("inspect").binding, good.expectedBinding);
	const adopted = ok("adopt", "adoption", "local-learner", good.assessment.assessment_ref, good.expectedBinding);
	assert.match(call("adopt", "stale", "local-learner", good.assessment.assessment_ref, good.expectedBinding).stderr, /Stale binding/);
	const continued = ok("continue", "fresh", "local-learner");
	assert.deepEqual(continued.invocation.value, ["-2/9", "0", "8/3", "8/3"]);
	assert.equal(ok("history", continued.invocation.invocation_ref).payload.binding_ref, adopted.result.binding);
	assert.equal(ok("history", good.invocation.invocation_ref).payload.binding_ref, good.expectedBinding);
	assert.deepEqual(ok("history", good.invocation.run_ref).payload.value, ["-5", "0", "0", "4"]);
	assert.equal(ok("inspect").slot, initialized.world.slot);
	const inputFile = path.join(root, "input.json");
	writeFileSync(inputFile, JSON.stringify({ context: "/contexts/commuting", x: [0, 1, 0, 0], y: [0, 0, 1, 0] }));
	assert.deepEqual(ok("invoke", "commuting", "local-learner", inputFile).invocation.value, ["-2", "0", "0", "2"]);
	assert.notEqual(call("continue", "fresh", "local-learner").status, 0);
	const receipt = readFileSync(continued.filename, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(receipt[0].value.class.class.id, "state-space");
	assert.equal(receipt[0].value.learner, "local-learner");
	assert.ok(receipt[1].value.records.some((record: { address: string }) => record.address === "/protocol/enter"));
});
