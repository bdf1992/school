/** One bounded advertisement request. This never runs a model or resolves a global provider. */
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import {
	parseSchoolConnectionDefinition, parseSchoolParticipantState, SchoolParticipantError,
	type SchoolConnectionDefinition, type SchoolParticipantBindingReceipt, type SchoolParticipantState,
} from "../core/school-participants.ts";

export const PREFLIGHT_MAX_BODY_BYTES = 1024 * 1024;
export interface SchoolPreflightBinding {
	state: SchoolParticipantState;
	connection: SchoolConnectionDefinition;
	receipt: SchoolParticipantBindingReceipt;
	assertCurrent: () => void;
}
export interface SchoolPreflightReceipt {
	version: 1;
	kind: "school-connection-preflight";
	startedAt: string; finishedAt: string; elapsedMs: number;
	host: { hostname: string; platform: string; architecture: string; node: string };
	participant: { id: string; stateRevision: string };
	binding?: SchoolParticipantBindingReceipt;
	model?: { provider: string; id: string; thinkingLevel?: string };
	connection?: { id: string; revision: string; baseUrl: string; authMode: string; contextWindow: number; maxOutputTokens: number; reasoning: boolean };
	request: { method: "GET"; url?: string; attempted: boolean; responseStatus: number | null; bodyBytes: number; timeoutMs: number; maxBodyBytes: number };
	advertisement: { modelCount: number | null; matchingEntries: number | null; exactModelAdvertised: boolean | null };
	outcome: "PASSED" | "FAILED" | "REFUSED";
	observation: "ABSENT" | "INSUFFICIENT" | "SUFFICIENT";
	error?: { code: string; message: string };
	loadedArtifact: "NOT_ATTESTED";
	inference: "NOT_PERFORMED";
}
class PreflightFailure extends Error {
	constructor(readonly code: string, message: string, readonly refused = false) { super(message); }
}
export function preflightTimeout(value: number): number {
	if (!Number.isInteger(value) || value < 1 || value > 60_000) throw new Error("timeout-ms must be an integer from 1 through 60000");
	return value;
}

export async function preflightSchoolConnection(options: {
	participantId: string; stateRevision: string; timeoutMs: number;
	resolve: () => SchoolPreflightBinding;
	credential: (variable: string) => string | undefined;
}): Promise<SchoolPreflightReceipt> {
	preflightTimeout(options.timeoutMs);
	const started = performance.now();
	const receipt: SchoolPreflightReceipt = {
		version: 1, kind: "school-connection-preflight", startedAt: new Date().toISOString(), finishedAt: "", elapsedMs: 0,
		host: { hostname: hostname(), platform: process.platform, architecture: process.arch, node: process.version },
		participant: { id: options.participantId, stateRevision: options.stateRevision },
		request: { method: "GET", attempted: false, responseStatus: null, bodyBytes: 0, timeoutMs: options.timeoutMs, maxBodyBytes: PREFLIGHT_MAX_BODY_BYTES },
		advertisement: { modelCount: null, matchingEntries: null, exactModelAdvertised: null },
		outcome: "REFUSED", observation: "ABSENT", loadedArtifact: "NOT_ATTESTED", inference: "NOT_PERFORMED",
	};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	let response: Response | undefined;
	try {
		const binding = options.resolve();
		const state = parseSchoolParticipantState(binding.state), connection = parseSchoolConnectionDefinition(binding.connection);
		binding.assertCurrent();
		receipt.binding = binding.receipt;
		receipt.model = { ...state.model };
		if (connection.kind !== "openai-compatible") throw new PreflightFailure("UNSUPPORTED_CONNECTION", "Preflight requires an explicit OpenAI-compatible connection; configured providers are not inspected.", true);
		if (state.participantId !== options.participantId || state.revision !== options.stateRevision || state.model.provider !== "custom" || state.connection.id !== connection.id || state.connection.revision !== connection.revision) throw new PreflightFailure("STATE_CONNECTION_MISMATCH", "The selected participant state does not match its named connection.", true);
		receipt.connection = { id: connection.id, revision: connection.revision, baseUrl: connection.baseUrl, authMode: connection.auth.mode, contextWindow: connection.contextWindow, maxOutputTokens: connection.maxOutputTokens, reasoning: connection.reasoning };
		receipt.request.url = `${connection.baseUrl}/models`;
		const credential = () => connection.auth.mode === "environment" ? options.credential(connection.auth.variable)?.trim() : undefined;
		const key = credential();
		if (connection.auth.mode === "environment" && !key) throw new PreflightFailure("CONNECTION_CREDENTIAL_UNAVAILABLE", "The named connection's dedicated credential is unavailable.", true);
		if (key && /[^\x20-\x7e]/.test(key)) throw new PreflightFailure("CONNECTION_CREDENTIAL_INVALID", "The named connection credential is not valid HTTP header text.", true);
		binding.assertCurrent();
		if (credential() !== key) throw new PreflightFailure("CONNECTION_CREDENTIAL_CHANGED", "The dedicated connection credential changed before dispatch.", true);
		controller.signal.throwIfAborted();
		receipt.request.attempted = true;
		response = await fetch(receipt.request.url, { method: "GET", headers: { authorization: `Bearer ${key ?? "not-needed"}`, accept: "application/json" }, redirect: "manual", signal: controller.signal });
		receipt.request.responseStatus = response.status;
		receipt.observation = "INSUFFICIENT";
		if (response.status >= 300 && response.status < 400) throw new PreflightFailure("CONNECTION_REDIRECT_REFUSED", "Named connection redirects are refused.");
		if (!response.ok) throw new PreflightFailure("HTTP_ERROR", "The endpoint returned a non-success HTTP status; its body is not retained.");
		if (Number(response.headers.get("content-length")) > PREFLIGHT_MAX_BODY_BYTES) throw new PreflightFailure("RESPONSE_TOO_LARGE", "The model advertisement exceeds 1 MiB.");
		if (!response.body) throw new PreflightFailure("INVALID_MODELS_RESPONSE", "The endpoint returned no model advertisement body.");
		const reader = response.body.getReader(), chunks: Uint8Array[] = [];
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				receipt.request.bodyBytes += next.value.byteLength;
				if (receipt.request.bodyBytes > PREFLIGHT_MAX_BODY_BYTES) throw new PreflightFailure("RESPONSE_TOO_LARGE", "The model advertisement exceeds 1 MiB.");
				chunks.push(next.value);
			}
		} finally { reader.releaseLock(); }
		let body: unknown;
		try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
		catch { throw new PreflightFailure("INVALID_MODELS_RESPONSE", "The endpoint returned an invalid UTF-8 or JSON model advertisement."); }
		if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) throw new PreflightFailure("INVALID_MODELS_RESPONSE", "The model advertisement must contain a data array.");
		const models = (body as { data: unknown[] }).data;
		if (models.some((model) => !model || typeof model !== "object" || typeof (model as { id?: unknown }).id !== "string" || !(model as { id: string }).id.trim())) throw new PreflightFailure("INVALID_MODELS_RESPONSE", "Every advertised model must have a nonempty string ID.");
		binding.assertCurrent();
		if (credential() !== key) throw new PreflightFailure("CONNECTION_CREDENTIAL_CHANGED", "The dedicated connection credential changed during the request.", true);
		const matches = models.filter((model) => (model as { id: string }).id === state.model.id).length;
		receipt.advertisement = { modelCount: models.length, matchingEntries: matches, exactModelAdvertised: matches > 0 };
		receipt.observation = "SUFFICIENT";
		if (matches === 0) throw new PreflightFailure("MODEL_NOT_ADVERTISED", "The exact registered model ID was not advertised; no substitute was selected.");
		receipt.outcome = "PASSED";
	} catch (error) {
		receipt.outcome = error instanceof SchoolParticipantError || error instanceof PreflightFailure && error.refused ? "REFUSED" : "FAILED";
		receipt.error = controller.signal.aborted ? { code: "TIMEOUT", message: "The model advertisement exceeded its request deadline." }
			: error instanceof PreflightFailure ? { code: error.code, message: error.message }
				: error instanceof SchoolParticipantError ? { code: error.code, message: "Participant admission or binding verification was refused; inspect its registry state." }
					: { code: "REQUEST_FAILED", message: "The model advertisement could not be completed; no untrusted error text or response body is retained." };
	} finally {
		clearTimeout(timer);
		controller.abort();
		if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
		receipt.finishedAt = new Date().toISOString();
		receipt.elapsedMs = Math.round((performance.now() - started) * 100) / 100;
	}
	return receipt;
}
