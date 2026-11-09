/** Explicit owner execution of a bounded durable queue. Reading a classroom
 * never starts a worker, and uncertain provider work is never retried. */
import path from "node:path";
import { PATHS } from "../../config.ts";
import { SchoolRunError, schoolRunSummary, type SchoolRunRecord } from "../core/school-run.ts";
import { SchoolEpisodeError, type SchoolEpisodeRecord } from "../core/school-episode.ts";
import { SchoolClassError } from "../core/school-class.ts";
import { SchoolParticipantError } from "../core/school-participants.ts";
import { SchoolExperimentError } from "../core/school-experiment.ts";
import { SchoolRunStore } from "../store/school-runs.ts";
import { schoolManifestSha256 } from "../store/school-episodes.ts";
import { runSchoolEpisode, type SchoolEpisodeOptions } from "./school-episodes.ts";
import { schoolEpisodes } from "./school-state.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";

export const schoolRuns = new SchoolRunStore(path.join(PATHS.data, "school", "queue"));
export interface SchoolRunOptions extends SchoolEpisodeOptions { runStore?: SchoolRunStore }
const active = new Map<string, AbortController>();
function activeKey(store: SchoolRunStore, id: string) { return `${path.resolve(store.root)}\0${id}`; }
function now(options: SchoolRunOptions) { return (options.now?.() ?? new Date()).toISOString(); }
function code(error: unknown): string { return error instanceof SchoolRunError || error instanceof SchoolEpisodeError || error instanceof SchoolClassError || error instanceof SchoolParticipantError || error instanceof SchoolExperimentError ? error.code : "EXECUTION_FAILED"; }

export function cancelSchoolRun(id: string, options: SchoolRunOptions = {}): SchoolRunRecord {
	const store = options.runStore ?? schoolRuns;
	const run = store.requestCancel(id, now(options));
	active.get(activeKey(store, id))?.abort(new Error("Queued run cancelled by owner"));
	return run;
}
function settle(run: SchoolRunRecord, record: SchoolEpisodeRecord, at: string): SchoolRunRecord {
	if (record.manifestSha256 !== schoolManifestSha256(run.manifest) || record.evidence !== run.evidence) throw new SchoolRunError("EPISODE_COLLISION", "Retained episode does not belong to this queued work", 409);
	const retainedCalls = record.calls.filter((call) => call.completion === "REPLY_RETAINED" || call.completion === "TERMINAL_REPLY_REJECTED").length;
	run = { ...run }; delete run.errorCode; delete run.finishedAt;
	if (record.status === "RUNNING" || record.calls.some((call) => call.completion === "UNKNOWN") || record.calls.length > run.maxCalls) return { ...run, status: "UNRESOLVED", retainedCalls, updatedAt: at, errorCode: "PROVIDER_COMPLETION_UNRESOLVED" };
	return { ...run, status: record.status === "COMPLETED" ? "COMPLETED" : run.cancelRequestedAt ? "CANCELLED" : "FAILED", retainedCalls, updatedAt: at, finishedAt: at, ...(record.status === "FAILED" ? { errorCode: run.cancelRequestedAt ? "OWNER_CANCELLED" : "EPISODE_FAILED" } : {}) };
}

/** Reconcile only evidence already terminal in the episode store. RUNNING raw
 * replies can be inspected, but this operation neither regrades nor dispatches. */
export function reconcileSchoolRun(id: string, options: SchoolRunOptions = {}): SchoolRunRecord {
	const store = options.runStore ?? schoolRuns, episodes = options.store ?? schoolEpisodes;
	const lease = store.acquireWorker();
	try {
		const run = store.read(id);
		if (!run) throw new SchoolRunError("RUN_NOT_FOUND", "Run not found", 404);
		if (run.status !== "RUNNING" && run.status !== "UNRESOLVED") return run;
		let result: SchoolRunRecord;
		try {
			const record = episodes.read(id);
			result = record ? settle(run, record, now(options)) : { ...run, status: "FAILED", updatedAt: now(options), finishedAt: now(options), retainedCalls: 0, errorCode: "NO_EPISODE_ADMITTED" };
		} catch (error) { result = { ...run, status: "UNRESOLVED", updatedAt: now(options), errorCode: code(error) }; }
		store.writeOwned(result, lease);
		return store.read(id)!;
	} finally { store.releaseWorker(lease); }
}

/** A deliberate owner decision to permit later work. It does not attest remote
 * completion, change the episode evidence, or make this operation replayable. */
export function acknowledgeSchoolRunUncertainty(id: string, note: unknown, options: SchoolRunOptions = {}): SchoolRunRecord {
	if (typeof note !== "string" || !note.trim() || note.length > 1024) throw new SchoolRunError("REVIEW_NOTE_REQUIRED", "Record a review note of 1–1024 characters before allowing later queued work");
	const store = options.runStore ?? schoolRuns, lease = store.acquireWorker();
	try {
		const run = store.read(id);
		if (!run) throw new SchoolRunError("RUN_NOT_FOUND", "Run not found", 404);
		if (run.status !== "UNRESOLVED") throw new SchoolRunError("RUN_NOT_UNRESOLVED", "Only unresolved work needs an uncertainty acknowledgement", 409);
		if (run.uncertaintyAcknowledgement) {
			if (run.uncertaintyAcknowledgement.note !== note.trim()) throw new SchoolRunError("ACKNOWLEDGEMENT_DRIFT", "The existing uncertainty review note cannot change", 409);
			return run;
		}
		const reviewed = { ...run, updatedAt: now(options), uncertaintyAcknowledgement: { at: now(options), note: note.trim() } };
		store.writeOwned(reviewed, lease);
		return store.read(id)!;
	} finally { store.releaseWorker(lease); }
}

export async function drainSchoolRuns(options: SchoolRunOptions & { maxRuns?: number; maxCalls?: number } = {}): Promise<{ processed: number; runs: ReturnType<typeof schoolRunSummary>[] }> {
	const store = options.runStore ?? schoolRuns, episodes = options.store ?? schoolEpisodes;
	const maxRuns = options.maxRuns ?? 16, maxCalls = options.maxCalls ?? 128;
	if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 16 || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 128) throw new SchoolRunError("DRAIN_BUDGET", "One drain admits at most 16 runs and 128 planned calls");
	const lease = store.acquireWorker(), completed: SchoolRunRecord[] = [];
	try {
		const inventory = store.list();
		if (inventory.some((run) => run.status === "RUNNING" || (run.status === "UNRESOLVED" && !run.uncertaintyAcknowledgement))) throw new SchoolRunError("WORK_UNRESOLVED", "Inspect and reconcile interrupted work, or explicitly acknowledge its uncertainty, before starting later queued work", 409);
		let plannedCalls = 0;
		for (const candidate of inventory) {
			if (options.signal?.aborted || completed.length >= maxRuns) break;
			let run = store.read(candidate.operationId)!;
			if (run.status !== "QUEUED" || Date.parse(run.notBefore) > Date.parse(now(options))) continue;
			if (plannedCalls + run.plannedCalls > maxCalls) break;
			if (run.evidence === "SCRIPTED_FIXTURE" && (!options.engineFor || options.evidence !== "SCRIPTED_FIXTURE")) throw new SchoolRunError("FIXTURE_ENGINE_REQUIRED", "Fixture work needs an explicit internal fixture engine; it cannot call configured providers", 409);
			if (run.evidence === "CONFIGURED_PROVIDER" && options.evidence === "SCRIPTED_FIXTURE") throw new SchoolRunError("EVIDENCE_MODE_MISMATCH", "A fixture worker cannot consume configured-provider work", 409);
			run = { ...run, status: "RUNNING", startedAt: now(options), updatedAt: now(options) };
			try { store.writeOwned(run, lease); }
			catch (error) { if (error instanceof SchoolRunError && error.code === "RUN_TERMINAL" && store.read(run.operationId)?.status === "CANCELLED") continue; throw error; }
			plannedCalls += run.plannedCalls;
			const controller = new AbortController(), key = activeKey(store, run.operationId);
			active.set(key, controller);
			const checkCancellation = () => {
				try { if (store.read(run.operationId)?.cancelRequestedAt) controller.abort(new Error("Queued run cancelled by owner")); }
				catch { controller.abort(new Error("Queued run state cannot be verified")); }
			};
			checkCancellation();
			const timer = setInterval(checkCancellation, 100);
			const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
			try {
				const result = await runSchoolEpisode(run.manifest, { ...options, store: episodes, evidence: run.evidence, signal });
				run = settle(store.read(run.operationId)!, result.record, now(options));
			} catch (error) {
				const latest = store.read(run.operationId)!;
				try {
					const retained = episodes.read(run.operationId);
					run = retained ? settle(latest, retained, now(options)) : { ...latest, status: latest.cancelRequestedAt ? "CANCELLED" : "FAILED", updatedAt: now(options), finishedAt: now(options), retainedCalls: 0, errorCode: code(error) };
				} catch { run = { ...latest, status: "UNRESOLVED", updatedAt: now(options), errorCode: code(error) }; }
			} finally { clearInterval(timer); active.delete(key); }
			store.writeOwned(run, lease);
			completed.push(store.read(run.operationId)!);
			if (run.status === "UNRESOLVED") break;
		}
		return { processed: completed.length, runs: completed.map(schoolRunSummary) };
	} finally { store.releaseWorker(lease); }
}

function authorized(request: Request, mutation: boolean): boolean {
	if (process.env.LH_DESKTOP_SERVER === "1" || process.env.LH_DESKTOP_API_SECRET) return desktopAPIAuthorized(request.headers);
	const supplied = request.headers.get("origin"), origin = subscriptionRequestOrigin(request);
	return Boolean(origin) && request.headers.get("sec-fetch-site") !== "cross-site" && (mutation ? supplied === origin : !supplied || supplied === origin);
}
function response(body: unknown, status = 200) { return Response.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function failure(error: unknown) {
	if (error instanceof SchoolRunError || error instanceof SchoolEpisodeError || error instanceof SchoolClassError || error instanceof SchoolParticipantError || error instanceof SchoolExperimentError) return response({ error: error.message, code: error.code }, error.status);
	if (error instanceof CustomBodyLimitError) return response({ error: "Run request exceeds 64 KiB", code: "RUN_TOO_LARGE" }, 413);
	if (error instanceof SyntaxError) return response({ error: "Invalid JSON body" }, 400);
	return response({ error: "Queue state or execution failed; inspect the retained work before retrying" }, 500);
}
export function schoolRunGet(request: Request, options: SchoolRunOptions = {}): Response {
	if (!authorized(request, false)) return response({ error: "Reading queued work requires a trusted request" }, 403);
	try {
		const query = new URL(request.url).searchParams, store = options.runStore ?? schoolRuns;
		if (!query.size) return response({ runs: store.list().map(schoolRunSummary) });
		if (query.size !== 1 || !query.get("operationId")) throw new SchoolRunError("INVALID_RUN_QUERY", "Specify operationId once, or no query to list queued work");
		const run = store.read(query.get("operationId")!);
		return run ? response({ run }) : response({ error: "Run not found", code: "RUN_NOT_FOUND" }, 404);
	} catch (error) { return failure(error); }
}
export async function schoolRunPost(request: Request, options: SchoolRunOptions = {}): Promise<Response> {
	if (!authorized(request, true)) return response({ error: "Changing queued work requires a trusted same-origin request" }, 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return response({ error: "JSON content-type is required" }, 415);
	try {
		const body = await readBoundedJson(request, 64 * 1024);
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new SchoolRunError("INVALID_RUN_ACTION", "Provide a run action");
		const row = body as Record<string, unknown>, store = options.runStore ?? schoolRuns;
		if (row.action === "enqueue") {
			if (Object.keys(row).some((key) => !["action", "manifest", "notBefore", "maxCalls"].includes(key))) throw new SchoolRunError("INVALID_RUN_ACTION", "Enqueue accepts a manifest, notBefore and maxCalls");
			const result = store.enqueue({ manifest: row.manifest, ...(row.notBefore === undefined ? {} : { notBefore: row.notBefore }), ...(row.maxCalls === undefined ? {} : { maxCalls: row.maxCalls }) }, "CONFIGURED_PROVIDER", now(options));
			return response({ created: result.created, run: schoolRunSummary(result.run) }, result.created ? 201 : 200);
		}
		if (row.action === "drain" || row.action === "recover-worker") {
			if (Object.keys(row).length !== 1) throw new SchoolRunError("INVALID_RUN_ACTION", "This action accepts no additional fields");
			return response(row.action === "drain" ? await drainSchoolRuns(options) : { recovered: store.recoverDeadWorker() });
		}
		if ((row.action === "cancel" || row.action === "reconcile") && Object.keys(row).length === 2 && typeof row.operationId === "string") return response({ run: schoolRunSummary(row.action === "cancel" ? cancelSchoolRun(row.operationId, options) : reconcileSchoolRun(row.operationId, options)) });
		if (row.action === "acknowledge-uncertainty" && Object.keys(row).length === 3 && typeof row.operationId === "string" && "note" in row) return response({ run: schoolRunSummary(acknowledgeSchoolRunUncertainty(row.operationId, row.note, options)) });
		throw new SchoolRunError("INVALID_RUN_ACTION", "Unknown or invalid run action");
	} catch (error) { return failure(error); }
}
