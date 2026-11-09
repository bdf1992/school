/** Bounded data-only parity artifacts. No model, filesystem, or world authority. */
export const MAX_SCHOOL_PARITY_BYTES = 64 * 1024;
export const MAX_SCHOOL_PARITY_STATES = 64;
export const MAX_SCHOOL_PARITY_INPUT_BITS = 4096;
export const SCHOOL_PARITY_EVALUATOR = "parity-count-v1" as const;
export const SCHOOL_PARITY_ADDITIONAL_INPUTS: readonly string[] = Object.freeze([
	"", "0", "1", "00", "01", "10", "11", "000", "101", "111",
	"000000000", "100000000", "111111111", "10".repeat(8), "1".repeat(31), "1".repeat(32),
]);

export type SchoolParityLabel = "EVEN" | "ODD";
export type SchoolParityBit = "0" | "1";
export interface SchoolParityState {
	id: string;
	output: SchoolParityLabel;
	transitions: Record<SchoolParityBit, string>;
}
export interface SchoolParityMachine {
	version: 1;
	kind: "parity-machine";
	alphabet: ["0", "1"];
	initial: string;
	states: SchoolParityState[];
}
export interface SchoolParityCaseResult {
	group: "byte" | "additional";
	input: string;
	expected: SchoolParityLabel;
	actual: SchoolParityLabel;
	terminalState: string;
	correct: boolean;
}
export interface SchoolParityEvaluation {
	evaluator: typeof SCHOOL_PARITY_EVALUATOR;
	coverage: "SUFFICIENT";
	status: "PASSED" | "FAILED";
	bytes: { checked: 256; passed: number; failed: number };
	additional: { checked: number; passed: number; failed: number };
	counterexample: SchoolParityCaseResult | null;
	cases: SchoolParityCaseResult[];
	scope: "ALL_256_BYTES_AND_DECLARED_STRINGS";
	equivalenceForAllStrings: "NOT_ESTABLISHED";
}
export class SchoolParityError extends Error {
	constructor(public code: "INVALID_PARITY_ARTIFACT" | "INVALID_PARITY_INPUT", message: string) {
		super(message); this.name = "SchoolParityError";
	}
}

function invalid(message: string): never { throw new SchoolParityError("INVALID_PARITY_ARTIFACT", message); }
function object(value: unknown, fields: readonly string[], where: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${where} must be an object`);
	const row = value as Record<string, unknown>;
	if (Object.keys(row).some((key) => !fields.includes(key))) invalid(`${where} contains an unsupported field`);
	if (fields.some((key) => !Object.hasOwn(row, key))) invalid(`${where} is missing a required field`);
	return row;
}
function identifier(value: unknown, where: string): string {
	if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)) invalid(`${where} must be a state ID of 1–64 letters, digits, underscores or hyphens, starting with a letter`);
	return value;
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
	return value;
}

/** Copies and freezes an admitted definition; names have no execution meaning. */
export function parseSchoolParityMachine(value: unknown): SchoolParityMachine {
	let encoded: string | undefined;
	try { encoded = JSON.stringify(value); } catch { invalid("Artifact must be bounded JSON"); }
	if (!encoded || new TextEncoder().encode(encoded).byteLength > MAX_SCHOOL_PARITY_BYTES) invalid("Artifact exceeds 64 KiB or is not JSON");
	const row = object(value, ["version", "kind", "alphabet", "initial", "states"], "artifact");
	if (row.version !== 1 || row.kind !== "parity-machine") invalid("Unsupported parity artifact version or kind");
	if (!Array.isArray(row.alphabet) || row.alphabet.length !== 2 || row.alphabet[0] !== "0" || row.alphabet[1] !== "1") invalid('Alphabet must be exactly ["0", "1"]');
	if (!Array.isArray(row.states) || row.states.length < 1 || row.states.length > MAX_SCHOOL_PARITY_STATES) invalid("Artifact needs 1–64 states");
	const initial = identifier(row.initial, "initial"), ids = new Set<string>();
	const states = row.states.map((value): SchoolParityState => {
		const state = object(value, ["id", "output", "transitions"], "state"), id = identifier(state.id, "state.id");
		if (ids.has(id)) invalid("State IDs must be unique");
		ids.add(id);
		if (state.output !== "EVEN" && state.output !== "ODD") invalid("Each state output must be EVEN or ODD");
		const transitions = object(state.transitions, ["0", "1"], "transitions");
		return { id, output: state.output, transitions: { "0": identifier(transitions["0"], "transition 0"), "1": identifier(transitions["1"], "transition 1") } };
	});
	if (!ids.has(initial)) invalid("Initial state must exist");
	if (states.some((state) => !ids.has(state.transitions["0"]) || !ids.has(state.transitions["1"]))) invalid("Every transition target must exist");
	return freeze({ version: 1, kind: "parity-machine", alphabet: ["0", "1"], initial, states });
}

function bits(input: unknown): asserts input is string {
	if (typeof input !== "string" || input.length > MAX_SCHOOL_PARITY_INPUT_BITS || !/^[01]*$/.test(input)) throw new SchoolParityError("INVALID_PARITY_INPUT", "Input must contain at most 4096 binary digits");
}

function execute(machine: SchoolParityMachine, input: string): { output: SchoolParityLabel; terminalState: string } {
	const byId = new Map(machine.states.map((state) => [state.id, state]));
	let current = byId.get(machine.initial)!;
	for (const bit of input) current = byId.get(current.transitions[bit as SchoolParityBit])!;
	return { output: current.output, terminalState: current.id };
}

/** Traverses declared transitions only; it never consults the parity oracle. */
export function executeSchoolParityMachine(raw: unknown, input: unknown): { output: SchoolParityLabel; terminalState: string } {
	const machine = parseSchoolParityMachine(raw);
	bits(input);
	return execute(machine, input);
}

/** Independent expected result: count the input's one bits, ignoring the artifact. */
export function schoolParityOracle(input: unknown): SchoolParityLabel {
	bits(input);
	return (input.match(/1/g)?.length ?? 0) % 2 === 0 ? "EVEN" : "ODD";
}

/** Exhaustive for bytes, with an explicit bounded supplement; not DFA equivalence. */
export function evaluateSchoolParityMachine(raw: unknown): SchoolParityEvaluation {
	const machine = parseSchoolParityMachine(raw);
	const inputs = [
		...Array.from({ length: 256 }, (_, value) => ({ group: "byte" as const, input: value.toString(2).padStart(8, "0") })),
		...SCHOOL_PARITY_ADDITIONAL_INPUTS.map((input) => ({ group: "additional" as const, input })),
	];
	const cases = inputs.map(({ group, input }): SchoolParityCaseResult => {
		const actual = execute(machine, input), expected = schoolParityOracle(input);
		return { group, input, expected, actual: actual.output, terminalState: actual.terminalState, correct: actual.output === expected };
	});
	const bytePassed = cases.filter((item) => item.group === "byte" && item.correct).length;
	const extraPassed = cases.filter((item) => item.group === "additional" && item.correct).length;
	const counterexample = cases.find((item) => !item.correct) ?? null;
	return {
		evaluator: SCHOOL_PARITY_EVALUATOR, coverage: "SUFFICIENT", status: counterexample ? "FAILED" : "PASSED",
		bytes: { checked: 256, passed: bytePassed, failed: 256 - bytePassed },
		additional: { checked: SCHOOL_PARITY_ADDITIONAL_INPUTS.length, passed: extraPassed, failed: SCHOOL_PARITY_ADDITIONAL_INPUTS.length - extraPassed },
		counterexample, cases, scope: "ALL_256_BYTES_AND_DECLARED_STRINGS", equivalenceForAllStrings: "NOT_ESTABLISHED",
	};
}
