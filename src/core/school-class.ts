/** A class keeps a roster, curriculum and study schedule across bounded episodes.
 * Model bindings and private learner work remain outside the class definition. */

export const MAX_SCHOOL_CLASS_BYTES = 64 * 1024;
export interface SchoolClassMember { participantId: string; roles: ("learner" | "teacher")[] }
export interface SchoolCurriculumUnit {
	id: string;
	title: string;
	objectives: string[];
	/** Curriculum dependencies, not a claim that a learner has mastered them. */
	prerequisites: string[];
	world: { id: string; revision: string };
}
export interface SchoolCurriculum { id: string; revision: string; title: string; units: SchoolCurriculumUnit[] }
export interface SchoolClassSession { id: string; unitId: string; startsAt: string; endsAt: string }
export type SchoolClassSchedule = { mode: "self-paced" } | { mode: "scheduled"; sessions: SchoolClassSession[] };
export interface SchoolClassAssessment { evaluator: "trimmed-exact-v1" | "all-cases-pass-and-strict-improvement/v1" | "dataspace-active-camera-v1"; scale: "case-count" }
export interface SchoolClassDefinition {
	version: 1;
	id: string;
	revision: string;
	title: string;
	roster: SchoolClassMember[];
	curriculum: SchoolCurriculum;
	schedule: SchoolClassSchedule;
	assessment: SchoolClassAssessment;
	peerPolicy: { work: "private" };
}
export interface SchoolClassRef { classId: string; revision: string; unitId: string; sessionId?: string }
export interface SchoolClassView {
	class: { id: string; revision: string; title: string };
	curriculum: { id: string; revision: string; title: string };
	unit: SchoolCurriculumUnit;
	schedule: { mode: "self-paced" } | { mode: "scheduled"; session: SchoolClassSession };
	assessment: SchoolClassAssessment;
	peerPolicy: { work: "private" };
}
export interface SchoolClassAdmission {
	reference: SchoolClassRef;
	admittedAt: string;
	/** Owner evidence. Participant projections must use view, never this roster. */
	definition: SchoolClassDefinition;
	view: SchoolClassView;
}
export class SchoolClassError extends Error {
	constructor(public code: string, message: string, public status = 400) { super(message); this.name = "SchoolClassError"; }
}

function invalid(message: string): never { throw new SchoolClassError("INVALID_CLASS", message); }
function object(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${where} must be an object`);
	const row = value as Record<string, unknown>;
	if (Object.keys(row).some((key) => !keys.includes(key))) invalid(`${where} contains an unknown field`);
	return row;
}
function text(value: unknown, where: string, max = 512): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) invalid(`${where} must be nonempty text of at most ${max} characters`);
	return value;
}
export function schoolClassIdentifier(value: unknown, where = "class identifier"): string {
	const id = text(value, where, 80);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) invalid(`${where} must use letters, digits, hyphens or underscores`);
	return id;
}
function array(value: unknown, where: string, min: number, max: number): unknown[] {
	if (!Array.isArray(value) || value.length < min || value.length > max) invalid(`${where} must contain ${min}–${max} entries`);
	return value;
}
function distinct(values: string[], where: string): void {
	if (new Set(values).size !== values.length) invalid(`${where} must be distinct`);
}
function boundedJson(value: unknown): void {
	let encoded: string | undefined;
	try { encoded = JSON.stringify(value); }
	catch { invalid("Class definition must contain JSON values"); }
	if (encoded === undefined) invalid("Class definition must be a JSON object");
	if (new TextEncoder().encode(encoded).byteLength > MAX_SCHOOL_CLASS_BYTES) throw new SchoolClassError("CLASS_TOO_LARGE", "Class definition exceeds 64 KiB", 413);
}
/** Require a timezone and reject calendar rollover before normalizing offsets. */
function instant(value: unknown, where: string): string {
	const input = text(value, where, 40);
	const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(input);
	if (!parts) invalid(`${where} must be an ISO timestamp with an explicit timezone`);
	const local = `${parts[1]}.${(parts[2] ?? "").padEnd(3, "0")}Z`;
	const localTime = Date.parse(local);
	const time = Date.parse(input);
	if (!Number.isFinite(localTime) || new Date(localTime).toISOString() !== local || !Number.isFinite(time)) invalid(`${where} is not a valid instant`);
	const normalized = new Date(time).toISOString();
	if (!/^\d{4}-/.test(normalized)) invalid(`${where} is outside the supported year range`);
	return normalized;
}
function frozen<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) frozen(child);
		Object.freeze(value);
	}
	return value;
}

export function parseSchoolClass(value: unknown): SchoolClassDefinition {
	boundedJson(value);
	const row = object(value, ["version", "id", "revision", "title", "roster", "curriculum", "schedule", "assessment", "peerPolicy"], "class");
	if (row.version !== 1) invalid("Unsupported class version");
	const roster = array(row.roster, "roster", 1, 128).map((value, index): SchoolClassMember => {
		const member = object(value, ["participantId", "roles"], `roster[${index}]`);
		const roles = array(member.roles, "member.roles", 1, 2).map((role) => {
			if (role !== "learner" && role !== "teacher") invalid("Class roles must be learner or teacher");
			return role;
		});
		distinct(roles, "Member roles");
		return { participantId: text(member.participantId, "member.participantId", 128), roles };
	});
	distinct(roster.map((member) => member.participantId), "Roster participant identities");
	if (!roster.some((member) => member.roles.includes("learner")) || !roster.some((member) => member.roles.includes("teacher"))) invalid("A class needs a learner role and a teacher role");
	const curriculumRow = object(row.curriculum, ["id", "revision", "title", "units"], "curriculum");
	const units = array(curriculumRow.units, "curriculum.units", 1, 64).map((value, index): SchoolCurriculumUnit => {
		const unit = object(value, ["id", "title", "objectives", "prerequisites", "world"], `curriculum.units[${index}]`);
		const world = object(unit.world, ["id", "revision"], "unit.world");
		const prerequisites = array(unit.prerequisites, "unit.prerequisites", 0, 63).map((value) => schoolClassIdentifier(value, "prerequisite"));
		distinct(prerequisites, "Unit prerequisites");
		return {
			id: schoolClassIdentifier(unit.id, "unit.id"), title: text(unit.title, "unit.title"),
			objectives: array(unit.objectives, "unit.objectives", 1, 16).map((value) => text(value, "objective", 2048)), prerequisites,
			world: { id: text(world.id, "unit.world.id", 128), revision: text(world.revision, "unit.world.revision", 128) },
		};
	});
	distinct(units.map((unit) => unit.id), "Curriculum unit identities");
	const byId = new Map(units.map((unit) => [unit.id, unit]));
	const visiting = new Set<string>(), visited = new Set<string>();
	function visit(unit: SchoolCurriculumUnit): void {
		if (visiting.has(unit.id)) invalid("Curriculum prerequisites contain a cycle");
		if (visited.has(unit.id)) return;
		visiting.add(unit.id);
		for (const id of unit.prerequisites) {
			const prerequisite = byId.get(id);
			if (!prerequisite) invalid(`Unknown curriculum prerequisite: ${id}`);
			visit(prerequisite);
		}
		visiting.delete(unit.id); visited.add(unit.id);
	}
	for (const unit of units) visit(unit);
	const curriculum: SchoolCurriculum = { id: schoolClassIdentifier(curriculumRow.id, "curriculum.id"), revision: schoolClassIdentifier(curriculumRow.revision, "curriculum.revision"), title: text(curriculumRow.title, "curriculum.title"), units };
	const scheduleRow = object(row.schedule, ["mode", "sessions"], "schedule");
	let schedule: SchoolClassSchedule;
	if (scheduleRow.mode === "self-paced") {
		if ("sessions" in scheduleRow) invalid("A self-paced schedule cannot contain dated sessions");
		schedule = { mode: "self-paced" };
	} else if (scheduleRow.mode === "scheduled") {
		const sessions = array(scheduleRow.sessions, "schedule.sessions", 1, 128).map((value, index): SchoolClassSession => {
			const session = object(value, ["id", "unitId", "startsAt", "endsAt"], `schedule.sessions[${index}]`);
			const unitId = schoolClassIdentifier(session.unitId, "session.unitId");
			if (!byId.has(unitId)) invalid(`Unknown session unit: ${unitId}`);
			const startsAt = instant(session.startsAt, "session.startsAt"), endsAt = instant(session.endsAt, "session.endsAt");
			if (startsAt >= endsAt) invalid("A session must end after it starts");
			return { id: schoolClassIdentifier(session.id, "session.id"), unitId, startsAt, endsAt };
		});
		distinct(sessions.map((session) => session.id), "Session identities");
		schedule = { mode: "scheduled", sessions };
	} else invalid("Schedule mode must be self-paced or scheduled");
	const assessment = object(row.assessment, ["evaluator", "scale"], "assessment");
	const evaluator = assessment.evaluator;
	if ((evaluator !== "trimmed-exact-v1" && evaluator !== "all-cases-pass-and-strict-improvement/v1" && evaluator !== "dataspace-active-camera-v1") || assessment.scale !== "case-count") invalid("Unknown assessment evaluator or scale");
	const peerPolicy = object(row.peerPolicy, ["work"], "peerPolicy");
	if (peerPolicy.work !== "private") invalid("This runner requires private peer work");
	const definition: SchoolClassDefinition = { version: 1, id: schoolClassIdentifier(row.id, "class.id"), revision: schoolClassIdentifier(row.revision, "class.revision"), title: text(row.title, "class.title"), roster, curriculum, schedule, assessment: { evaluator, scale: "case-count" }, peerPolicy: { work: "private" } };
	boundedJson(definition);
	return frozen(definition);
}

export function parseSchoolClassRef(value: unknown): SchoolClassRef {
	const row = object(value, ["classId", "revision", "unitId", "sessionId"], "class reference");
	return frozen({ classId: schoolClassIdentifier(row.classId, "class reference.classId"), revision: schoolClassIdentifier(row.revision, "class reference.revision"), unitId: schoolClassIdentifier(row.unitId, "class reference.unitId"), ...(row.sessionId === undefined ? {} : { sessionId: schoolClassIdentifier(row.sessionId, "class reference.sessionId") }) });
}

/** Admission is checked once at episode start. A session ending does not cancel
 * an admitted episode; its own deadlines and live provider permissions apply. */
export function admitSchoolClassEpisode(definition: SchoolClassDefinition, reference: SchoolClassRef, input: { learnerId: string; teacherId: string; world: { id: string; revision: string }; now: string | number | Date }): SchoolClassAdmission {
	const def = parseSchoolClass(definition), ref = parseSchoolClassRef(reference);
	if (def.id !== ref.classId || def.revision !== ref.revision) throw new SchoolClassError("CLASS_MISMATCH", "Class reference does not match the loaded revision", 409);
	for (const [role, participantId] of [["learner", input.learnerId], ["teacher", input.teacherId]] as const) {
		const member = def.roster.find((member) => member.participantId === participantId);
		if (!member) throw new SchoolClassError("CLASS_PARTICIPANT_NOT_ENROLLED", `The ${role} is not enrolled in this class revision`, 403);
		if (!member.roles.includes(role)) throw new SchoolClassError("CLASS_ROLE_REQUIRED", `The participant does not hold the ${role} role in this class revision`, 403);
	}
	const unit = def.curriculum.units.find((unit) => unit.id === ref.unitId);
	if (!unit) throw new SchoolClassError("CLASS_UNIT_NOT_FOUND", "The curriculum unit does not exist in this class revision", 404);
	if (unit.world.id !== input.world.id || unit.world.revision !== input.world.revision) throw new SchoolClassError("CLASS_WORLD_MISMATCH", "The episode world does not match the curriculum unit's world revision", 409);
	const time = typeof input.now === "string" ? Date.parse(instant(input.now, "admission.now")) : input.now instanceof Date ? input.now.getTime() : input.now;
	if (!Number.isFinite(time) || !Number.isFinite(new Date(time).getTime())) invalid("admission.now must be a valid instant");
	// Date and numeric clocks must produce an instant the persisted string
	// parser can read again, including its explicit supported-year range.
	const admittedAt = instant(new Date(time).toISOString(), "admission.now");
	let schedule: SchoolClassView["schedule"];
	if (def.schedule.mode === "self-paced") {
		if (ref.sessionId !== undefined) throw new SchoolClassError("CLASS_SESSION_UNEXPECTED", "A self-paced class does not admit dated session references");
		schedule = { mode: "self-paced" };
	} else {
		if (!ref.sessionId) throw new SchoolClassError("CLASS_SESSION_REQUIRED", "Select a dated session for this class");
		const session = def.schedule.sessions.find((session) => session.id === ref.sessionId);
		if (!session) throw new SchoolClassError("CLASS_SESSION_NOT_FOUND", "The dated session does not exist in this class revision", 404);
		if (session.unitId !== unit.id) throw new SchoolClassError("CLASS_SESSION_MISMATCH", "The dated session belongs to a different curriculum unit", 409);
		if (time < Date.parse(session.startsAt) || time >= Date.parse(session.endsAt)) throw new SchoolClassError("CLASS_SESSION_CLOSED", "The episode must start within the selected session window", 409);
		schedule = { mode: "scheduled", session };
	}
	const view: SchoolClassView = {
		class: { id: def.id, revision: def.revision, title: def.title },
		curriculum: { id: def.curriculum.id, revision: def.curriculum.revision, title: def.curriculum.title },
		unit, schedule, assessment: def.assessment, peerPolicy: def.peerPolicy,
	};
	return frozen({ reference: ref, admittedAt, definition: def, view });
}
