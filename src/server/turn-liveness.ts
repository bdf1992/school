/**
 * Server-side turn liveness: which chats currently have a teacher turn in
 * flight. The missing half of "sessions keep running in the background" —
 * together with the write-ahead persist in chat-handler, a returning client
 * can tell "the teacher is mid-turn — don't resurrect, don't start anything"
 * apart from "the record IS current".
 *
 * Lives on globalThis, NOT a module-level Map: Next dev compiles each route
 * as its own entry, so a module-level singleton is a DIFFERENT instance in
 * the page render, GET /api/chats/[id], and POST /api/chat — the page would
 * read an empty registry while the chat route holds the live turn (the bug:
 * returning mid-turn showed the 409 banner instead of the busy state).
 * globalThis spans module instances within the process; it is the standard
 * Next.js singleton channel (same reason Prisma clients live there).
 *
 * Still ephemeral BY DESIGN: a process restart clears it, so there are no
 * stale flags to clean up — a crashed turn recovers via the write-ahead
 * record + mount continuation on the next visit. Elapsed time cannot prove
 * the executor stopped. Only the execution that acquired the lease may
 * release it after settlement; abort requests retain it until then.
 */

import { emit } from "../core/events.ts";
import { clearTurnFailure } from "./turn-runs.ts";

export type TurnLease = symbol;

interface LhGlobal {
	__lhTurnRegistry?: Map<string, TurnLease>;
}

function registry(): Map<string, TurnLease> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhTurnRegistry ??= new Map<string, TurnLease>());
}

const inFlight = registry();

/**
 * Acquire a turn's opaque lease. Returns false if one is already running for the
 * chat — the caller rejects the request (only one turn may own a chat).
 * Announces "turn-started" AFTER the registry write: a listener that reads
 * isTurnRunning or fetches the record sees consistent truth. The rejected
 * double-begin (the 409 path) stays silent — no turn began.
 */
export function beginTurn(chatId: string): TurnLease | false {
	if (isTurnRunning(chatId)) return false;
	clearTurnFailure(chatId);
	const lease = Symbol(chatId);
	inFlight.set(chatId, lease);
	emit("turn-started", { chatId });
	return lease;
}

/**
 * Mark the chat's turn as finished after normal settlement, or after the
 * failure notice has been retained by settlement cleanup. A subsequent
 * fetch reads durable truth, never a promise that an unsaved reply landed.
 * Emits only when an entry was actually present: a
 * defensive no-op endTurn must not fire a spurious settle.
 */
export function endTurn(chatId: string, lease: TurnLease): boolean {
	if (!isTurnCurrent(chatId, lease)) return false;
	inFlight.delete(chatId);
	emit("turn-settled", { chatId });
	return true;
}

/** Whether this exact execution still owns the chat's state. */
export function isTurnCurrent(chatId: string, lease: TurnLease): boolean {
	return typeof lease === "symbol" && inFlight.get(chatId) === lease;
}

/** A read never expires ownership or starts recovery. */
export function isTurnRunning(chatId: string): boolean {
	return inFlight.has(chatId);
}
