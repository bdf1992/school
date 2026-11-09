/** School-specific immutable routing around the existing Pi transport. Store
 * access and existing configured-provider permissions are injected by the server. */
import { createHash } from "node:crypto";
import { clampThinkingLevel, createModels, createProvider, type Api, type Model } from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { SchoolParticipantError, type SchoolConnectionDefinition, type SchoolParticipantBindingReceipt, type SchoolParticipantState, type SchoolRuntimeReceipt } from "../core/school-participants.ts";
import { APP_IDENTITY, type PiEngine } from "./models.ts";

interface SchoolConnectionEngineOptions {
	state: SchoolParticipantState;
	connection: SchoolConnectionDefinition;
	binding: SchoolParticipantBindingReceipt;
	assertCurrent: () => void;
	configuredEngine: () => PiEngine | Promise<PiEngine>;
	/** Only the dedicated variable of this exact connection revision is requested. */
	credential: (variable: string) => string | undefined;
	expectedRuntime?: SchoolRuntimeReceipt;
}

function safeBaseUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.username || url.password || url.search || url.hash) throw new Error("Unsafe URL");
		return url.toString().replace(/\/+$/, "");
	} catch { throw new SchoolParticipantError("UNSAFE_RUNTIME_ROUTE", "Resolved model route must be an absolute URL without embedded credentials, query or fragment", 409); }
}
function configuration(engine: PiEngine): string {
	const model = engine.model;
	// Deliberately exclude headers, credentials, arbitrary options and transcripts.
	return createHash("sha256").update(JSON.stringify({ provider: model.provider, id: model.id, api: model.api, baseUrl: safeBaseUrl(model.baseUrl), thinkingLevel: engine.level, reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens, input: [...model.input] })).digest("hex");
}
function receipt(engine: PiEngine, binding: SchoolParticipantBindingReceipt): SchoolRuntimeReceipt {
	const baseUrl = safeBaseUrl(engine.model.baseUrl);
	return Object.freeze({ participant: binding, resolvedModel: Object.freeze({ provider: engine.model.provider, id: engine.model.id, api: engine.model.api, ...(baseUrl ? { baseUrl } : {}), ...(engine.level ? { thinkingLevel: engine.level } : {}) }), configurationSha256: configuration(engine), loadedArtifact: "NOT_ATTESTED" });
}
function assertSameRuntime(actual: SchoolRuntimeReceipt, expected: SchoolRuntimeReceipt | undefined): void {
	if (expected && (actual.configurationSha256 !== expected.configurationSha256 || actual.participant.participantId !== expected.participant.participantId || actual.participant.stateSha256 !== expected.participant.stateSha256 || actual.participant.connectionSha256 !== expected.participant.connectionSha256)) throw new SchoolParticipantError("PARTICIPANT_RUNTIME_DRIFT", "Resolved model route or capabilities changed after admission; create a new operation with an explicit new state", 409);
}

function explicitEngine(options: SchoolConnectionEngineOptions, connection: Extract<SchoolConnectionDefinition, { kind: "openai-compatible" }>): PiEngine {
	const model: Model<Api> = {
		id: options.state.model.id, name: options.state.model.id, api: "openai-completions", provider: "custom", baseUrl: connection.baseUrl,
		reasoning: connection.reasoning, input: ["text"], contextWindow: connection.contextWindow, maxTokens: connection.maxOutputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, type: "chat",
	};
	const level = clampThinkingLevel(model, options.state.model.thinkingLevel ?? "off");
	return {
		model, level,
		streamFn: (_requestModel, context, streamOptions) => lazyStream(model, async () => {
			options.assertCurrent();
			const key = connection.auth.mode === "environment" ? options.credential(connection.auth.variable)?.trim() : undefined;
			if (connection.auth.mode === "environment" && !key) throw new SchoolParticipantError("CONNECTION_CREDENTIAL_UNAVAILABLE", "The named connection's dedicated credential is unavailable", 409);
			if (key && /[^\x20-\x7e]/.test(key)) throw new SchoolParticipantError("CONNECTION_CREDENTIAL_INVALID", "The named connection credential is not valid HTTP header text", 409);
			// A private collection prevents two endpoints with the same provider/model
			// IDs from colliding with each other or the mutable global custom source.
			const models = createModels({ identity: APP_IDENTITY });
			models.setProvider(createProvider<Api>({
				id: "custom", name: connection.label, baseUrl: connection.baseUrl,
				auth: { apiKey: { name: "School connection credential", resolve: async () => ({ auth: { apiKey: key ?? "not-needed" }, source: connection.auth.mode === "environment" ? connection.auth.variable : "keyless" }) } },
				models: [model], api: openAICompletionsApi(),
			}));
			const target = `${connection.baseUrl}/chat/completions`;
			// Check the exact final destination and refuse redirects before an SDK
			// can forward any header to a different endpoint. Retry is also explicit:
			// School's admission protocol never silently duplicates an uncertain call.
			const scopedFetch: typeof fetch = async (input, init) => {
				options.assertCurrent();
				const url = input instanceof Request ? input.url : String(input);
				if (url !== target) throw new SchoolParticipantError("CONNECTION_ROUTE_DRIFT", "The named connection attempted a different request destination", 409);
				if (connection.auth.mode === "environment" && options.credential(connection.auth.variable)?.trim() !== key) throw new SchoolParticipantError("CONNECTION_CREDENTIAL_CHANGED", "The connection credential changed before dispatch", 409);
				const result = await globalThis.fetch(input, { ...init, redirect: "manual" });
				if (result.status >= 300 && result.status < 400) { await result.body?.cancel(); throw new SchoolParticipantError("CONNECTION_REDIRECT_REFUSED", "Named connection redirects are refused", 409); }
				return result;
			};
			return models.streamSimple(model, context, { ...streamOptions, apiKey: key ?? "not-needed", headers: undefined, env: {}, fetch: scopedFetch, maxRetries: 0, reasoning: level === "off" ? undefined : level });
		}),
	};
}

export async function prepareSchoolConnectionEngine(options: SchoolConnectionEngineOptions): Promise<{ engine: PiEngine; receipt: SchoolRuntimeReceipt }> {
	options.assertCurrent();
	const initial = options.connection.kind === "configured" ? await options.configuredEngine() : explicitEngine(options, options.connection);
	if (initial.model.provider !== options.state.model.provider || initial.model.id !== options.state.model.id) throw new SchoolParticipantError("PARTICIPANT_MODEL_MISMATCH", "Configured engine does not resolve the admitted participant model", 409);
	const prepared = receipt(initial, options.binding);
	assertSameRuntime(prepared, options.expectedRuntime);
	const engine: PiEngine = {
		model: initial.model, level: initial.level,
		streamFn: (_requestModel, context, streamOptions) => lazyStream(initial.model, async () => {
			options.assertCurrent();
			// Configured account permission/auth checks remain live at dispatch. Its
			// existing provider adapter is reused; no alternate hosted API is built.
			const current = options.connection.kind === "configured" ? await options.configuredEngine() : initial;
			assertSameRuntime(receipt(current, options.binding), prepared);
			return current.streamFn(current.model, context, streamOptions);
		}),
	};
	return { engine, receipt: prepared };
}
