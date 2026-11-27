import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ProposalIds, roomCopy, runBoundaryCases, SeatRoom, type Step } from "../scripts/school-worldspine-seat.ts";

function counter() {
	let n = 0;
	return () => `id-${++n}`;
}

test("a retry resends the act id the proposal was first sent with", () => {
	const ids = new ProposalIds("", counter());
	const first = ids.first("set-high");
	ids.first("other");
	assert.equal(ids.retry("set-high"), first);
	assert.equal(ids.retry("set-high"), first);
});

test("the double-delivery plant mints a fresh act id on retry", () => {
	const ids = new ProposalIds("double-delivery", counter());
	const first = ids.first("set-high");
	assert.notEqual(ids.retry("set-high"), first);
});

test("retrying a proposal that was never sent is an error, not a fresh act", () => {
	assert.throws(() => new ProposalIds().retry("never-sent"), /no act id kept/);
});

// The native boundary itself: runs only where Worldspine's ws_pg is built (set WORLDSPINE_PG and WORLDSPINE_PLAYGROUND).
const pg = process.env.WORLDSPINE_PG ?? "";
const playground = process.env.WORLDSPINE_PLAYGROUND ?? "";
const native = existsSync(pg) && existsSync(join(playground, "experiments", "shared-room"));

async function boundary(plant: "" | "double-delivery"): Promise<Map<string, Step>> {
	const work = mkdtempSync(join(tmpdir(), "school-seat-test-"));
	const room = new SeatRoom(pg, roomCopy(playground, work, 200_000));
	try {
		const steps = await runBoundaryCases(room, new ProposalIds(plant));
		return new Map(steps.map((s) => [s.step, s]));
	} finally {
		await room.close();
		rmSync(work, { recursive: true, force: true });
	}
}

type Answer = { code: string; decision: string; digest: string; seat: string };
const host = (step: Step | undefined) => (step?.host ?? []) as Answer[];
function only(step: Step | undefined): Answer {
	const answers = host(step);
	assert.equal(answers.length, 1, `one host answer for ${step?.step}`);
	return answers[0] as Answer;
}

test("through join, an identical retry returns the original receipt and a refusal stays a refusal", { skip: !native && "ws_pg not configured" }, async () => {
	const steps = await boundary("");
	assert.ok(steps.get("up")?.ok, "the room came up and every seat subscribed");
	const normal = only(steps.get("normal"));
	assert.equal(normal.code, "ADMITTED");
	assert.deepEqual(host(steps.get("identical-retry")).map((a) => a.digest), [normal.digest]);
	assert.equal(steps.get("identical-retry")?.receipts, 1);
	const conflict = only(steps.get("conflicting-retry"));
	assert.equal(conflict.code, "ACT_CONFLICTING_DUPLICATE");
	assert.notEqual(conflict.digest, normal.digest);
	assert.equal(only(steps.get("observer-refused")).code, "CAPABILITY_MISSING");
	assert.deepEqual(steps.get("admitted-unsuccessful")?.axes, [{ address: "marker:1", moved: false, reason: "wall" }]);
});

test("through join, the double-delivery plant becomes a second effect", { skip: !native && "ws_pg not configured" }, async () => {
	const steps = await boundary("double-delivery");
	const normal = only(steps.get("normal"));
	assert.notEqual(only(steps.get("identical-retry")).digest, normal.digest);
});
