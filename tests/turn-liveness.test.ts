/**
 * Turn liveness registry unit tests (src/server/turn-liveness.ts): one turn
 * per chat, ever — begin/end round trip, double-begin rejection, restart
 * after end, long-running ownership and stale settlement. The lifecycle-emitter pins ride the same seams:
 * turn-started on the accepted begin only, turn-settled on the live end
 * only, and the registry already consistent when the listener runs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { beginTurn, endTurn, isTurnRunning } from "../src/server/turn-liveness.ts";
import { subscribe, type ServerEvent } from "../src/core/events.ts";
import { abortTurn, registerTurn, rememberTurnFailure, runningTurn, settledTurnResponse, unregisterTurn } from "../src/server/turn-runs.ts";
import type { PiTurnHandle } from "../src/server/pi/ui-stream.ts";

describe("turn liveness registry", () => {
	it("keeps a live turn exclusive after thirty minutes and releases only on settlement", () => {
		const id = "chat_long_running_owner";
		const originalNow = Date.now;
		let now = originalNow();
		Date.now = () => now;
		const owner = beginTurn(id);
		assert.ok(owner);
		try {
			now += 31 * 60_000;
			assert.equal(isTurnRunning(id), true, "elapsed time does not mean the executor stopped");
			assert.ok(!beginTurn(id), "another turn cannot overlap a live owner");
		} finally {
			Date.now = originalNow;
			endTurn(id, owner);
		}
		assert.equal(isTurnRunning(id), false);
	});

	it("stale settlement cannot release a newer turn or announce its settlement", () => {
		const id = "chat_stale_owner";
		const first = beginTurn(id);
		assert.ok(first);
		endTurn(id, first);
		const second = beginTurn(id);
		assert.ok(second);
		const got: ServerEvent[] = [];
		const off = subscribe((event) => { if (event.type === "turn-settled" && event.chatId === id) got.push(event); });
		try {
			endTurn(id, first);
			assert.equal(isTurnRunning(id), true, "late cleanup belongs to the first execution only");
			assert.deepEqual(got, []);
			endTurn(id, second);
			assert.equal(isTurnRunning(id), false);
			assert.equal(got.length, 1);
		} finally { off(); endTurn(id, second); }
	});

	it("stale handle cleanup preserves the successor's reattach and cancellation target", () => {
		const id = "chat_stale_handle";
		let firstAborts = 0; let secondAborts = 0;
		const handle = (abort: () => void): PiTurnHandle => ({ abort, subscribe: () => new ReadableStream() });
		const first = handle(() => { firstAborts++; });
		const second = handle(() => { secondAborts++; });
		registerTurn(id, first);
		unregisterTurn(id, first);
		registerTurn(id, second);
		try {
			assert.equal(unregisterTurn(id, first), false);
			assert.strictEqual(runningTurn(id), second);
			assert.deepEqual(abortTurn(id), { ok: true });
			assert.equal(firstAborts, 0);
			assert.equal(secondAborts, 1);
		} finally { unregisterTurn(id, second); }
	});

	it("retains a late-attach failure notice until the next accepted begin", async () => {
		const id = "chat_failure_notice_unit";
		rememberTurnFailure(id, "The reply could not be saved.");
		assert.match(await settledTurnResponse(id).text(), /The reply could not be saved\./);
		assert.match(await settledTurnResponse(id).text(), /The reply could not be saved\./, "reading does not consume the notice");
		const lease = beginTurn(id); assert.ok(lease);
		assert.doesNotMatch(await settledTurnResponse(id).text(), /"type":"error"/);
		endTurn(id, lease);
	});

	it("begin/end round trip; a second begin is rejected until the turn ends", () => {
		const id = "chat_liveness_unit";
		assert.equal(isTurnRunning(id), false, "initially idle");
		const first = beginTurn(id); assert.ok(first, "first turn accepted");
		assert.equal(isTurnRunning(id), true, "in flight");
		assert.equal(beginTurn(id), false, "no two turns for one chat");
		endTurn(id, first);
		assert.equal(isTurnRunning(id), false, "cleared at finish");
		const second = beginTurn(id); assert.ok(second, "a new turn may start after the last ended");
		endTurn(id, second);
	});
});

describe("turn lifecycle events", () => {
	it("beginTurn emits turn-started on success only — the 409 double-begin stays silent", () => {
		const id = "chat_events_begin";
		const got: ServerEvent[] = [];
		const off = subscribe((e) => got.push(e));
		const lease = beginTurn(id); assert.ok(lease, "fresh chat accepts the turn");
		assert.equal(beginTurn(id), false, "the rejected double-begin");
		assert.deepEqual(got, [{ type: "turn-started", chatId: id }], "exactly one event");
		endTurn(id, lease); // cleanup (its settle is asserted in the next case's terms)
		off();
	});

	it("endTurn emits turn-settled only when a live entry was present", () => {
		const id = "chat_events_end";
		const got: ServerEvent[] = [];
		let runningAtSettle: boolean | undefined;
		const off = subscribe((e) => {
			got.push(e);
			// The settle must be observable as already-idle: the registry
			// write happens BEFORE the emit, so a listener that fetches truth
			// (the whole point of notify → fetch) reads consistent state.
			if (e.type === "turn-settled") runningAtSettle = isTurnRunning(id);
		});
		const lease = beginTurn(id); assert.ok(lease);
		got.length = 0; // focus on the settle path
		endTurn(id, lease); // live entry → settle
		endTurn(id, lease); // absent entry → defensive no-op, must stay silent
		assert.deepEqual(got, [{ type: "turn-settled", chatId: id }]);
		assert.equal(runningAtSettle, false, "listener sees the registry already cleared");
		off();
	});
});
