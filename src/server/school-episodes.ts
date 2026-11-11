/** School's first model-learner loop. Human lessons and the extracted graph are
 * deliberately not inputs to this evaluator or to either participant view. */
import type { Model } from "@earendil-works/pi-ai";
import { piEngineForSpec, piModels, type PiEngine } from "../agent/models.ts";
import { refreshChatGPTModels } from "../agent/chatgpt-bridge.ts";
import { refreshSubscriptionModels } from "../agent/subscription-bridge.ts";
import { connectionBackgroundAllowed, isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { runSchoolParticipant, SchoolReplyLimitError, SCHOOL_LEARNER_PROMPT, SCHOOL_TEACHER_PROMPT } from "../agent/school-participant.ts";
import { compareSchoolGrades, gradeSchoolReply, parseSchoolEpisode, schoolLearnerView, schoolTeacherView, SchoolEpisodeError, type SchoolCallRecord, type SchoolEpisodeRecord, type SchoolEvaluationCase, type SchoolGrade, type SchoolParticipant, type SchoolPhase } from "../core/school-episode.ts";
import { SchoolEpisodeStore, schoolManifestSha256 } from "../store/school-episodes.ts";
import { admitSchoolClassEpisode, SchoolClassError } from "../core/school-class.ts";
import { SchoolClassStore, schoolClassSha256 } from "../store/school-classes.ts";
import { SchoolParticipantError, type SchoolRuntimeReceipt } from "../core/school-participants.ts";
import { SchoolExperimentError, schoolExposureForCall, summarizeSchoolExperiment } from "../core/school-experiment.ts";
import type { SchoolParticipantStore } from "../store/school-participants.ts";
import { pinSchoolParticipant, schoolParticipantEngine } from "./school-participants.ts";
import { schoolClasses, schoolEpisodes } from "./school-state.ts";
export { schoolEpisodes } from "./school-state.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";

export interface SchoolEpisodeOptions {
	store?: SchoolEpisodeStore;
	classStore?: SchoolClassStore;
	registry?: SchoolParticipantStore;
	signal?: AbortSignal;
	/** Test clock for class admission only; execution deadlines remain monotonic. */
	now?: () => Date;
	/** Internal dependency injection for tests/fixtures, never accepted in HTTP JSON. */
	engineFor?: (participant: SchoolParticipant, call: SchoolCallRecord) => PiEngine | Promise<PiEngine>;
	evidence?: "CONFIGURED_PROVIDER" | "SCRIPTED_FIXTURE";
}

async function configuredEngine(participant: SchoolParticipant): Promise<PiEngine> {
	const { provider } = participant.model;
	const { providerKeyPresent } = await import("./keys.ts");
	// A CLI starts with cold in-memory subscription bridges. Refresh their saved
	// connection state before testing readiness; this does not generate a reply.
	// Use the existing bridges directly: model-catalog also imports graph stores
	// and their unrelated legacy-data migrations, which an episode must not run.
	if (provider === "chatgpt") await refreshChatGPTModels(piModels().getModels("openai").filter((m): m is Model<"openai-responses"> => m.api === "openai-responses"));
	else if (isSubscriptionProvider(provider)) await refreshSubscriptionModels();
	if (!providerKeyPresent(provider)) throw new SchoolEpisodeError("PROVIDER_UNAVAILABLE", `Configure and enable the selected provider (${provider}) before starting an episode`, 503);
	// An episode makes automatic follow-up calls. Existing subscription background
	// permission is required; an HTTP click does not waive that permission.
	if (!connectionBackgroundAllowed(provider)) throw new SchoolEpisodeError("BACKGROUND_NOT_ALLOWED", "This subscription has not authorized background model calls", 403);
	return piEngineForSpec(participant.model, true);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	let abort: (() => void) | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
			abort = () => reject(signal.reason ?? new Error("Episode cancelled"));
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		})]);
	} finally { if (abort) signal.removeEventListener("abort", abort); }
}
function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4096); }

export async function runSchoolEpisode(raw: unknown, options: SchoolEpisodeOptions = {}): Promise<{ replayed: boolean; record: SchoolEpisodeRecord }> {
	if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 64 * 1024) throw new SchoolEpisodeError("MANIFEST_TOO_LARGE", "Episode manifest exceeds 64 KiB", 413);
	const manifest = parseSchoolEpisode(raw);
	const store = options.store ?? schoolEpisodes;
	const evidence = options.evidence ?? "CONFIGURED_PROVIDER";
	const replay = store.replay(manifest, evidence);
	if (replay) return replay;
	if (manifest.version !== 2) throw new SchoolEpisodeError("CLASS_REQUIRED", "New episodes require version 2 and an explicit class/unit reference. Historical version 1 records remain readable and replayable.");
	const definition = (options.classStore ?? schoolClasses).get(manifest.class.classId, manifest.class.revision);
	if (!definition) throw new SchoolClassError("CLASS_NOT_FOUND", "Register the referenced class revision before starting an episode", 404);
	if (definition.assessment.evaluator !== "trimmed-exact-v1") throw new SchoolClassError("CLASS_EVALUATOR_MISMATCH", "This episode runner requires the trimmed-exact-v1 class evaluator");
	const now = (options.now?.() ?? new Date()).toISOString();
	const admission = admitSchoolClassEpisode(definition, manifest.class, { learnerId: manifest.learner.id, teacherId: manifest.teacher.id, world: manifest.world, now });
	const classContext = { ...admission, definitionSha256: schoolClassSha256(definition) };
	const pinned = { learner: pinSchoolParticipant(manifest.learner, options.registry), teacher: pinSchoolParticipant(manifest.teacher, options.registry) };
	if (manifest.experiment?.memory && !pinned.learner?.state.memory?.text.trim()) throw new SchoolEpisodeError("MEMORY_STATE_REQUIRED", "A memory condition requires an explicitly registered learner state with nonempty saved memory");
	const bindings = { ...(pinned.learner ? { learner: pinned.learner.receipt } : {}), ...(pinned.teacher ? { teacher: pinned.teacher.receipt } : {}) };
	const record: SchoolEpisodeRecord = { version: 2, operationId: manifest.operationId, manifestSha256: schoolManifestSha256(manifest), manifest, classContext, evidence, status: "RUNNING", createdAt: now, updatedAt: now, calls: [], events: [], ...(Object.keys(bindings).length ? { bindings } : {}), ...(manifest.experiment ? { exposures: [] } : {}) };
	const claimed = store.claim(record);
	if (claimed.replayed) return claimed;
	const deadline = new AbortController();
	const episodeEndsAt = performance.now() + manifest.limits.episodeTimeoutMs;
	const timer = setTimeout(() => deadline.abort(new Error("Episode time limit exceeded")), manifest.limits.episodeTimeoutMs);
	const episodeSignal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
	const engineFor = options.engineFor ?? configuredEngine;
	const runtimes: { learner?: SchoolRuntimeReceipt; teacher?: SchoolRuntimeReceipt } = {};
	let current: SchoolCallRecord | undefined;
	function checkEpisodeDeadline() {
		if (performance.now() >= episodeEndsAt && !deadline.signal.aborted) deadline.abort(new Error("Episode time limit exceeded"));
		episodeSignal.throwIfAborted();
	}
	function checkpoint(kind: string, call?: SchoolCallRecord) {
		record.updatedAt = new Date().toISOString();
		record.events.push({ sequence: record.events.length, kind, at: record.updatedAt, ...(call ? { callId: call.id } : {}) });
		store.write(record);
	}
	async function invoke(phase: SchoolPhase, view: unknown, item?: SchoolEvaluationCase): Promise<string> {
		checkEpisodeDeadline();
		const role = phase === "lesson" ? "teacher" : "learner";
		const participant = manifest[role], binding = pinned[role];
		const savedMemory = !manifest.experiment || phase === "memory" ? binding?.state.memory : undefined;
		const suppliedView = savedMemory ? { ...(view as object), savedMemory: { text: savedMemory.text, sourceIds: [...savedMemory.sourceIds] } } : view;
		const call: SchoolCallRecord = { id: `${manifest.operationId}-${record.calls.length + 1}`, phase, role, ...(item ? { caseId: item.id } : {}), participant, systemPrompt: phase === "lesson" ? SCHOOL_TEACHER_PROMPT : SCHOOL_LEARNER_PROMPT, view: suppliedView, state: "REQUESTED" };
		current = call;
		record.calls.push(call);
		if (record.exposures) record.exposures.push(await schoolExposureForCall(call, record.exposures.length));
		checkpoint("CALL_REQUESTED", call);
		const deadline = new AbortController();
		const callEndsAt = performance.now() + manifest.limits.callTimeoutMs;
		const timer = setTimeout(() => deadline.abort(new Error("Model call time limit exceeded")), manifest.limits.callTimeoutMs);
		const signal = AbortSignal.any([episodeSignal, deadline.signal]);
		function checkDeadline() {
			checkEpisodeDeadline();
			if (performance.now() >= callEndsAt && !deadline.signal.aborted) deadline.abort(new Error("Model call time limit exceeded"));
			signal.throwIfAborted();
		}
		try {
			const prepared = await abortable(Promise.resolve().then(async () => binding ? schoolParticipantEngine(participant, binding, { registry: options.registry, configuredEngine: (selected) => engineFor(selected, call), expectedRuntime: runtimes[role] }) : { engine: await engineFor(participant, call), receipt: undefined }), signal);
			const engine = prepared.engine;
			if (prepared.receipt) { call.runtime = prepared.receipt; runtimes[role] ??= prepared.receipt; }
			checkDeadline();
			call.resolvedModel = { provider: engine.model.provider, id: engine.model.id, api: engine.model.api, ...(engine.level ? { thinkingLevel: engine.level } : {}) };
			call.state = "ADMITTED";
			call.completion = "UNKNOWN";
			// Write admission BEFORE dispatch. A crash in the gap is conservatively
			// unknown; a restart never repeats that call automatically.
			checkpoint("CALL_ADMITTED", call);
			checkDeadline();
			const result = await runSchoolParticipant(engine, { systemPrompt: call.systemPrompt, view: suppliedView, callId: call.id, maxOutputTokens: manifest.limits.maxOutputTokens, timeoutMs: manifest.limits.callTimeoutMs, signal });
			call.reply = result.reply;
			call.text = result.text;
			call.state = "REPLY_RETAINED";
			call.completion = "REPLY_RETAINED";
			checkpoint("RAW_REPLY_COMMITTED", call);
			// A synchronous provider or busy microtask queue can delay timer delivery.
			// Check the monotonic deadline as well, after retaining the raw result.
			checkDeadline();
			if (result.reply.stopReason !== "stop" || result.reply.content.some((part) => part.type === "toolCall") || !result.text.trim()) throw new SchoolEpisodeError("INVALID_MODEL_REPLY", `Participant did not return a complete text answer (${result.reply.stopReason})`, 502);
			if (phase === "lesson" && new TextEncoder().encode(result.text).byteLength > 16 * 1024) throw new SchoolEpisodeError("LESSON_TOO_LARGE", "The lesson exceeded 16 KiB", 502);
			if (item) {
				call.grade = gradeSchoolReply(item, result.text);
				checkpoint("EVALUATOR_GRADED", call);
			}
			current = undefined;
			return result.text;
		} finally { clearTimeout(timer); }
	}
	try {
		const inClass = <T extends object>(view: T) => ({ ...classContext.view, ...view });
		for (const item of manifest.evaluation) await invoke("baseline", inClass(schoolLearnerView(manifest, item)), item);
		const grades = (phase: SchoolPhase) => record.calls.filter((c) => c.phase === phase).map((c) => c.grade).filter((g): g is SchoolGrade => g !== undefined);
		const baseline = grades("baseline");
		const lesson = await invoke("lesson", inClass(schoolTeacherView(manifest, baseline)));
		for (const item of manifest.evaluation) await invoke("retry", inClass(schoolLearnerView(manifest, item, lesson)), item);
		if (manifest.experiment) {
			for (const item of manifest.evaluation) await invoke("cold", inClass(schoolLearnerView(manifest, item)), item);
			if (manifest.experiment.memory) for (const item of manifest.evaluation) await invoke("memory", inClass(schoolLearnerView(manifest, item)), item);
			for (const item of manifest.experiment.transfer) await invoke("transfer", inClass(schoolLearnerView(manifest, item, lesson)), item);
			record.experiment = summarizeSchoolExperiment(manifest, record.calls);
		}
		checkEpisodeDeadline();
		record.comparison = compareSchoolGrades(baseline, grades("retry"));
		record.status = "COMPLETED";
		checkpoint("EPISODE_COMPLETED");
	} catch (error) {
		if (current) {
			if (error instanceof SchoolReplyLimitError) { current.rejectedReply = error.summary; current.completion = "TERMINAL_REPLY_REJECTED"; }
			current.completion ??= "NO_CALL_ADMITTED";
			current.state = "FAILED";
			current.error = message(error);
		}
		record.status = "FAILED";
		record.error = message(error);
		if (manifest.experiment) record.experiment = summarizeSchoolExperiment(manifest, record.calls);
		checkpoint("EPISODE_FAILED", current);
	} finally { clearTimeout(timer); }
	return { replayed: false, record };
}

function authorized(request: Request, mutation: boolean): boolean {
	if (process.env.LH_DESKTOP_SERVER === "1" || process.env.LH_DESKTOP_API_SECRET) return desktopAPIAuthorized(request.headers);
	const supplied = request.headers.get("origin");
	const origin = subscriptionRequestOrigin(request);
	return Boolean(origin) && request.headers.get("sec-fetch-site") !== "cross-site" && (mutation ? supplied === origin : !supplied || supplied === origin);
}
function response(body: unknown, status = 200): Response { return Response.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function failedResponse(error: unknown): Response {
	if (error instanceof SchoolEpisodeError || error instanceof SchoolParticipantError || error instanceof SchoolExperimentError) return response({ error: error.message, code: error.code }, error.status);
	if (error instanceof SchoolClassError) return response({ error: error.message, code: error.code }, error.status);
	if (error instanceof CustomBodyLimitError) return response({ error: "Episode manifest exceeds 64 KiB" }, 413);
	if (error instanceof SyntaxError) return response({ error: "Invalid JSON body" }, 400);
	return response({ error: "Episode storage or execution failed; inspect the operation record before retrying" }, 500);
}
export async function schoolEpisodePost(request: Request, options: SchoolEpisodeOptions = {}): Promise<Response> {
	if (!authorized(request, true)) return response({ error: "Starting an episode requires a trusted same-origin request" }, 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return response({ error: "JSON content-type is required" }, 415);
	try {
		const result = await runSchoolEpisode(await readBoundedJson(request, 64 * 1024), { ...options, signal: request.signal });
		return response(result, result.record.status === "FAILED" ? 502 : 200);
	} catch (error) { return failedResponse(error); }
}
export function schoolEpisodeGet(request: Request, store = schoolEpisodes): Response {
	if (!authorized(request, false)) return response({ error: "Reading episode evidence requires a trusted request" }, 403);
	try {
		const id = new URL(request.url).searchParams.get("operationId");
		if (!id) throw new SchoolEpisodeError("MISSING_OPERATION_ID", "Specify operationId");
		const record = store.read(id);
		return record ? response({ record }) : response({ error: "Episode not found" }, 404);
	} catch (error) { return failedResponse(error); }
}
