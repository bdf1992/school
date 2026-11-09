/** Durable queue for one explicitly owned School worker. Cancellation is an
 * independent marker, so a cancelling caller never overwrites worker state. */
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { schoolOperationId, type SchoolEpisodeRecord } from "../core/school-episode.ts";
import { parseSchoolRunRequest, schoolPlannedCalls, SchoolRunError, type SchoolRunRecord, type SchoolRunRequest, type SchoolRunStatus } from "../core/school-run.ts";

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	const text = JSON.stringify(value);
	if (text === undefined) throw new SchoolRunError("INVALID_RUN", "The run must contain JSON data");
	return text;
}
function digest(request: SchoolRunRequest, evidence: SchoolEpisodeRecord["evidence"]): string {
	return createHash("sha256").update(canonical({ request, evidence })).digest("hex");
}
const terminal: SchoolRunStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];
export interface SchoolWorkerLease { token: string; pid: number; host: string }

export class SchoolRunStore {
	constructor(readonly root: string) {}
	private directory(id: string) { return path.join(this.root, "runs", schoolOperationId(id)); }
	private atomic(filename: string, value: unknown) {
		const temporary = `${filename}-${randomUUID()}.tmp`;
		writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
		renameSync(temporary, filename);
	}
	/** Build a directory and its file outside the visible tree, then publish it
	 * with one rename, so a crash never leaves a visible directory without its file.
	 * Returns false when the target already exists. */
	private publishDirectory(target: string, filename: string, value: string): boolean {
		// POSIX rename replaces an empty directory; an existing path is never reused.
		if (existsSync(target)) return false;
		const staging = path.join(this.root, "staging", randomUUID());
		mkdirSync(staging, { recursive: true, mode: 0o700 });
		writeFileSync(path.join(staging, filename), value, { flag: "wx", mode: 0o600 });
		try { renameSync(staging, target); return true; }
		catch (error) {
			rmSync(staging, { recursive: true, force: true });
			if (existsSync(target)) return false;
			throw error;
		}
	}
	read(id: string): SchoolRunRecord | null {
		const directory = this.directory(id);
		try { lstatSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
		try {
			if (!lstatSync(directory).isDirectory()) throw new Error("Run directory required");
			const row = JSON.parse(readFileSync(path.join(directory, "run.json"), "utf8")) as SchoolRunRecord;
			const request = parseSchoolRunRequest({ manifest: row.manifest, notBefore: row.notBefore, maxCalls: row.maxCalls });
			if (row.version !== 1 || row.operationId !== id || row.manifest.operationId !== id || !["CONFIGURED_PROVIDER", "SCRIPTED_FIXTURE"].includes(row.evidence) || digest(request, row.evidence) !== row.requestSha256 || row.plannedCalls !== schoolPlannedCalls(row.manifest) || !["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "UNRESOLVED"].includes(row.status)) throw new Error("Invalid run");
			for (const value of [row.createdAt, row.updatedAt, ...(row.startedAt ? [row.startedAt] : []), ...(row.finishedAt ? [row.finishedAt] : [])]) if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid run time");
			if (row.retainedCalls !== undefined && (!Number.isInteger(row.retainedCalls) || row.retainedCalls < 0 || row.retainedCalls > row.plannedCalls)) throw new Error("Invalid retained call count");
			if (row.uncertaintyAcknowledgement && (typeof row.uncertaintyAcknowledgement.at !== "string" || !Number.isFinite(Date.parse(row.uncertaintyAcknowledgement.at)) || typeof row.uncertaintyAcknowledgement.note !== "string" || !row.uncertaintyAcknowledgement.note.trim() || row.uncertaintyAcknowledgement.note.length > 1024)) throw new Error("Invalid uncertainty acknowledgement");
			const marker = path.join(directory, "cancel.json");
			if (existsSync(marker)) {
				const cancellation = JSON.parse(readFileSync(marker, "utf8"));
				if (cancellation.operationId !== id || typeof cancellation.at !== "string" || !Number.isFinite(Date.parse(cancellation.at))) throw new Error("Invalid cancellation");
				row.cancelRequestedAt = cancellation.at;
				if (row.status === "QUEUED") { row.status = "CANCELLED"; row.updatedAt = cancellation.at; row.finishedAt = cancellation.at; }
			}
			return row;
		} catch { throw new SchoolRunError("RUN_CORRUPT", "Queued work is incomplete or corrupt; inspect it before continuing", 409); }
	}
	list(): SchoolRunRecord[] {
		const directory = path.join(this.root, "runs");
		if (!existsSync(directory)) return [];
		return readdirSync(directory).sort().map((id) => this.read(id)!).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.operationId.localeCompare(b.operationId));
	}
	enqueue(raw: unknown, evidence: SchoolEpisodeRecord["evidence"] = "CONFIGURED_PROVIDER", now = new Date().toISOString()): { created: boolean; run: SchoolRunRecord } {
		// An omitted notBefore means immediate admission, and repeated identical
		// requests reuse its original time instead of colliding with the clock.
		const input = raw as Record<string, unknown>;
		const parsed = parseSchoolRunRequest(raw, now);
		const existing = this.read(parsed.manifest.operationId);
		if (existing && input.notBefore === undefined) parsed.notBefore = existing.notBefore;
		if (existing) {
			if (existing.requestSha256 !== digest(parsed, evidence)) throw new SchoolRunError("RUN_COLLISION", "This run identity already belongs to different work or limits", 409);
			return { created: false, run: existing };
		}
		const run: SchoolRunRecord = { version: 1, operationId: parsed.manifest.operationId, ...parsed, requestSha256: digest(parsed, evidence), evidence, status: "QUEUED", plannedCalls: schoolPlannedCalls(parsed.manifest), createdAt: now, updatedAt: now };
		mkdirSync(path.join(this.root, "runs"), { recursive: true, mode: 0o700 });
		if (this.publishDirectory(this.directory(run.operationId), "run.json", JSON.stringify(run, null, 2) + "\n")) return { created: true, run };
		// A concurrent identical request may have published first.
		const raced = this.read(run.operationId);
		if (raced && raced.requestSha256 === run.requestSha256) return { created: false, run: raced };
		throw new SchoolRunError("RUN_OCCUPIED", "Run identity is already occupied; inspect before retrying", 409);
	}
	requestCancel(id: string, now = new Date().toISOString()): SchoolRunRecord {
		const run = this.read(id);
		if (!run) throw new SchoolRunError("RUN_NOT_FOUND", "Run not found", 404);
		if (terminal.includes(run.status) && run.status !== "CANCELLED") throw new SchoolRunError("RUN_TERMINAL", "This run already finished", 409);
		const temporary = path.join(this.directory(id), `cancel-${randomUUID()}.tmp`);
		writeFileSync(temporary, JSON.stringify({ operationId: id, at: now }), { flag: "wx", mode: 0o600 });
		try { linkSync(temporary, path.join(this.directory(id), "cancel.json")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		finally { unlinkSync(temporary); }
		return this.read(id)!;
	}
	/** No timeout can steal a worker. A dead same-host process may be replaced;
	 * its RUNNING items remain unresolved until explicit reconciliation. */
	acquireWorker(): SchoolWorkerLease {
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const lease = { token: randomUUID(), pid: process.pid, host: hostname() };
		// The lock directory appears together with its owner record, so a crash
		// cannot leave an ownerless lock that recovery is unable to verify.
		if (!this.publishDirectory(path.join(this.root, "worker"), "owner.json", JSON.stringify(lease))) throw new SchoolRunError("WORKER_BUSY", "A worker owns this queue. Recover a verified dead worker explicitly before continuing.", 409);
		return lease;
	}
	private assertWorker(lease: SchoolWorkerLease): void {
		let current: SchoolWorkerLease;
		try { current = JSON.parse(readFileSync(path.join(this.root, "worker", "owner.json"), "utf8")); }
		catch { throw new SchoolRunError("WORKER_OWNERSHIP", "Worker ownership is unavailable", 409); }
		if (current.token !== lease.token || current.pid !== lease.pid || current.host !== lease.host) throw new SchoolRunError("WORKER_OWNERSHIP", "This worker no longer owns the queue", 409);
	}
	releaseWorker(lease: SchoolWorkerLease): void {
		this.assertWorker(lease);
		// Rename first so a crash mid-removal cannot leave a lock without its owner.
		const released = path.join(this.root, "staging", `released-${lease.token}`);
		mkdirSync(path.dirname(released), { recursive: true, mode: 0o700 });
		renameSync(path.join(this.root, "worker"), released);
		rmSync(released, { recursive: true, force: true });
	}
	recoverDeadWorker(): boolean {
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const recovery = path.join(this.root, "recovery");
		try { mkdirSync(recovery, { mode: 0o700 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; throw new SchoolRunError("RECOVERY_BUSY", "Another recovery owns this queue; inspect it before continuing", 409); }
		try {
		const lock = path.join(this.root, "worker");
		if (!existsSync(lock)) return false;
		let prior: SchoolWorkerLease;
		try { prior = JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8")); }
		catch { throw new SchoolRunError("WORKER_INCOMPLETE", "Worker ownership is incomplete; inspect it manually", 409); }
		if (prior.host !== hostname() || !Number.isSafeInteger(prior.pid) || prior.pid <= 0 || typeof prior.token !== "string") throw new SchoolRunError("WORKER_UNVERIFIED", "The worker cannot be verified on this host", 409);
		try { process.kill(prior.pid, 0); throw new SchoolRunError("WORKER_ALIVE", "The owning process is still alive", 409); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
		this.assertWorker(prior);
		const retained = path.join(this.root, `retired-worker-${prior.token}`);
		renameSync(lock, retained);
		return true;
		} finally { rmSync(recovery, { recursive: true }); }
	}
	writeOwned(run: SchoolRunRecord, lease: SchoolWorkerLease): void {
		this.assertWorker(lease);
		const prior = this.read(run.operationId);
		if (!prior || prior.requestSha256 !== run.requestSha256 || digest({ manifest: run.manifest, notBefore: run.notBefore, maxCalls: run.maxCalls }, run.evidence) !== run.requestSha256) throw new SchoolRunError("RUN_DRIFT", "Admitted queued work cannot change", 409);
		if (terminal.includes(prior.status)) throw new SchoolRunError("RUN_TERMINAL", "Terminal queued work cannot change", 409);
		if (prior.status === "QUEUED" && run.status !== "RUNNING") throw new SchoolRunError("RUN_TRANSITION", "Queued work must be admitted before it finishes", 409);
		if ((prior.status === "RUNNING" || prior.status === "UNRESOLVED") && run.status === "QUEUED") throw new SchoolRunError("RUN_TRANSITION", "Admitted work cannot be automatically requeued", 409);
		if (prior.status === "UNRESOLVED" && run.status === "RUNNING") throw new SchoolRunError("RUN_TRANSITION", "Unresolved work cannot be automatically resumed", 409);
		if (prior.uncertaintyAcknowledgement && canonical(prior.uncertaintyAcknowledgement) !== canonical(run.uncertaintyAcknowledgement ?? null)) throw new SchoolRunError("ACKNOWLEDGEMENT_DRIFT", "The owner's uncertainty acknowledgement cannot change", 409);
		this.atomic(path.join(this.directory(run.operationId), "run.json"), run);
	}
}
