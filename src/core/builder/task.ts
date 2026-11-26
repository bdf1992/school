/**
 * The v0 task record — the one role that answers for which cases exist and
 * what a case IS: the public G0 fixtures, the authored controls' intended
 * verdicts, parsing of alternate encodings, and case identity (SHA-256 of the
 * canonical encoding). Depends only on law.ts and canonical.ts.
 */
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { LAW_VERSION, type BuilderCase, type CaseOp, type ConditionOp, type Receiver, type Signal } from "./law.ts";

export interface NamedCase {
	name: string;
	case: BuilderCase;
}

const mk = (receiver: Receiver, signals: Signal[], ops: ConditionOp[] = []): BuilderCase => ({
	receiver,
	signals,
	conditionOps: ops.map((op) => ({ turn: 0, op })),
});

/** Public G0 fixtures (not a sealed split); every condition op happens before turn 0. */
export const G0_FIXTURES: readonly NamedCase[] = [
	{ name: "H1", case: mk("A", [220, 128]) },
	{ name: "H2", case: mk("A", [20, 128]) },
	{ name: "C1", case: mk("A", [220], ["shade", "shade"]) },
	{ name: "M1", case: mk("A", [220, null]) },
	{ name: "B1", case: mk("B", [20, 128]) },
	{ name: "R1", case: mk("A", Array(8).fill(128)) },
];

export type ReasonKind =
	| "lamp_mismatch"
	| "byte_mismatch"
	| "subject_changed"
	| "not_completed"
	| "turn_count_mismatch"
	| "action_not_admitted"
	| "malformed";

export interface ControlSpec {
	name: "correct" | "byte-corrupting" | "observer-confusing" | "history-forgetting";
	defect: string;
	failsOn: readonly string[];
	reasons: readonly ReasonKind[];
}
/** The four authored controls and their intended verdicts. */
export const CONTROLS: readonly ControlSpec[] = [
	{ name: "correct", defect: "none", failsOn: [], reasons: [] },
	{
		name: "byte-corrupting",
		defect: "reports byte from high_nibbles (value x 16)",
		failsOn: ["B1", "C1", "H1", "H2", "M1", "R1"],
		reasons: ["byte_mismatch"],
	},
	{
		name: "observer-confusing",
		defect: "applies calibration A whatever receiver it is bound to, ignores c",
		failsOn: ["B1", "C1"],
		reasons: ["lamp_mismatch"],
	},
	{
		name: "history-forgetting",
		defect: "lamp = reading >= 128 each turn, off when missing, no memory",
		failsOn: ["B1", "C1", "H2", "M1", "R1"],
		reasons: ["lamp_mismatch"],
	},
];

function isInt(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v);
}

/** Normalize any accepted encoding into a BuilderCase; throws on anything else. */
export function parseCase(raw: unknown): BuilderCase {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("case must be an object");
	const r = raw as Record<string, unknown>;
	if (r.receiver !== "A" && r.receiver !== "B") throw new Error("receiver must be A or B");
	if (!Array.isArray(r.signals) || r.signals.length === 0) throw new Error("signals must be a non-empty list");
	const signals = r.signals.map((s): Signal => {
		if (s === null || s === "missing") return null;
		if (isInt(s) && s >= 0 && s <= 255) return s;
		throw new Error("signal must be an integer 0-255, null or 'missing'");
	});
	const rawOps = r.conditionOps ?? r.condition_ops ?? [];
	if (!Array.isArray(rawOps)) throw new Error("condition ops must be a list");
	const ops = rawOps.map((o): CaseOp => {
		let turn = 0;
		let op: unknown = o;
		if (o !== null && typeof o === "object" && !Array.isArray(o)) {
			const od = o as Record<string, unknown>;
			op = od.op;
			if (od.turn !== undefined) turn = od.turn as number;
		}
		if (op !== "shade" && op !== "unshade") throw new Error("op must be shade or unshade");
		if (!isInt(turn) || turn < 0 || turn >= signals.length) throw new Error("op turn out of range");
		return { turn, op };
	});
	// Stable by turn: ops on different turns commute with list position, same-turn order is kept.
	const ordered = ops.map((o, i) => ({ o, i })).sort((a, b) => a.o.turn - b.o.turn || a.i - b.i).map((x) => x.o);
	return { receiver: r.receiver, signals, conditionOps: ordered };
}

/** The exact encoding hashed for identity. */
export function canonicalCaseEncoding(c: BuilderCase): string {
	return canonicalJson({
		condition_ops: c.conditionOps.map((o) => ({ op: o.op, turn: o.turn })),
		law_version: LAW_VERSION,
		receiver: c.receiver,
		signals: c.signals,
	});
}

export function caseIdentity(c: BuilderCase): string {
	return sha256Hex(canonicalCaseEncoding(c));
}

/** Identity of any accepted encoding. */
export function identityOf(raw: unknown): string {
	return caseIdentity(parseCase(raw));
}

export function fixtureByIdentity(id: string): NamedCase | undefined {
	return G0_FIXTURES.find((f) => caseIdentity(f.case) === id);
}
