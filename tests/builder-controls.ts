/**
 * Authored builder controls (no model) — test support: small independent
 * implementations of the four defective residents, each producing a run
 * record in 'school.builder-run/0'. Deliberately shares no code with the checker.
 */
import { G0_FIXTURES } from "../src/core/builder/task.ts";

const SUBJ = [0x41, 0x55, 0x4d, 0x00, 0x7f, 0x80, 0xfe, 0xff];
type Step = { signal: number | null; c: number; receiver: "A" | "B" };
type Brain = (s: Step, turn: number, mem: { latch: number }) => { lamp: number; byte: number };

const read = (rx: "A" | "B", s: number | null, c: number) => (s === null ? null : Math.max(0, (rx === "A" ? s : 255 - s) - 32 * c));
const latch = (m: number, r: number | null) => (r === null ? m : r >= 192 ? 1 : r <= 63 ? 0 : m);

const brains: Record<string, Brain> = {
	correct: (s, t, m) => {
		m.latch = latch(m.latch, read(s.receiver, s.signal, s.c));
		return { lamp: m.latch, byte: SUBJ[t % 8]! };
	},
	"byte-corrupting": (s, t, m) => {
		m.latch = latch(m.latch, read(s.receiver, s.signal, s.c));
		return { lamp: m.latch, byte: (SUBJ[t % 8]! >> 4) * 16 };
	},
	"observer-confusing": (s, t, m) => {
		m.latch = latch(m.latch, read("A", s.signal, 0));
		return { lamp: m.latch, byte: SUBJ[t % 8]! };
	},
	"history-forgetting": (s, t) => {
		const r = read(s.receiver, s.signal, s.c);
		return { lamp: r !== null && r >= 128 ? 1 : 0, byte: SUBJ[t % 8]! };
	},
};

export const CONTROL_NAMES = Object.keys(brains);

export function runControl(name: string, outcome = "completed") {
	const runs = G0_FIXTURES.map(({ case: c }) => {
		let cond = 0;
		const mem = { latch: 0 };
		const turns = c.signals.map((signal, turn) => {
			for (const o of c.conditionOps) if (o.turn === turn) cond = Math.min(3, Math.max(0, cond + (o.op === "shade" ? 1 : -1)));
			const action = brains[name]!({ signal, c: cond, receiver: c.receiver }, turn, mem);
			return { turn, action: { type: "signal", lamp: action.lamp, byte: action.byte }, admitted: true, recorded_lamp: action.lamp };
		});
		return {
			case: { receiver: c.receiver, signals: c.signals, conditionOps: c.conditionOps },
			outcome,
			turns,
			subject_after_hex: "41554d007f80feff",
		};
	});
	return { format: "school.builder-run/0", law_version: "builder-v0", candidate: name, runs };
}
