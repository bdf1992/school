/** School's first model-learner loop. Human lessons and the extracted graph are
 * deliberately not inputs to this evaluator or to either participant view. */
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import { piEngineForSpec, piModels, type PiEngine } from "../agent/models.ts";
import { refreshChatGPTModels } from "../agent/chatgpt-bridge.ts";
import { refreshSubscriptionModels } from "../agent/subscription-bridge.ts";
import { connectionBackgroundAllowed, isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { runSchoolParticipant, SchoolReplyLimitError, SCHOOL_LEARNER_PROMPT, SCHOOL_TEACHER_PROMPT } from "../agent/school-participant.ts";
import { compareSchoolGrades, gradeSchoolReply, parseSchoolEpisode, schoolLearnerView, schoolTeacherView, SchoolEpisodeError, type SchoolCallRecord, type SchoolEpisodeRecord, type SchoolEvaluationCase, type SchoolGrade, type SchoolParticipant, type SchoolPhase } from "../core/school-episode.ts";
import { SchoolEpisodeStore, schoolManifestSha256 } from "../store/school-episodes.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";

export const schoolEpisodes = new SchoolEpisodeStore(path.join(PATHS.data, "school", "episodes"));
export interface SchoolEpisodeOptions {
	store?: SchoolEpisodeStore;
	signal?: AbortSignal;
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
	const now = new Date().toISOString();
	const record: SchoolEpisodeRecord = { version: 1, operationId: manifest.operationId, manifestSha256: schoolManifestSha256(manifest), manifest, evidence: options.evidence ?? "CONFIGURED_PROVIDER", status: "RUNNING", createdAt: now, updatedAt: now, calls: [], events: [] };
	const claimed = store.claim(record);
	if (claimed.replayed) return claimed;
	const deadline = new AbortController();
	const episodeEndsAt = performance.now() + manifest.limits.episodeTimeoutMs;
	const timer = setTimeout(() => deadline.abort(new Error("Episode time limit exceeded")), manifest.limits.episodeTimeoutMs);
	const episodeSignal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
	const engineFor = options.engineFor ?? configuredEngine;
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
		const participant = phase === "lesson" ? manifest.teacher : manifest.learner;
		const call: SchoolCallRecord = { id: `${manifest.operationId}-${record.calls.length + 1}`, phase, role: phase === "lesson" ? "teacher" : "learner", ...(item ? { caseId: item.id } : {}), participant, systemPrompt: phase === "lesson" ? SCHOOL_TEACHER_PROMPT : SCHOOL_LEARNER_PROMPT, view, state: "REQUESTED" };
		current = call;
		record.calls.push(call);
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
			const engine = await abortable(Promise.resolve().then(() => engineFor(participant, call)), signal);
			checkDeadline();
			call.resolvedModel = { provider: engine.model.provider, id: engine.model.id, api: engine.model.api, ...(engine.level ? { thinkingLevel: engine.level } : {}) };
			call.state = "ADMITTED";
			call.completion = "UNKNOWN";
			// Write admission BEFORE dispatch. A crash in the gap is conservatively
			// unknown; a restart never repeats that call automatically.
			checkpoint("CALL_ADMITTED", call);
			checkDeadline();
			const result = await runSchoolParticipant(engine, { systemPrompt: call.systemPrompt, view, callId: call.id, maxOutputTokens: manifest.limits.maxOutputTokens, timeoutMs: manifest.limits.callTimeoutMs, signal });
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
		for (const item of manifest.evaluation) await invoke("baseline", schoolLearnerView(manifest, item), item);
		const grades = (phase: SchoolPhase) => record.calls.filter((c) => c.phase === phase).map((c) => c.grade).filter((g): g is SchoolGrade => g !== undefined);
		const baseline = grades("baseline");
		const lesson = await invoke("lesson", schoolTeacherView(manifest, baseline));
		for (const item of manifest.evaluation) await invoke("retry", schoolLearnerView(manifest, item, lesson), item);
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
	if (error instanceof SchoolEpisodeError) return response({ error: error.message, code: error.code }, error.status);
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
