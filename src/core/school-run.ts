import { parseSchoolEpisode, schoolOperationId, type SchoolEpisodeManifest, type SchoolEpisodeRecord } from "./school-episode.ts";
import { schoolExperimentCallCount } from "./school-experiment.ts";

export type SchoolRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "UNRESOLVED";
export interface SchoolRunRequest {
	manifest: SchoolEpisodeManifest;
	notBefore: string;
	maxCalls: number;
}
export interface SchoolRunRecord extends SchoolRunRequest {
	version: 1;
	operationId: string;
	requestSha256: string;
	evidence: SchoolEpisodeRecord["evidence"];
	status: SchoolRunStatus;
	plannedCalls: number;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	finishedAt?: string;
	cancelRequestedAt?: string;
	uncertaintyAcknowledgement?: { at: string; note: string };
	errorCode?: string;
	retainedCalls?: number;
}
export class SchoolRunError extends Error {
	constructor(public code: string, message: string, public status = 400) { super(message); this.name = "SchoolRunError"; }
}
export function schoolPlannedCalls(manifest: SchoolEpisodeManifest): number {
	return schoolExperimentCallCount(manifest.evaluation.length, manifest.experiment);
}
export function parseSchoolRunRequest(raw: unknown, now = new Date().toISOString()): SchoolRunRequest {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SchoolRunError("INVALID_RUN", "A queued run needs a manifest");
	const row = raw as Record<string, unknown>;
	if (Object.keys(row).some((key) => !["manifest", "notBefore", "maxCalls"].includes(key))) throw new SchoolRunError("INVALID_RUN", "Unknown queued-run field");
	if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 64 * 1024) throw new SchoolRunError("RUN_TOO_LARGE", "Run request exceeds 64 KiB", 413);
	const manifest = parseSchoolEpisode(row.manifest);
	if (manifest.version !== 2) throw new SchoolRunError("CLASS_REQUIRED", "New queued work must identify its class and unit");
	schoolOperationId(manifest.operationId);
	const date = row.notBefore === undefined ? now : row.notBefore;
	const parts = typeof date === "string" && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(date);
	if (!parts) throw new SchoolRunError("INVALID_RUN", "notBefore needs an ISO timestamp with an explicit timezone");
	const local = `${parts[1]}.${(parts[2] ?? "").padEnd(3, "0")}Z`, localTime = Date.parse(local), time = Date.parse(date as string);
	if (!Number.isFinite(localTime) || new Date(localTime).toISOString() !== local || !Number.isFinite(time) || !/^\d{4}-/.test(new Date(time).toISOString())) throw new SchoolRunError("INVALID_RUN", "notBefore is not a valid calendar instant");
	const planned = schoolPlannedCalls(manifest), maxCalls = row.maxCalls === undefined ? planned : row.maxCalls;
	if (typeof maxCalls !== "number" || !Number.isInteger(maxCalls) || maxCalls < planned || maxCalls > 128) throw new SchoolRunError("CALL_BUDGET", "The admitted call budget must cover the planned calls and be at most 128");
	return { manifest, notBefore: new Date(time).toISOString(), maxCalls };
}
/** Owner work list: no prompts, hidden keys, replies, memory or credentials. */
export function schoolRunSummary(run: SchoolRunRecord) {
	return {
		operationId: run.operationId, status: run.status,
		class: run.manifest.version === 2 ? { ...run.manifest.class } : null,
		learnerId: run.manifest.learner.id, teacherId: run.manifest.teacher.id,
		notBefore: run.notBefore, createdAt: run.createdAt, updatedAt: run.updatedAt,
		evidence: run.evidence, plannedCalls: run.plannedCalls, maxCalls: run.maxCalls,
		...(run.cancelRequestedAt ? { cancelRequestedAt: run.cancelRequestedAt } : {}),
		...(run.uncertaintyAcknowledgement ? { uncertaintyAcknowledgedAt: run.uncertaintyAcknowledgement.at } : {}),
		...(run.errorCode ? { errorCode: run.errorCode } : {}),
		...(run.retainedCalls === undefined ? {} : { retainedCalls: run.retainedCalls }),
	};
}
