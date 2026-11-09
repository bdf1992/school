import { parseSchoolEpisode, type SchoolClassDefinition, type SchoolEpisodeManifest, type SchoolModelSpec } from "@/src/core";

export interface ClassroomClassSummary { id: string; revision: string; title: string; sha256: string }
export interface ClassroomParticipantState {
	participantId: string;
	revision: string;
	model: SchoolModelSpec;
	edition?: string;
	connection: { id: string; revision: string };
	memorySha256: string;
	sha256: string;
}
export interface ClassroomRegistry {
	participants: { id: string; label: string; kind: string; sha256: string }[];
	states: ClassroomParticipantState[];
	connections: { id: string; revision: string; label: string; kind: string; revoked: boolean; sha256: string }[];
}
export interface ClassroomRun {
	operationId: string;
	status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "UNRESOLVED";
	class: { classId: string; revision: string; unitId: string; sessionId?: string };
	learnerId: string;
	teacherId: string;
	notBefore: string;
	createdAt: string;
	updatedAt: string;
	evidence: "CONFIGURED_PROVIDER" | "SCRIPTED_FIXTURE";
	plannedCalls: number;
	maxCalls?: number;
	cancelRequestedAt?: string;
	uncertaintyAcknowledgedAt?: string;
	retainedCalls?: number;
	errorCode?: string;
}
export const EMPTY_REGISTRY: ClassroomRegistry = { participants: [], states: [], connections: [] };

/** All requests use the app's same-origin transport. Desktop authentication is
 * attached by the existing desktop session, never copied into browser state. */
export async function classroomRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(path, { cache: "no-store", ...init });
	const body: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
		throw new Error(message);
	}
	if (body === null) throw new Error("The server returned an empty response. Refresh and try again.");
	return body as T;
}
export function classroomPost<T>(path: string, value: unknown): Promise<T> {
	return classroomRequest<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
}
export function classroomError(error: unknown): string { return error instanceof Error ? error.message : "The request could not be completed."; }
export function classChoice(id: string, revision: string): string { return JSON.stringify([id, revision]); }
export function stateChoice(state: Pick<ClassroomParticipantState, "participantId" | "revision">): string { return JSON.stringify([state.participantId, state.revision]); }
export function classQuery(definition: Pick<SchoolClassDefinition, "id" | "revision">): string {
	return new URLSearchParams({ classId: definition.id, revision: definition.revision }).toString();
}
export function evidenceLabel(evidence: "SCRIPTED_FIXTURE" | "CONFIGURED_PROVIDER"): string {
	return evidence === "SCRIPTED_FIXTURE" ? "Scripted fixture" : "Configured provider";
}
export function readableStatus(status: string): string { return status.replaceAll("_", " ").toLowerCase(); }
export async function readClassroomFile(file: File, maxBytes: number): Promise<string> {
	if (file.size > maxBytes) throw new Error(`Choose a JSON file smaller than ${Math.floor(maxBytes / 1024)} KiB.`);
	return file.text();
}

/** Binding changes are explicit selections. Imported case contents and their
 * class/world identities are never silently rewritten by the console. */
export function prepareClassroomEpisode(input: {
	raw: string;
	definition: SchoolClassDefinition;
	unitId: string;
	sessionId: string;
	learnerState?: ClassroomParticipantState;
	teacherState?: ClassroomParticipantState;
}): SchoolEpisodeManifest {
	if (new TextEncoder().encode(input.raw).byteLength > 64 * 1024) throw new Error("The episode definition exceeds 64 KiB.");
	const value: unknown = JSON.parse(input.raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Import an episode JSON object.");
	const candidate = { ...value } as Record<string, unknown>;
	for (const role of ["learner", "teacher"] as const) {
		const state = role === "learner" ? input.learnerState : input.teacherState;
		if (state) candidate[role] = { id: state.participantId, model: state.model, ...(state.edition === undefined ? {} : { edition: state.edition }), stateRef: { revision: state.revision } };
	}
	const manifest = parseSchoolEpisode(candidate);
	if (manifest.version !== 2) throw new Error("Import a version 2 episode with a class reference.");
	if (manifest.class.classId !== input.definition.id || manifest.class.revision !== input.definition.revision) throw new Error("The episode belongs to a different class revision. Select that revision before queueing it.");
	if (manifest.class.unitId !== input.unitId) throw new Error("Select the episode's curriculum unit before queueing it.");
	const unit = input.definition.curriculum.units.find((item) => item.id === input.unitId);
	if (!unit || unit.world.id !== manifest.world.id || unit.world.revision !== manifest.world.revision) throw new Error("The episode world must match the selected curriculum unit.");
	if (input.definition.schedule.mode === "scheduled" && (!input.sessionId || manifest.class.sessionId !== input.sessionId)) throw new Error("Select the episode's scheduled session before queueing it.");
	if (input.definition.schedule.mode === "self-paced" && manifest.class.sessionId !== undefined) throw new Error("A self-paced class does not have scheduled sessions.");
	for (const role of ["learner", "teacher"] as const) {
		if (!input.definition.roster.some((member) => member.participantId === manifest[role].id && member.roles.includes(role))) throw new Error(`The selected ${role} must be enrolled in this class with that role.`);
	}
	return manifest;
}
