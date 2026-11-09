/** One durable owner per operation directory; completed records are immutable. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { schoolOperationId, SchoolEpisodeError, type SchoolEpisodeManifest, type SchoolEpisodeRecord } from "../core/school-episode.ts";
import { admitSchoolClassEpisode } from "../core/school-class.ts";
import { schoolClassSha256 } from "./school-classes.ts";
import { validateSchoolExperimentEvidence } from "../core/school-experiment.ts";

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new SchoolEpisodeError("INVALID_MANIFEST", "Manifest contains a non-JSON value");
	return encoded;
}
export function schoolManifestSha256(manifest: SchoolEpisodeManifest): string { return createHash("sha256").update(canonical(manifest)).digest("hex"); }

function validParticipantEvidence(record: SchoolEpisodeRecord): void {
	for (const role of ["learner", "teacher"] as const) {
		const participant = record.manifest[role], binding = record.bindings?.[role];
		if (Boolean(participant.stateRef) !== Boolean(binding)) throw new Error("Missing participant binding");
		if (!binding) continue;
		if (binding.participantId !== participant.id || binding.stateRef.revision !== participant.stateRef!.revision || binding.modelIdentity !== "OWNER_DECLARED" || [binding.participantSha256, binding.stateSha256, binding.connectionSha256, binding.memorySha256].some((hash) => !/^[a-f0-9]{64}$/.test(hash))) throw new Error("Invalid participant binding");
	}
	for (const call of record.calls) {
		if (call.runtime && (canonical(call.runtime.participant) !== canonical(record.bindings?.[call.role] ?? null) || call.runtime.loadedArtifact !== "NOT_ATTESTED" || !/^[a-f0-9]{64}$/.test(call.runtime.configurationSha256))) throw new Error("Runtime binding changed");
		if (record.bindings?.[call.role] && call.state !== "REQUESTED" && call.completion !== "NO_CALL_ADMITTED" && !call.runtime) throw new Error("Admitted participant has no runtime receipt");
	}
	if (record.manifest.experiment) {
		const checks = validateSchoolExperimentEvidence(record);
		for (const check of checks.memoryChecks) if (createHash("sha256").update(canonical(check.memory)).digest("hex") !== check.expectedSha256) throw new Error("Saved memory differs from its admitted state");
		if (!Array.isArray(record.exposures) || record.exposures.length !== record.calls.length) throw new Error("Missing exposure receipts");
		const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
		for (const [index, call] of record.calls.entries()) {
			const receipt = record.exposures[index]!, view = call.view as Record<string, unknown>;
			const condition = call.phase === "lesson" ? "teaching" : call.phase === "retry" ? "assisted" : call.phase;
			if (receipt.sequence !== index || receipt.callId !== call.id || receipt.participantId !== call.participant.id || receipt.role !== call.role || receipt.condition !== condition || receipt.caseId !== call.caseId || receipt.viewSha256 !== hash(call.view) || receipt.scope !== "SCHOOL_SUPPLIED_VIEW" || receipt.delivery !== "NOT_ATTESTED") throw new Error("Exposure receipt does not match its retained view");
			for (const [field, value] of [["problemSha256", view.problem], ["lessonSha256", view.lesson], ["memorySha256", view.savedMemory ?? view.memory]] as const) if (receipt[field] !== (value === undefined ? undefined : hash(value))) throw new Error("Exposure content changed");
		}
	} else if (record.exposures !== undefined) throw new Error("Undeclared exposure protocol");
}

function validClassContext(record: SchoolEpisodeRecord): void {
	if (record.version === 1) {
		if (record.manifest.version !== 1 || record.classContext !== undefined) throw new Error("Invalid historical class context");
		return;
	}
	if (record.version !== 2 || record.manifest.version !== 2 || !record.classContext) throw new Error("A current episode requires its admitted class");
	const context = record.classContext;
	if (context.definitionSha256 !== schoolClassSha256(context.definition) || canonical(context.reference) !== canonical(record.manifest.class) || context.admittedAt !== record.createdAt) throw new Error("Class admission identity changed");
	const admitted = admitSchoolClassEpisode(context.definition, record.manifest.class, {
		learnerId: record.manifest.learner.id, teacherId: record.manifest.teacher.id, world: record.manifest.world, now: context.admittedAt,
	});
	if (canonical(admitted.view) !== canonical(context.view)) throw new Error("Class participant view changed");
}

export class SchoolEpisodeStore {
	constructor(readonly root: string) {}
	private directory(id: string) { return path.join(this.root, schoolOperationId(id)); }
	read(id: string): SchoolEpisodeRecord | null {
		const directory = this.directory(id);
		if (!existsSync(directory)) return null;
		try {
			const record = JSON.parse(readFileSync(path.join(directory, "record.json"), "utf8")) as SchoolEpisodeRecord;
			if (![1, 2].includes(record.version) || record.operationId !== id || record.manifest.operationId !== id || schoolManifestSha256(record.manifest) !== record.manifestSha256 || !["RUNNING", "COMPLETED", "FAILED"].includes(record.status) || !Array.isArray(record.calls) || !Array.isArray(record.events)) throw new Error("Invalid record identity");
			validClassContext(record);
			validParticipantEvidence(record);
			return record;
		} catch { throw new SchoolEpisodeError("INCOMPLETE_OR_CORRUPT_RECORD", "The operation exists but its record is incomplete or corrupt. Do not automatically replay provider calls.", 409); }
	}
	/** Owner inspection: refuse corrupt records instead of silently dropping their work. */
	list(): SchoolEpisodeRecord[] {
		if (!existsSync(this.root)) return [];
		return readdirSync(this.root).sort().map((id) => this.read(id)!);
	}
	/** Inspect terminal evidence before current class/schedule admission. Replays
	 * never regrade old work or require a past class session to still be open. */
	replay(manifest: SchoolEpisodeManifest, evidence: SchoolEpisodeRecord["evidence"]): { replayed: true; record: SchoolEpisodeRecord } | null {
		const prior = this.read(manifest.operationId);
		if (!prior) return null;
		if (prior.manifestSha256 !== schoolManifestSha256(manifest) || prior.evidence !== evidence) throw new SchoolEpisodeError("OPERATION_COLLISION", "This operation ID already belongs to a different manifest or execution mode", 409);
		if (prior.status === "RUNNING") throw new SchoolEpisodeError("OPERATION_INCOMPLETE", "The operation is running or interrupted. Provider completion may be unknown; inspect it before starting a new operation ID.", 409);
		return { replayed: true, record: prior };
	}
	claim(initial: SchoolEpisodeRecord): { replayed: boolean; record: SchoolEpisodeRecord } {
		validClassContext(initial);
		validParticipantEvidence(initial);
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		try { mkdirSync(this.directory(initial.operationId), { mode: 0o700 }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return this.replay(initial.manifest, initial.evidence)!;
		}
		this.write(initial);
		return { replayed: false, record: initial };
	}
	write(record: SchoolEpisodeRecord): void {
		if (record.manifest.operationId !== record.operationId || schoolManifestSha256(record.manifest) !== record.manifestSha256) throw new SchoolEpisodeError("MANIFEST_DRIFT", "An admitted episode's manifest cannot change", 409);
		try { validClassContext(record); }
		catch { throw new SchoolEpisodeError("CLASS_CONTEXT_DRIFT", "An admitted episode's class context is invalid or changed", 409); }
		try { validParticipantEvidence(record); }
		catch { throw new SchoolEpisodeError("PARTICIPANT_EVIDENCE_DRIFT", "An admitted episode's participant or exposure evidence is invalid or changed", 409); }
		const directory = this.directory(record.operationId);
		const target = path.join(directory, "record.json");
		if (existsSync(target)) {
			const prior = this.read(record.operationId)!;
			if (prior.status !== "RUNNING") throw new SchoolEpisodeError("IMMUTABLE_RESULT", "A completed or failed episode cannot be rewritten", 409);
			if (prior.manifestSha256 !== record.manifestSha256) throw new SchoolEpisodeError("MANIFEST_DRIFT", "An admitted episode's manifest cannot change", 409);
			if (canonical(prior.classContext ?? null) !== canonical(record.classContext ?? null)) throw new SchoolEpisodeError("CLASS_CONTEXT_DRIFT", "An admitted episode's class snapshot cannot change", 409);
			if (canonical(prior.bindings ?? null) !== canonical(record.bindings ?? null)) throw new SchoolEpisodeError("PARTICIPANT_BINDING_DRIFT", "An admitted episode's participant bindings cannot change", 409);
			if (prior.exposures && canonical(prior.exposures) !== canonical(record.exposures?.slice(0, prior.exposures.length))) throw new SchoolEpisodeError("EXPOSURE_DRIFT", "Retained exposure receipts cannot change", 409);
			for (const call of prior.calls) if (call.runtime && canonical(call.runtime) !== canonical(record.calls.find((item) => item.id === call.id)?.runtime ?? null)) throw new SchoolEpisodeError("RUNTIME_BINDING_DRIFT", "An admitted call's runtime receipt cannot change", 409);
		}
		const temporary = path.join(directory, `record-${randomUUID()}.tmp`);
		writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
	}
}
