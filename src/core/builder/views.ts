/**
 * Participant projections — the one role that decides what each participant
 * of a builder episode may see: builder (learner), teacher, resident (per
 * turn) and evaluator. Sealed cases and every expectation about them appear
 * only in the evaluator view; the resident never receives an expectation.
 */
import {
	LAW_VERSION,
	SUBJECT_HEX,
	bitsView,
	bytesView,
	expectedTurns,
	highNibblesView,
	popcountView,
	type Receiver,
	type Signal,
} from "./law.ts";
import { caseIdentity, type NamedCase } from "./task.ts";

export interface BuilderTask {
	teaching: NamedCase[];
	sealed: NamedCase[];
	/** Declared by the caller; never defaulted. */
	budgets: Record<string, number>;
}

const PUBLIC_LAW = {
	subject_hex: SUBJECT_HEX,
	calibration: { A: "max(0, s - 32c)", B: "max(0, (255 - s) - 32c)" },
	latch: "on at reading >= 192, off at <= 63, else unchanged; missing leaves unchanged; initially off",
	action: "signal(lamp: on|off, byte: 0-255); lamp is the latch after this turn; byte is subject[turn mod 8]",
	condition_ops: "shade (+1), unshade (-1), clamped 0..3",
} as const;

export function builderView(task: BuilderTask) {
	return {
		law_version: LAW_VERSION,
		law: PUBLIC_LAW,
		interface: { action: "signal", views: ["bytes", "bits", "high_nibbles", "popcount"] },
		budgets: task.budgets,
		teaching_cases: task.teaching.map((t) => ({
			name: t.name,
			case: t.case,
			expected_lamps: expectedTurns(t.case).map((e) => (e.lamp === 1 ? "on" : "off")),
		})),
	};
}

export interface AttemptRecord {
	attempt: number;
	summary: string;
	diagnostics: string[];
}

export function teacherView(task: BuilderTask, attempts: AttemptRecord[]) {
	return { ...builderView(task), attempts, role: "teacher" as const };
}

export interface ResidentTurnInput {
	receiver: Receiver;
	signal: Signal;
	condition: number;
	turn: number;
	memory: unknown;
}

export function residentTurnView(i: ResidentTurnInput) {
	return {
		signal: i.signal === null ? "missing" : i.signal,
		receiver: i.receiver,
		condition: i.condition,
		turn: i.turn,
		memory: i.memory,
		subject: {
			bytes: bytesView(),
			bits: bitsView(),
			high_nibbles: highNibblesView(),
			popcount: popcountView(),
		},
	};
}

export function evaluatorView(task: BuilderTask) {
	const expand = (cases: NamedCase[]) =>
		cases.map((t) => ({ name: t.name, id: caseIdentity(t.case), case: t.case, expected: expectedTurns(t.case) }));
	return { ...builderView(task), teaching: expand(task.teaching), sealed: expand(task.sealed), role: "evaluator" as const };
}
