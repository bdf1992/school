/**
 * Independent reference checker — the one role that grades a retained run
 * record ('school.builder-run/0') from the public law alone. Expectations
 * come from law.ts; a runtime receipt or outcome never establishes success.
 * Coverage is explicit: only all six G0 fixtures run and passed qualify.
 */
import { LAW_VERSION, SUBJECT_HEX, expectedTurns } from "./law.ts";
import {
	G0_FIXTURES,
	caseIdentity,
	fixtureByIdentity,
	parseCase,
	type ReasonKind,
} from "./task.ts";

export const RUN_FORMAT = "school.builder-run/0";
export const GRADE_FORMAT = "school.builder-grade/0";

export interface FailingTurn {
	turn: number;
	reasons: ReasonKind[];
}
export interface CaseVerdict {
	case_id: string | null;
	name?: string;
	pass: boolean;
	reasons: ReasonKind[];
	failing_turns: FailingTurn[];
}
export interface Grade {
	format: typeof GRADE_FORMAT;
	candidate: string | null;
	verdict: "qualified" | "not_qualified";
	coverage: { ran: string[]; missing: string[] };
	record_errors: string[];
	cases: CaseVerdict[];
	summary: { failing_cases: string[]; reason_kinds: ReasonKind[] };
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isByte = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255;
const isBit = (v: unknown): v is 0 | 1 => v === 0 || v === 1;
const uniq = <T extends string>(xs: T[]): T[] => [...new Set(xs)].sort();

function gradeRun(run: unknown): CaseVerdict {
	if (!isObj(run)) return { case_id: null, pass: false, reasons: ["malformed"], failing_turns: [] };
	let caseValue;
	try {
		caseValue = parseCase(run.case);
	} catch {
		return { case_id: null, pass: false, reasons: ["malformed"], failing_turns: [] };
	}
	const id = caseIdentity(caseValue);
	const name = fixtureByIdentity(id)?.name;
	const reasons: ReasonKind[] = [];
	const failing: FailingTurn[] = [];
	const expected = expectedTurns(caseValue);

	if (run.outcome !== "completed") reasons.push(run.outcome === "refused" || run.outcome === "limit_exhausted" || run.outcome === "unresolved" ? "not_completed" : "malformed");
	if (typeof run.subject_after_hex !== "string") reasons.push("malformed");
	else if (run.subject_after_hex.toLowerCase() !== SUBJECT_HEX) reasons.push("subject_changed");

	if (!Array.isArray(run.turns)) reasons.push("malformed");
	else {
		if (run.turns.length !== expected.length) reasons.push("turn_count_mismatch");
		run.turns.slice(0, expected.length).forEach((t, i) => {
			const tr: ReasonKind[] = [];
			const action = isObj(t) && isObj(t.action) ? t.action : null;
			if (!isObj(t) || t.turn !== i || action === null || action.type !== "signal" || !isBit(action.lamp) || !isByte(action.byte) || typeof t.admitted !== "boolean" || !isBit(t.recorded_lamp)) {
				tr.push("malformed");
			} else {
				if (action.lamp !== expected[i]!.lamp) tr.push("lamp_mismatch");
				if (action.byte !== expected[i]!.byte) tr.push("byte_mismatch");
				// A lamp the world did not record as proposed is an action the world did not admit as proposed.
				if (t.admitted !== true || t.recorded_lamp !== action.lamp) tr.push("action_not_admitted");
			}
			if (tr.length > 0) {
				failing.push({ turn: i, reasons: tr });
				reasons.push(...tr);
			}
		});
	}
	const all = uniq(reasons);
	return { case_id: id, ...(name === undefined ? {} : { name }), pass: all.length === 0, reasons: all, failing_turns: failing };
}

export function gradeRunRecord(record: unknown): Grade {
	const errors: string[] = [];
	const verdicts: CaseVerdict[] = [];
	let candidate: string | null = null;
	if (!isObj(record)) errors.push("record is not an object");
	else {
		if (record.format !== RUN_FORMAT) errors.push(`format must be ${RUN_FORMAT}`);
		if (record.law_version !== LAW_VERSION) errors.push(`law_version must be ${LAW_VERSION}`);
		if (typeof record.candidate === "string") candidate = record.candidate;
		else errors.push("candidate label missing");
		if (!Array.isArray(record.runs)) errors.push("runs must be a list");
		else verdicts.push(...record.runs.map(gradeRun));
	}
	const ranNames = new Set(verdicts.flatMap((v) => (v.name === undefined ? [] : [v.name])));
	const allNames = G0_FIXTURES.map((f) => f.name);
	const missing = allNames.filter((n) => !ranNames.has(n));
	const failing = verdicts.filter((v) => !v.pass);
	const summary = {
		failing_cases: uniq(failing.map((v) => v.name ?? v.case_id ?? "malformed")),
		reason_kinds: uniq(failing.flatMap((v) => v.reasons)),
	};
	const qualified = errors.length === 0 && missing.length === 0 && failing.length === 0;
	return {
		format: GRADE_FORMAT,
		candidate,
		verdict: qualified ? "qualified" : "not_qualified",
		coverage: { ran: allNames.filter((n) => ranNames.has(n)), missing },
		record_errors: errors,
		cases: verdicts,
		summary,
	};
}
