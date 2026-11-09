/** Owner-side gradebook projection. Records stay authoritative; this view neither
 * fills missing grades nor exposes participant prompts, replies or private work. */
import { admitSchoolClassEpisode, parseSchoolClass, SchoolClassError, type SchoolClassDefinition, type SchoolClassRef } from "./school-class.ts";
import { compareSchoolGrades, type SchoolCallRecord, type SchoolComparison, type SchoolEpisodeRecord, type SchoolEvaluationCase, type SchoolGrade, type SchoolModelSpec, type SchoolPhase } from "./school-episode.ts";
import { summarizeSchoolExperiment, validateSchoolExperimentEvidence, type SchoolExperimentReport } from "./school-experiment.ts";
import type { SchoolStateRef } from "./school-participants.ts";

export interface SchoolGradeCount { expected: number; graded: number; correct: number | null }
export interface SchoolGradebookCase {
	caseId: string;
	split: "target" | "retention";
	callId: string | null;
	state: SchoolCallRecord["state"] | "NOT_ATTEMPTED";
	completion: SchoolCallRecord["completion"] | null;
	grade: SchoolGrade | null;
}
export interface SchoolGradebookPhase {
	counts: { target: SchoolGradeCount; retention: SchoolGradeCount };
	cases: SchoolGradebookCase[];
}
export interface SchoolGradebookEpisode {
	operationId: string;
	class: SchoolClassRef;
	learner: { id: string; model: SchoolModelSpec; edition: string | null; stateRef?: SchoolStateRef };
	teacherId: string;
	evidence: SchoolEpisodeRecord["evidence"];
	status: SchoolEpisodeRecord["status"];
	createdAt: string;
	updatedAt: string;
	baseline: SchoolGradebookPhase;
	retry: SchoolGradebookPhase;
	comparison: SchoolComparison | null;
	experiment?: SchoolExperimentReport;
}
export interface SchoolGradebook {
	class: { id: string; revision: string; title: string };
	curriculum: { id: string; revision: string; title: string; units: { id: string; title: string }[] };
	assessment: SchoolClassDefinition["assessment"];
	learners: { participantId: string; status: "NO_EPISODES" | "EPISODES"; episodes: SchoolGradebookEpisode[] }[];
}

function corrupt(message: string): never { throw new SchoolClassError("GRADEBOOK_RECORD_CONFLICT", message, 409); }
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	const encoded = JSON.stringify(value);
	if (encoded === undefined) corrupt("Gradebook input contains a non-JSON value");
	return encoded;
}

/** Checking a retained grade does not create a missing one. A completion label
 * alone is insufficient: the saved raw reply, extracted answer and key must
 * support it. A later bookkeeping failure may leave a valid grade intact. */
function verifyRetainedGrade(record: SchoolEpisodeRecord, call: SchoolCallRecord, expected: SchoolEvaluationCase): void {
	if (!call.grade) return;
	const reply = call.reply;
	if ((call.state !== "REPLY_RETAINED" && call.state !== "FAILED") || call.completion !== "REPLY_RETAINED" || !reply || reply.role !== "assistant" || reply.stopReason !== "stop" || !Array.isArray(reply.content) || typeof call.text !== "string") corrupt(`Episode ${record.operationId} has invalid retained grade evidence`);
	if (reply.content.some((part) => !part || (part.type !== "text" && part.type !== "thinking") || (part.type === "text" && typeof part.text !== "string"))) corrupt(`Episode ${record.operationId} has invalid retained grade evidence`);
	const rawText = reply.content.filter((part) => part.type === "text").map((part) => part.text).join("");
	if (!rawText.trim() || rawText !== call.text || call.grade.correct !== (rawText.trim() === expected.expected.trim())) corrupt(`Episode ${record.operationId} has conflicting retained grade evidence`);
}

function phaseGrades(record: SchoolEpisodeRecord, phase: Exclude<SchoolPhase, "lesson">): SchoolGradebookPhase {
	const byCase = new Map<string, SchoolCallRecord>();
	const evaluation = phase === "transfer" ? record.manifest.experiment?.transfer ?? [] : record.manifest.evaluation;
	for (const call of record.calls) {
		if (call.phase !== phase) continue;
		if (!["REQUESTED", "ADMITTED", "REPLY_RETAINED", "FAILED"].includes(call.state) || (call.completion !== undefined && !["REPLY_RETAINED", "TERMINAL_REPLY_REJECTED", "NO_CALL_ADMITTED", "UNKNOWN"].includes(call.completion))) corrupt(`Episode ${record.operationId} has an invalid attempt state`);
		const expected = evaluation.find((item) => item.id === call.caseId);
		if (!expected || byCase.has(expected.id) || call.role !== "learner" || canonical(call.participant) !== canonical(record.manifest.learner)) corrupt(`Episode ${record.operationId} has conflicting ${phase} case ownership`);
		if (call.grade && (call.completion !== "REPLY_RETAINED" || call.grade.caseId !== expected.id || call.grade.split !== expected.split || call.grade.evaluator !== "trimmed-exact-v1" || typeof call.grade.correct !== "boolean")) corrupt(`Episode ${record.operationId} has an invalid retained grade`);
		verifyRetainedGrade(record, call, expected);
		byCase.set(expected.id, call);
	}
	const cases = evaluation.map((item): SchoolGradebookCase => {
		const call = byCase.get(item.id);
		return {
			caseId: item.id, split: item.split, callId: call?.id ?? null,
			state: call?.state ?? "NOT_ATTEMPTED", completion: call?.completion ?? null,
			grade: call?.grade ? { caseId: item.id, split: item.split, correct: call.grade.correct, evaluator: call.grade.evaluator } : null,
		};
	});
	const counts = (split: SchoolEvaluationCase["split"]): SchoolGradeCount => {
		const selected = cases.filter((item) => item.split === split);
		const graded = selected.filter((item) => item.grade !== null);
		return { expected: selected.length, graded: graded.length, correct: graded.length ? graded.filter((item) => item.grade!.correct).length : null };
	};
	return { counts: { target: counts("target"), retention: counts("retention") }, cases };
}

/** Select one immutable class revision. Unclassified historical v1 evidence is
 * deliberately excluded; it cannot be assigned to a class after the fact. */
export function schoolGradebook(rawDefinition: SchoolClassDefinition, records: readonly SchoolEpisodeRecord[]): SchoolGradebook {
	const definition = parseSchoolClass(rawDefinition);
	const learners: SchoolGradebook["learners"] = definition.roster.filter((member) => member.roles.includes("learner")).map((member) => ({ participantId: member.participantId, status: "NO_EPISODES", episodes: [] }));
	const seen = new Set<string>();
	for (const record of records) {
		if (record.version === 1 && record.manifest.version === 1) continue;
		if (record.version !== 2 || record.manifest.version !== 2) corrupt(`Episode ${record.operationId} has conflicting record versions`);
		const reference = record.manifest.class;
		if (!reference) corrupt(`Episode ${record.operationId} has no class reference`);
		if (reference.classId !== definition.id || reference.revision !== definition.revision) continue;
		if (seen.has(record.operationId)) corrupt(`Episode ${record.operationId} appears more than once`);
		seen.add(record.operationId);
		const context = record.classContext;
		if (!context || canonical(context.reference) !== canonical(reference) || canonical(parseSchoolClass(context.definition)) !== canonical(definition)) corrupt(`Episode ${record.operationId} does not match this class revision`);
		const admission = admitSchoolClassEpisode(definition, reference, { learnerId: record.manifest.learner.id, teacherId: record.manifest.teacher.id, world: record.manifest.world, now: context.admittedAt });
		if (canonical(admission.view) !== canonical(context.view)) corrupt(`Episode ${record.operationId} has conflicting class context`);
		const learner = learners.find((member) => member.participantId === record.manifest.learner.id)!;
		const baseline = phaseGrades(record, "baseline"), retry = phaseGrades(record, "retry");
		let experiment: SchoolExperimentReport | undefined;
		if (record.manifest.experiment) {
			try { validateSchoolExperimentEvidence(record); }
			catch { corrupt(`Episode ${record.operationId} has conflicting experiment conditions`); }
			for (const phase of ["cold", "transfer", ...(record.manifest.experiment.memory ? ["memory"] : [])] as Exclude<SchoolPhase, "lesson">[]) phaseGrades(record, phase);
			if (!record.manifest.experiment.memory && record.calls.some((call) => call.phase === "memory")) corrupt(`Episode ${record.operationId} contains an undeclared memory condition`);
			experiment = summarizeSchoolExperiment(record.manifest, record.calls);
			if (record.experiment && canonical(record.experiment) !== canonical(experiment)) corrupt(`Episode ${record.operationId} has conflicting experiment evidence`);
		} else if (record.experiment || record.calls.some((call) => ["cold", "memory", "transfer"].includes(call.phase))) corrupt(`Episode ${record.operationId} contains undeclared experiment work`);
		let comparison: SchoolComparison | null = null;
		if (record.comparison) {
			if ([...baseline.cases, ...retry.cases].some((item) => item.grade === null)) corrupt(`Episode ${record.operationId} compares incomplete grades`);
			const derived = compareSchoolGrades(baseline.cases.map((item) => item.grade!), retry.cases.map((item) => item.grade!));
			if (canonical(derived) !== canonical(record.comparison)) corrupt(`Episode ${record.operationId} has a conflicting comparison`);
			comparison = derived;
		}
		const participant = record.manifest.learner;
		learner.status = "EPISODES";
		learner.episodes.push({
			operationId: record.operationId,
			class: { classId: reference.classId, revision: reference.revision, unitId: reference.unitId, ...(reference.sessionId === undefined ? {} : { sessionId: reference.sessionId }) },
			learner: { id: participant.id, model: { provider: participant.model.provider, id: participant.model.id, ...(participant.model.thinkingLevel === undefined ? {} : { thinkingLevel: participant.model.thinkingLevel }) }, edition: participant.edition ?? null, ...(participant.stateRef ? { stateRef: { ...participant.stateRef } } : {}) },
			teacherId: record.manifest.teacher.id, evidence: record.evidence, status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
			baseline, retry, comparison, ...(experiment ? { experiment } : {}),
		});
	}
	for (const learner of learners) learner.episodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.operationId.localeCompare(b.operationId));
	return {
		class: { id: definition.id, revision: definition.revision, title: definition.title },
		curriculum: { id: definition.curriculum.id, revision: definition.curriculum.revision, title: definition.curriculum.title, units: definition.curriculum.units.map((unit) => ({ id: unit.id, title: unit.title })) },
		assessment: { evaluator: definition.assessment.evaluator, scale: definition.assessment.scale }, learners,
	};
}
