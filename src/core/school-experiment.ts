/** A reproducible, independently checked contextual-learning experiment.
 * No model, filesystem, credentials, or training authority lives in this module. */
import type { SchoolCase, SchoolCallRecord, SchoolEpisodeManifest, SchoolEpisodeRecord, SchoolEvaluationCase, SchoolGrade, SchoolParticipant } from "./school-episode.ts";

export const SCHOOL_EXPERIMENT_FAMILY = "factorized-scalar-step-v1" as const;
export const FACTORIZED_WORLD = {
	id: "factorized-scalar-step", revision: "1", subject: "Equal present products can have different next learning steps",
	instructions: "The scalar model is f=a*b*x. Its loss is (f-target)^2/2. A step updates a and b simultaneously by gradient descent at the supplied rate, using both derivatives at the original a,b. For a product task return a*b; for a step task return the new effective coefficient a_next*b_next. Return one exact reduced fraction n/d, or an integer when its denominator is 1. No explanation.",
} as const;

export interface FactorizedParameters {
	operation: "product" | "step";
	a: string; b: string; x: string; target: string; rate: string;
}
export interface SchoolExperimentProtocol {
	version: 1;
	family: typeof SCHOOL_EXPERIMENT_FAMILY;
	seed: number;
	cold: true;
	memory?: true;
	/** New parameters, revealed only to the learner after teaching has ended. */
	transfer: SchoolEvaluationCase[];
	disclosure: "after-completion";
}
export type SchoolExperimentManifest = Extract<SchoolEpisodeManifest, { version: 2 }> & { experiment: SchoolExperimentProtocol };
export type SchoolExperimentCondition = "baseline" | "assisted" | "cold" | "memory" | "transfer";
export interface SchoolExperimentCount { expected: number; graded: number; correct: number | null }
export interface SchoolExperimentConditionResult {
	condition: SchoolExperimentCondition;
	assistance: "none" | "lesson" | "saved-memory";
	coverage: "ABSENT" | "INSUFFICIENT" | "SUFFICIENT";
	target: SchoolExperimentCount;
	retention: SchoolExperimentCount;
	/** Cases correct in baseline but wrong in this condition; transfer uses new cases. */
	regressions: string[];
}
export interface SchoolExperimentReport {
	version: 1;
	family: typeof SCHOOL_EXPERIMENT_FAMILY;
	seed: number;
	conditions: SchoolExperimentConditionResult[];
	disclosure: "after-completion";
	transferCondition: "LESSON_ASSISTED_FRESH_PARAMETERS";
	weightLearning: "NOT_PERFORMED";
	persistence: "NOT_ESTABLISHED";
	generalization: "NOT_ESTABLISHED";
	evidenceScope: "THIS_GENERATOR_AND_SEED";
}
export interface SchoolExposureReceipt {
	sequence: number;
	callId: string;
	participantId: string;
	role: "learner" | "teacher";
	condition: SchoolExperimentCondition | "teaching";
	viewSha256: string;
	caseId?: string;
	problemSha256?: string;
	lessonSha256?: string;
	memorySha256?: string;
	/** Call admission/completion records remain the evidence of dispatch/reply. */
	delivery: "NOT_ATTESTED";
	/** This ledger records School's prepared views, not unknown pretraining exposure. */
	scope: "SCHOOL_SUPPLIED_VIEW";
}
export class SchoolExperimentError extends Error {
	readonly code = "INVALID_EXPERIMENT";
	readonly status = 400;
	constructor(message: string) { super(message); this.name = "SchoolExperimentError"; }
}

function invalid(message: string): never { throw new SchoolExperimentError(message); }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Experiment values must be objects");
	const row = value as Record<string, unknown>;
	if (Object.keys(row).some((key) => !fields.includes(key))) invalid("Experiment contains an unsupported field");
	return row;
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	const result = JSON.stringify(value);
	if (result === undefined) invalid("Experiment contains a non-JSON value");
	return result;
}
function seedOf(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 0xffffffff) invalid("Seed must be an integer from 1 through 4294967295");
	return value;
}

interface Rational { n: bigint; d: bigint }
function fraction(n: bigint, d = 1n): Rational {
	if (d === 0n) invalid("A rational denominator cannot be zero");
	if (d < 0n) { n = -n; d = -d; }
	let a = n < 0n ? -n : n, b = d;
	while (b !== 0n) { const next = a % b; a = b; b = next; }
	return { n: n / a, d: d / a };
}
function rational(value: unknown): Rational {
	if (typeof value !== "string" || value.length > 80 || !/^-?(?:0|[1-9]\d*)(?:\/[1-9]\d*)?$/.test(value)) invalid("Task parameters must be bounded rational strings");
	const [n, d] = value.split("/");
	return fraction(BigInt(n!), d === undefined ? 1n : BigInt(d));
}
function add(a: Rational, b: Rational): Rational { return fraction(a.n * b.d + b.n * a.d, a.d * b.d); }
function sub(a: Rational, b: Rational): Rational { return fraction(a.n * b.d - b.n * a.d, a.d * b.d); }
function mul(a: Rational, b: Rational): Rational { return fraction(a.n * b.n, a.d * b.d); }
function encoded(a: Rational): string { return a.d === 1n ? String(a.n) : `${a.n}/${a.d}`; }

export function parseFactorizedParameters(value: unknown): FactorizedParameters {
	const row = object(value, ["operation", "a", "b", "x", "target", "rate"]);
	if (row.operation !== "product" && row.operation !== "step") invalid("Unsupported factorized task operation");
	const values = Object.fromEntries(["a", "b", "x", "target", "rate"].map((key) => [key, encoded(rational(row[key]))]));
	if (rational(values.rate).n <= 0n) invalid("The gradient-step rate must be positive");
	return { operation: row.operation, a: values.a!, b: values.b!, x: values.x!, target: values.target!, rate: values.rate! };
}

/** Independent oracle: compute the two simultaneous gradient updates directly.
 * The generator below uses the expanded product polynomial instead. */
export function factorizedTaskAnswer(raw: unknown): string {
	const p = parseFactorizedParameters(raw);
	const a = rational(p.a), b = rational(p.b);
	if (p.operation === "product") return encoded(mul(a, b));
	const x = rational(p.x), error = sub(mul(mul(a, b), x), rational(p.target));
	const scale = mul(mul(rational(p.rate), error), x);
	return encoded(mul(sub(a, mul(scale, b)), sub(b, mul(scale, a))));
}
function expandedAnswer(p: FactorizedParameters): string {
	const a = rational(p.a), b = rational(p.b), q = mul(a, b);
	if (p.operation === "product") return encoded(q);
	const x = rational(p.x), e = sub(mul(q, x), rational(p.target)), rate = rational(p.rate);
	const scale = mul(mul(rate, e), x);
	return encoded(add(sub(q, mul(scale, add(mul(a, a), mul(b, b)))), mul(mul(scale, scale), q)));
}

export function factorizedCaseParameters(item: Pick<SchoolCase, "question" | "observations">): FactorizedParameters {
	if (item.observations.length !== 1 || item.observations[0]?.status !== "SUFFICIENT" || typeof item.observations[0].content !== "string") invalid("Factorized tasks require one sufficient parameter observation");
	let raw: unknown;
	try { raw = JSON.parse(item.observations[0].content); } catch { invalid("Factorized task parameters must be JSON"); }
	const parameters = parseFactorizedParameters(raw);
	if (item.question !== questionFor(parameters.operation)) invalid("Factorized question does not match its operation");
	return parameters;
}
function questionFor(operation: FactorizedParameters["operation"]): string {
	return operation === "product" ? "What is the current effective coefficient a*b?" : "What is the effective coefficient a_next*b_next after one simultaneous gradient step?";
}
function caseFor(id: string, p: FactorizedParameters): SchoolCase {
	return { id, question: questionFor(p.operation), observations: [{ id: "parameters", status: "SUFFICIENT", content: JSON.stringify(p) }], expected: expandedAnswer(p) };
}

/** Identity ignores display IDs, exchange of the two factors, and parameters
 * irrelevant to a product question. It does not claim mathematical equivalence
 * detection in general, or novelty relative to unknown pretraining data. */
export function factorizedCaseIdentity(item: Pick<SchoolCase, "question" | "observations">): string {
	const p = factorizedCaseParameters(item), a = rational(p.a), b = rational(p.b);
	const [first, second] = a.n * b.d <= b.n * a.d ? [p.a, p.b] : [p.b, p.a];
	return canonical(p.operation === "product" ? { operation: p.operation, a: first, b: second } : { ...p, a: first, b: second });
}

/** Check the scalar answer artifact against the direct gradient calculation.
 * This checks its meaning, not just whether a JSON object or fraction parses.
 * The production episode still applies its declared trimmed-exact-v1 grader. */
export function checkFactorizedAnswer(item: Pick<SchoolCase, "question" | "observations">, answer: unknown): boolean {
	if (typeof answer !== "string") return false;
	const expected = factorizedTaskAnswer(factorizedCaseParameters(item));
	return answer.trim() === expected;
}

/** Does not use the generator or trust an authored answer key. */
export function verifyFactorizedCase(item: SchoolCase): void {
	if (!checkFactorizedAnswer(item, item.expected)) invalid("An authored task key failed independent verification");
}

export function generatedFactorizedCases(seed: number): { teaching: SchoolCase[]; evaluation: SchoolEvaluationCase[]; transfer: SchoolEvaluationCase[] } {
	let state = seedOf(seed);
	const draw = (size: number) => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % size; };
	const teaching = [
		caseFor(`factor-${seed}-teach-a`, { operation: "step", a: "2", b: "3", x: "1", target: "0", rate: "1/10" }),
		caseFor(`factor-${seed}-teach-b`, { operation: "step", a: "6", b: "1", x: "1", target: "0", rate: "1/10" }),
		caseFor(`factor-${seed}-teach-product`, { operation: "product", a: "2", b: "3", x: "1", target: "0", rate: "1/10" }),
	];
	const used = new Set(teaching.map(factorizedCaseIdentity));
	function batch(label: string): SchoolEvaluationCase[] {
		return Array.from({ length: 4 }, (_, index) => {
			const operation = index === 3 ? "product" : "step";
			for (let tries = 0; tries < 1000; tries++) {
				const p: FactorizedParameters = { operation, a: String(1 + draw(9)), b: String(1 + draw(9)), x: String(1 + draw(3)), target: String(draw(25) - 12), rate: `1/${10 + draw(21)}` };
				const item = caseFor(`factor-${seed}-${label}-${index + 1}`, p), key = factorizedCaseIdentity(item);
				if (used.has(key) || item.expected === "0") continue;
				used.add(key);
				return { ...item, split: index === 3 ? "retention" : "target" };
			}
			return invalid("Could not produce distinct nonzero task instances");
		});
	}
	return { teaching, evaluation: batch("diagnostic"), transfer: batch("transfer") };
}

/** Validate authored keys independently and bind the entire declared task
 * inventory to the versioned seed. Renaming or reordering cannot hide overlap. */
export function parseSchoolExperiment(raw: unknown, teaching: SchoolCase[], evaluation: SchoolEvaluationCase[], world?: { id: string; revision: string; instructions: string }): SchoolExperimentProtocol {
	const row = object(raw, ["version", "family", "seed", "cold", "memory", "transfer", "disclosure"]);
	if (row.version !== 1 || row.family !== SCHOOL_EXPERIMENT_FAMILY || row.cold !== true || row.disclosure !== "after-completion" || (row.memory !== undefined && row.memory !== true)) invalid("Unsupported experiment protocol");
	const seed = seedOf(row.seed);
	if (!Array.isArray(row.transfer)) invalid("Experiment requires fresh transfer cases");
	if (world && (world.id !== FACTORIZED_WORLD.id || world.revision !== FACTORIZED_WORLD.revision || world.instructions !== FACTORIZED_WORLD.instructions)) invalid("Factorized experiment world definition does not match the checker");
	const generated = generatedFactorizedCases(seed);
	const supplied = { teaching, evaluation, transfer: row.transfer };
	// Check shape against the bounded generated inventory before reading an
	// arbitrary transfer entry. This also refuses private/extension fields.
	for (const group of ["teaching", "evaluation", "transfer"] as const) {
		if (canonical(supplied[group]) !== canonical(generated[group])) invalid(`Experiment ${group} differs from its declared generator revision and seed`);
		for (const item of generated[group]) verifyFactorizedCase(item);
	}
	return { version: 1, family: SCHOOL_EXPERIMENT_FAMILY, seed, cold: true, ...(row.memory === true ? { memory: true as const } : {}), transfer: generated.transfer, disclosure: "after-completion" };
}

export function generateSchoolExperiment(input: {
	seed: number; operationId: string; memory?: boolean;
	learner?: SchoolParticipant; teacher?: SchoolParticipant;
}): SchoolExperimentManifest {
	const { teaching, evaluation, transfer } = generatedFactorizedCases(input.seed);
	const experiment: SchoolExperimentProtocol = { version: 1, family: SCHOOL_EXPERIMENT_FAMILY, seed: input.seed, cold: true, ...(input.memory ? { memory: true as const } : {}), transfer, disclosure: "after-completion" };
	// Every planned call must fit inside the episode limit at its own worst case.
	const episodeTimeoutMs = 600000, callTimeoutMs = Math.min(30000, Math.floor(episodeTimeoutMs / schoolExperimentCallCount(evaluation.length, experiment)));
	return {
		version: 2, operationId: input.operationId,
		class: { classId: "learning-dynamics", revision: "1", unitId: "factorized-step" },
		world: { ...FACTORIZED_WORLD },
		learner: input.learner ?? { id: "local-learner", model: { provider: "custom", id: "REPLACE_WITH_CONFIGURED_LOCAL_MODEL_ID", thinkingLevel: "off" } },
		teacher: input.teacher ?? { id: "teacher", model: { provider: "anthropic", id: "REPLACE_WITH_CONFIGURED_TEACHER_MODEL_ID" } },
		teaching, evaluation,
		limits: { maxOutputTokens: 512, callTimeoutMs, episodeTimeoutMs },
		experiment,
	};
}

export function schoolExperimentCallCount(evaluationCount: number, protocol?: SchoolExperimentProtocol): number {
	if (!Number.isInteger(evaluationCount) || evaluationCount < 2 || evaluationCount > 16) invalid("Evaluation case count must be between 2 and 16");
	return evaluationCount * 2 + 1 + (protocol ? evaluationCount + (protocol.memory ? evaluationCount : 0) + protocol.transfer.length : 0);
}

type ExperimentFields = { evaluation: SchoolEvaluationCase[]; experiment?: SchoolExperimentProtocol };
export function experimentCaseFor(manifest: ExperimentFields, phase: string, caseId: string): SchoolEvaluationCase | undefined {
	return (phase === "transfer" ? manifest.experiment?.transfer : manifest.evaluation)?.find((item) => item.id === caseId);
}

type SummaryCall = { phase: string; caseId?: string; grade?: SchoolGrade };
export function summarizeSchoolExperiment(manifest: ExperimentFields, calls: readonly SummaryCall[]): SchoolExperimentReport {
	const protocol = manifest.experiment;
	if (!protocol) invalid("Cannot summarize an episode without an experiment protocol");
	const baseline = new Map(calls.filter((call) => call.phase === "baseline" && call.grade).map((call) => [call.caseId, call.grade!]));
	const phases = [
		{ phase: "baseline", condition: "baseline", assistance: "none" },
		{ phase: "retry", condition: "assisted", assistance: "lesson" },
		{ phase: "cold", condition: "cold", assistance: "none" },
		...(protocol.memory ? [{ phase: "memory", condition: "memory", assistance: "saved-memory" }] : []),
		{ phase: "transfer", condition: "transfer", assistance: "lesson" },
	] as const;
	const conditions = phases.map(({ phase, condition, assistance }): SchoolExperimentConditionResult => {
		const items = phase === "transfer" ? protocol.transfer : manifest.evaluation;
		const relevant = calls.filter((call) => call.phase === phase);
		if (new Set(relevant.map((call) => call.caseId)).size !== relevant.length || relevant.some((call) => !items.some((item) => item.id === call.caseId))) invalid("Experiment contains duplicate or unknown condition attempts");
		for (const call of relevant) {
			const item = items.find((item) => item.id === call.caseId)!;
			if (call.grade && (call.grade.caseId !== item.id || call.grade.split !== item.split || call.grade.evaluator !== "trimmed-exact-v1" || typeof call.grade.correct !== "boolean")) invalid("Experiment grade does not match its condition case");
		}
		const count = (split: "target" | "retention"): SchoolExperimentCount => {
			const selected = items.filter((item) => item.split === split);
			const graded = selected.flatMap((item) => relevant.filter((call) => call.caseId === item.id && call.grade).map((call) => call.grade!));
			return { expected: selected.length, graded: graded.length, correct: graded.length ? graded.filter((grade) => grade.correct).length : null };
		};
		const target = count("target"), retention = count("retention"), graded = target.graded + retention.graded;
		return {
			condition: condition as SchoolExperimentCondition, assistance: assistance as SchoolExperimentConditionResult["assistance"],
			coverage: graded === 0 ? "ABSENT" : graded === items.length ? "SUFFICIENT" : "INSUFFICIENT", target, retention,
			regressions: phase === "transfer" ? [] : items.filter((item) => baseline.get(item.id)?.correct && relevant.find((call) => call.caseId === item.id)?.grade?.correct === false).map((item) => item.id),
		};
	});
	return { version: 1, family: protocol.family, seed: protocol.seed, conditions, disclosure: "after-completion", transferCondition: "LESSON_ASSISTED_FRESH_PARAMETERS", weightLearning: "NOT_PERFORMED", persistence: "NOT_ESTABLISHED", generalization: "NOT_ESTABLISHED", evidenceScope: "THIS_GENERATOR_AND_SEED" };
}

export interface SchoolExperimentMemoryCheck {
	callId: string;
	memory: { text: string; sourceIds: string[] };
	expectedSha256: string;
}

/** Validate the declared condition against the retained evidence, not merely its
 * phase label. A synchronous store must additionally hash each returned memory
 * object using canonical JSON and compare expectedSha256. This function has no
 * runtime import of episode helpers, so their parser can safely use this module. */
export function validateSchoolExperimentEvidence(record: SchoolEpisodeRecord): { memoryChecks: SchoolExperimentMemoryCheck[] } {
	const memoryChecks: SchoolExperimentMemoryCheck[] = [];
	if (!record.manifest.experiment) return { memoryChecks };
	if (record.version !== 2 || !record.classContext) invalid("Experimental evidence requires its admitted class context");
	const manifest = record.manifest, protocol = parseSchoolExperiment(manifest.experiment, manifest.teaching, manifest.evaluation, manifest.world);
	if (protocol.memory && (!manifest.learner.stateRef || !record.bindings?.learner || !/^[a-f0-9]{64}$/.test(record.bindings.learner.memorySha256))) invalid("Memory evidence requires its pinned learner binding");
	type PlannedCall = { phase: SchoolCallRecord["phase"]; item?: SchoolEvaluationCase };
	const group = (phase: SchoolCallRecord["phase"], items: SchoolEvaluationCase[]): PlannedCall[] => items.map((item) => ({ phase, item }));
	const plan: PlannedCall[] = [
		...group("baseline", manifest.evaluation), { phase: "lesson" }, ...group("retry", manifest.evaluation),
		...group("cold", manifest.evaluation), ...(protocol.memory ? group("memory", manifest.evaluation) : []), ...group("transfer", protocol.transfer),
	];
	if (record.calls.length > plan.length || (record.status === "COMPLETED" && record.calls.length !== plan.length)) invalid("Experimental calls do not cover their declared call plan");
	const problem = (item: SchoolCase) => ({ id: item.id, question: item.question, observations: item.observations.map((entry) => ({ id: entry.id, status: entry.status, ...(entry.content === undefined ? {} : { content: entry.content }) })) });
	const baseline: SchoolGrade[] = [];
	let lesson: string | undefined, memoryIdentity: string | undefined, learnerPrompt: string | undefined;
	for (const [index, call] of record.calls.entries()) {
		const expected = plan[index]!, role = expected.phase === "lesson" ? "teacher" : "learner";
		if (call.id !== `${record.operationId}-${index + 1}` || call.phase !== expected.phase || call.role !== role || call.caseId !== expected.item?.id || canonical(call.participant) !== canonical(manifest[role])) invalid("Experimental call ownership or order differs from its declared plan");
		if (!["REQUESTED", "ADMITTED", "REPLY_RETAINED", "FAILED"].includes(call.state) || (call.completion !== undefined && !["REPLY_RETAINED", "TERMINAL_REPLY_REJECTED", "NO_CALL_ADMITTED", "UNKNOWN"].includes(call.completion))) invalid("Experimental call has an invalid completion state");
		if (call.state === "FAILED" && (index < record.calls.length - 1 || record.status === "COMPLETED")) invalid("Experimental work continued after a failed call");
		if (typeof call.systemPrompt !== "string" || !call.systemPrompt.trim()) invalid("Experimental call has no retained system prompt");
		if (role === "learner") {
			learnerPrompt ??= call.systemPrompt;
			if (call.systemPrompt !== learnerPrompt) invalid("Experimental learner system prompt changed between conditions");
		}
		let expectedView: Record<string, unknown>;
		if (role === "teacher") expectedView = {
			...record.classContext.view, world: { ...manifest.world },
			teachingExamples: manifest.teaching.map((item) => ({ ...problem(item), expected: item.expected })),
			baselineSummary: { target: baseline.filter((grade) => grade.split === "target" && grade.correct).length, retention: baseline.filter((grade) => grade.split === "retention" && grade.correct).length, targetTotal: baseline.filter((grade) => grade.split === "target").length, retentionTotal: baseline.filter((grade) => grade.split === "retention").length },
		};
		else {
			const assisted = expected.phase === "retry" || expected.phase === "transfer";
			if (assisted && lesson === undefined) invalid("Assisted work has no complete retained lesson");
			expectedView = { ...record.classContext.view, world: { ...manifest.world }, problem: problem(expected.item!), ...(assisted ? { lesson } : {}) };
			if (expected.phase === "memory") {
				const view = call.view as Record<string, unknown> | null;
				const snapshot = object(view?.savedMemory, ["text", "sourceIds"]);
				if (typeof snapshot.text !== "string" || !snapshot.text.trim() || new TextEncoder().encode(snapshot.text).byteLength > 16 * 1024 || !Array.isArray(snapshot.sourceIds) || snapshot.sourceIds.length > 64 || snapshot.sourceIds.some((source) => typeof source !== "string" || !source.trim() || source.length > 256) || new Set(snapshot.sourceIds).size !== snapshot.sourceIds.length) invalid("Experimental saved memory is not a bounded explicit snapshot");
				const memory = { text: snapshot.text, sourceIds: [...snapshot.sourceIds] as string[] }, identity = canonical(memory);
				memoryIdentity ??= identity;
				if (memoryIdentity !== identity) invalid("Experimental saved memory changed within its condition");
				expectedView.savedMemory = memory;
				memoryChecks.push({ callId: call.id, memory, expectedSha256: record.bindings!.learner!.memorySha256 });
			}
		}
		if (canonical(call.view) !== canonical(expectedView)) invalid("Experimental call view does not match its declared condition");
		const mustBeComplete = index < record.calls.length - 1 || record.status === "COMPLETED";
		if (call.grade || mustBeComplete) {
			const reply = call.reply;
			if (!reply || reply.role !== "assistant" || reply.stopReason !== "stop" || !Array.isArray(reply.content) || reply.content.some((entry) => !entry || (entry.type !== "text" && entry.type !== "thinking") || (entry.type === "text" && typeof entry.text !== "string")) || call.completion !== "REPLY_RETAINED" || (call.state !== "REPLY_RETAINED" && call.state !== "FAILED")) invalid("Experimental progress lacks a complete retained reply");
			const rawText = reply.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("");
			if (!rawText.trim() || rawText !== call.text) invalid("Experimental retained answer differs from its raw reply");
			if (expected.item) {
				const grade = call.grade;
				if (!grade || grade.caseId !== expected.item.id || grade.split !== expected.item.split || grade.evaluator !== "trimmed-exact-v1" || grade.correct !== (rawText.trim() === expected.item.expected.trim())) invalid("Experimental retained grade differs from its raw answer and key");
			} else if (call.grade || new TextEncoder().encode(rawText).byteLength > 16 * 1024) invalid("Experimental lesson has invalid retained evidence");
		}
		if (expected.phase === "baseline" && call.grade) baseline.push(call.grade);
		if (expected.phase === "lesson" && mustBeComplete) lesson = call.text;
	}
	if (record.experiment && canonical(record.experiment) !== canonical(summarizeSchoolExperiment(manifest, record.calls))) invalid("Experimental report conflicts with its retained grades");
	if (record.status === "COMPLETED" && !record.experiment) invalid("Completed experimental work has no condition report");
	return { memoryChecks };
}

async function sha256(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(canonical(value));
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One receipt per requested view, retained before dispatch. An equal view hash
 * indicates identical prepared bytes, not identical internal state, confirmed
 * provider consumption, or lack of prior exposure. */
export async function schoolExposureForCall(call: Pick<SchoolCallRecord, "id" | "participant" | "role" | "view" | "caseId"> & { phase: string }, sequence: number): Promise<SchoolExposureReceipt> {
	if (!Number.isInteger(sequence) || sequence < 0) invalid("Exposure sequence must be a nonnegative integer");
	const condition = call.phase === "lesson" ? "teaching" : call.phase === "retry" ? "assisted" : call.phase;
	if (!["teaching", "baseline", "assisted", "cold", "memory", "transfer"].includes(condition)) invalid("Unknown exposure condition");
	const view = call.view && typeof call.view === "object" && !Array.isArray(call.view) ? call.view as Record<string, unknown> : {};
	const memory = view.savedMemory ?? view.memory;
	return {
		sequence, callId: call.id, participantId: call.participant.id, role: call.role, condition: condition as SchoolExposureReceipt["condition"], viewSha256: await sha256(call.view), scope: "SCHOOL_SUPPLIED_VIEW", delivery: "NOT_ATTESTED",
		...(call.caseId === undefined ? {} : { caseId: call.caseId }),
		...(view.problem === undefined ? {} : { problemSha256: await sha256(view.problem) }),
		...(view.lesson === undefined ? {} : { lessonSha256: await sha256(view.lesson) }),
		...(memory === undefined ? {} : { memorySha256: await sha256(memory) }),
	};
}
