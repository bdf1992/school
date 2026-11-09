/** A bounded contextual teaching episode. This contract does not authorize training. */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { parseSchoolClassRef, type SchoolClassAdmission, type SchoolClassRef } from "./school-class.ts";

export interface SchoolModelSpec { provider: string; id: string; thinkingLevel?: ThinkingLevel }
export interface SchoolParticipant { id: string; model: SchoolModelSpec; edition?: string }
export interface SchoolObservation {
	id: string;
	status: "ABSENT" | "INSUFFICIENT" | "SUFFICIENT";
	content?: string;
}
export interface SchoolCase {
	id: string;
	question: string;
	observations: SchoolObservation[];
	expected: string;
}
export interface SchoolEvaluationCase extends SchoolCase { split: "target" | "retention" }
interface SchoolEpisodeFields {
	operationId: string;
	world: { id: string; revision: string; subject: string; instructions: string };
	learner: SchoolParticipant;
	teacher: SchoolParticipant;
	teaching: SchoolCase[];
	evaluation: SchoolEvaluationCase[];
	limits: { maxOutputTokens: number; callTimeoutMs: number; episodeTimeoutMs: number };
}
/** Version 1 is retained for historical evidence/replay. New work uses version 2. */
export type SchoolEpisodeManifest = SchoolEpisodeFields & (
	{ version: 1; class?: never } | { version: 2; class: SchoolClassRef }
);
export interface SchoolEpisodeClassContext extends SchoolClassAdmission { definitionSha256: string }
export type SchoolPhase = "baseline" | "lesson" | "retry";
export interface SchoolGrade { caseId: string; split: "target" | "retention"; correct: boolean; evaluator: "trimmed-exact-v1" }
export interface SchoolComparison {
	baseline: { target: number; retention: number };
	retry: { target: number; retention: number };
	total: { target: number; retention: number };
	regressedCases: string[];
	outcome: "CONTEXTUAL_GAIN" | "REGRESSION" | "NO_MEASURED_GAIN";
	weightLearning: "NOT_PERFORMED";
	adoption: "NOT_REQUESTED";
	generalization: "NOT_ESTABLISHED";
}
export interface SchoolCallRecord {
	id: string;
	phase: SchoolPhase;
	role: "learner" | "teacher";
	caseId?: string;
	participant: SchoolParticipant;
	systemPrompt: string;
	view: unknown;
	state: "REQUESTED" | "ADMITTED" | "REPLY_RETAINED" | "FAILED";
	resolvedModel?: { provider: string; id: string; api: string; thinkingLevel?: ThinkingLevel };
	reply?: AssistantMessage;
	rejectedReply?: { bytes: number; sha256: string; provider: string; model: string; stopReason: string };
	text?: string;
	grade?: SchoolGrade;
	error?: string;
	/** No terminal reply means provider completion/billing is unknown. */
	completion?: "REPLY_RETAINED" | "TERMINAL_REPLY_REJECTED" | "NO_CALL_ADMITTED" | "UNKNOWN";
}
interface SchoolEpisodeRecordFields {
	operationId: string;
	manifestSha256: string;
	evidence: "CONFIGURED_PROVIDER" | "SCRIPTED_FIXTURE";
	status: "RUNNING" | "COMPLETED" | "FAILED";
	createdAt: string;
	updatedAt: string;
	calls: SchoolCallRecord[];
	events: { sequence: number; kind: string; at: string; callId?: string }[];
	comparison?: SchoolComparison;
	error?: string;
}
export type SchoolEpisodeRecord = SchoolEpisodeRecordFields & (
	{ version: 1; manifest: Extract<SchoolEpisodeManifest, { version: 1 }>; classContext?: never } |
	{ version: 2; manifest: Extract<SchoolEpisodeManifest, { version: 2 }>; classContext: SchoolEpisodeClassContext }
);
export class SchoolEpisodeError extends Error {
	constructor(public code: string, message: string, public status = 400) { super(message); this.name = "SchoolEpisodeError"; }
}

function object(value: unknown, keys: string[], where: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new SchoolEpisodeError("INVALID_MANIFEST", `${where} must be an object`);
	const row = value as Record<string, unknown>;
	if (Object.keys(row).some((key) => !keys.includes(key))) throw new SchoolEpisodeError("INVALID_MANIFEST", `${where} contains an unknown field`);
	return row;
}
function text(value: unknown, where: string, max = 4096): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new SchoolEpisodeError("INVALID_MANIFEST", `${where} must be nonempty text of at most ${max} characters`);
	return value;
}
function bounded(value: unknown, fallback: number, min: number, max: number, where: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new SchoolEpisodeError("INVALID_MANIFEST", `${where} must be an integer from ${min} to ${max}`);
	return value;
}
export function schoolOperationId(value: unknown): string {
	const id = text(value, "operationId", 80);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new SchoolEpisodeError("INVALID_MANIFEST", "operationId must use letters, digits, hyphens or underscores");
	return id;
}
function participant(value: unknown, where: string): SchoolParticipant {
	const row = object(value, ["id", "model", "edition"], where);
	const model = object(row.model, ["provider", "id", "thinkingLevel"], `${where}.model`);
	const thinking = model.thinkingLevel;
	if (thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(thinking))) throw new SchoolEpisodeError("INVALID_MANIFEST", `${where}.model.thinkingLevel is invalid`);
	return { id: text(row.id, `${where}.id`, 128), model: { provider: text(model.provider, `${where}.model.provider`, 128), id: text(model.id, `${where}.model.id`, 256), ...(thinking === undefined ? {} : { thinkingLevel: thinking as ThinkingLevel }) }, ...(row.edition === undefined ? {} : { edition: text(row.edition, `${where}.edition`, 256) }) };
}
function caseOf(value: unknown, where: string, evaluation: boolean): SchoolCase | SchoolEvaluationCase {
	const row = object(value, ["id", "question", "observations", "expected", ...(evaluation ? ["split"] : [])], where);
	if (!Array.isArray(row.observations) || row.observations.length > 8) throw new SchoolEpisodeError("INVALID_MANIFEST", `${where}.observations must contain at most 8 entries`);
	const observations = row.observations.map((value, index) => {
		const item = object(value, ["id", "status", "content"], `${where}.observations[${index}]`);
		if (!["ABSENT", "INSUFFICIENT", "SUFFICIENT"].includes(String(item.status))) throw new SchoolEpisodeError("INVALID_MANIFEST", "Observation status must be explicit");
		if (item.status === "ABSENT" && item.content !== undefined) throw new SchoolEpisodeError("INVALID_MANIFEST", "An ABSENT observation cannot contain data");
		return { id: text(item.id, "observation.id", 128), status: item.status as SchoolObservation["status"], ...(item.status === "ABSENT" ? {} : { content: text(item.content, "observation.content") }) };
	});
	if (new Set(observations.map((o) => o.id)).size !== observations.length) throw new SchoolEpisodeError("INVALID_MANIFEST", "Observation identities must be distinct within a case");
	const result = { id: text(row.id, `${where}.id`, 128), question: text(row.question, `${where}.question`), observations, expected: text(row.expected, `${where}.expected`) };
	if (!evaluation) return result;
	if (row.split !== "target" && row.split !== "retention") throw new SchoolEpisodeError("INVALID_MANIFEST", "Evaluation cases need a target or retention split");
	return { ...result, split: row.split };
}

export function parseSchoolEpisode(value: unknown): SchoolEpisodeManifest {
	const row = object(value, ["version", "operationId", "class", "world", "learner", "teacher", "teaching", "evaluation", "limits"], "episode");
	if (row.version !== 1 && row.version !== 2) throw new SchoolEpisodeError("INVALID_MANIFEST", "Unsupported episode version");
	if (row.version === 1 && "class" in row) throw new SchoolEpisodeError("INVALID_MANIFEST", "A class reference requires episode version 2");
	const world = object(row.world, ["id", "revision", "subject", "instructions"], "world");
	if (!Array.isArray(row.teaching) || row.teaching.length < 1 || row.teaching.length > 8) throw new SchoolEpisodeError("INVALID_MANIFEST", "Provide 1–8 teaching examples");
	if (!Array.isArray(row.evaluation) || row.evaluation.length < 2 || row.evaluation.length > 16) throw new SchoolEpisodeError("INVALID_MANIFEST", "Provide 2–16 evaluation cases");
	const teaching = row.teaching.map((item, i) => caseOf(item, `teaching[${i}]`, false) as SchoolCase);
	const evaluation = row.evaluation.map((item, i) => caseOf(item, `evaluation[${i}]`, true) as SchoolEvaluationCase);
	const all = [...teaching, ...evaluation];
	if (new Set(all.map((item) => item.id)).size !== all.length) throw new SchoolEpisodeError("INVALID_MANIFEST", "Case identities must be distinct across teaching and evaluation");
	if (!evaluation.some((item) => item.split === "target") || !evaluation.some((item) => item.split === "retention")) throw new SchoolEpisodeError("INVALID_MANIFEST", "Both target and retention cases are required");
	// Observation IDs label evidence, not problem identity. Reordering or renaming
	// them must not turn a teaching example into a held-out evaluation case.
	const problemKey = (item: SchoolCase) => JSON.stringify([item.question.trim(), item.observations.map((o) => JSON.stringify([o.status, o.content?.trim()])).sort()]);
	if (teaching.some((example) => evaluation.some((item) => problemKey(example) === problemKey(item)))) throw new SchoolEpisodeError("INVALID_MANIFEST", "An evaluation problem cannot also be a teaching example");
	const limits = object(row.limits ?? {}, ["maxOutputTokens", "callTimeoutMs", "episodeTimeoutMs"], "limits");
	const fields: SchoolEpisodeFields = {
		operationId: schoolOperationId(row.operationId),
		world: { id: text(world.id, "world.id", 128), revision: text(world.revision, "world.revision", 128), subject: text(world.subject, "world.subject", 512), instructions: text(world.instructions, "world.instructions") },
		learner: participant(row.learner, "learner"), teacher: participant(row.teacher, "teacher"), teaching, evaluation,
		limits: { maxOutputTokens: bounded(limits.maxOutputTokens, 512, 1, 4096, "maxOutputTokens"), callTimeoutMs: bounded(limits.callTimeoutMs, 30000, 10, 120000, "callTimeoutMs"), episodeTimeoutMs: bounded(limits.episodeTimeoutMs, 180000, 10, 600000, "episodeTimeoutMs") },
	};
	return row.version === 2 ? { version: 2, class: parseSchoolClassRef(row.class), ...fields } : { version: 1, ...fields };
}

/** Construct projections from named fields; never serialize a stored lesson transcript. */
export function schoolLearnerView(manifest: SchoolEpisodeManifest, item: SchoolCase, lesson?: string) {
	return { world: { ...manifest.world }, problem: { id: item.id, question: item.question, observations: item.observations.map((o) => ({ id: o.id, status: o.status, ...(o.content === undefined ? {} : { content: o.content }) })) }, ...(lesson === undefined ? {} : { lesson }) };
}
export function schoolTeacherView(manifest: SchoolEpisodeManifest, baseline: SchoolGrade[]) {
	return { world: { ...manifest.world }, teachingExamples: manifest.teaching.map((item) => ({ ...schoolLearnerView(manifest, item).problem, expected: item.expected })), baselineSummary: { target: baseline.filter((g) => g.split === "target" && g.correct).length, retention: baseline.filter((g) => g.split === "retention" && g.correct).length, targetTotal: baseline.filter((g) => g.split === "target").length, retentionTotal: baseline.filter((g) => g.split === "retention").length } };
}
export function gradeSchoolReply(item: SchoolEvaluationCase, reply: string): SchoolGrade {
	return { caseId: item.id, split: item.split, correct: reply.trim() === item.expected.trim(), evaluator: "trimmed-exact-v1" };
}
export function compareSchoolGrades(baseline: SchoolGrade[], retry: SchoolGrade[]): SchoolComparison {
	const counts = (rows: SchoolGrade[]) => ({ target: rows.filter((g) => g.split === "target" && g.correct).length, retention: rows.filter((g) => g.split === "retention" && g.correct).length });
	const before = counts(baseline), after = counts(retry);
	const regressedCases = baseline.filter((g) => g.correct && retry.find((r) => r.caseId === g.caseId)?.correct !== true).map((g) => g.caseId);
	return { baseline: before, retry: after, total: { target: baseline.filter((g) => g.split === "target").length, retention: baseline.filter((g) => g.split === "retention").length }, regressedCases, outcome: regressedCases.length ? "REGRESSION" : after.target > before.target ? "CONTEXTUAL_GAIN" : "NO_MEASURED_GAIN", weightLearning: "NOT_PERFORMED", adoption: "NOT_REQUESTED", generalization: "NOT_ESTABLISHED" };
}
