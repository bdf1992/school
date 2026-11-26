/**
 * The public v0 world law (builder-v0) as pure functions — the one role that
 * answers for what the world does: subject bytes, receiver readings, the
 * latch, condition operations, the exact and lossy views, and the expected
 * per-turn action of a case. Imports nothing; the checker's expectations come
 * only from here.
 */

export const LAW_VERSION = "builder-v0";

export const SUBJECT: readonly number[] = [0x41, 0x55, 0x4d, 0x00, 0x7f, 0x80, 0xfe, 0xff];
export const SUBJECT_HEX = "41554d007f80feff";

export type Receiver = "A" | "B";
export type Signal = number | null;
export type ConditionOp = "shade" | "unshade";
export interface CaseOp {
	turn: number;
	op: ConditionOp;
}
export interface BuilderCase {
	receiver: Receiver;
	signals: Signal[];
	conditionOps: CaseOp[];
}
export interface ExpectedTurn {
	turn: number;
	lamp: 0 | 1;
	byte: number;
}

/** Reading for a receiver; null (missing) when there is no signal, never zero. */
export function reading(receiver: Receiver, signal: Signal, condition: number): number | null {
	if (signal === null) return null;
	const base = receiver === "A" ? signal : 255 - signal;
	return Math.max(0, base - 32 * condition);
}

/** Latch: on at >=192, off at <=63, else unchanged; a missing reading leaves it unchanged. */
export function latchStep(latch: 0 | 1, read: number | null): 0 | 1 {
	if (read === null) return latch;
	if (read >= 192) return 1;
	if (read <= 63) return 0;
	return latch;
}

export function applyOp(condition: number, op: ConditionOp): number {
	return Math.min(3, Math.max(0, condition + (op === "shade" ? 1 : -1)));
}

export function bytesView(): number[] {
	return [...SUBJECT];
}
/** 64 bits, byte 0 first, most significant bit first. */
export function bitsView(): number[] {
	return SUBJECT.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1));
}
export function highNibblesView(): number[] {
	return SUBJECT.map((b) => b >> 4);
}
export function popcountView(): number {
	return bitsView().reduce((a, b) => a + b, 0);
}

/** Condition ops at a turn apply before that turn's reading, in list order. */
export function expectedTurns(c: BuilderCase): ExpectedTurn[] {
	let condition = 0;
	let latch: 0 | 1 = 0;
	return c.signals.map((signal, turn) => {
		for (const o of c.conditionOps) if (o.turn === turn) condition = applyOp(condition, o.op);
		latch = latchStep(latch, reading(c.receiver, signal, condition));
		return { turn, lamp: latch, byte: SUBJECT[turn % 8]! };
	});
}
