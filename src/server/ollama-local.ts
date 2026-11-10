import type { CustomModel } from "../core/settings.ts";
import { normalizeBaseUrl } from "../core/settings.ts";
import { readBoundedJson } from "./custom-provider-body.ts";

/** Native Ollama inspection is deliberately opt-in. An OpenAI-compatible
 * endpoint is not evidence that a model runs locally. */
export class LocalOllamaError extends Error {}

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const remote = (value: JsonRecord) => [value.remote_model, value.remote_host].some((field) => field !== undefined && field !== null && field !== "");
const cloudName = (id: string) => /(?:^|[:/._-])cloud(?:$|[:/._-])/i.test(id);

export function localOllamaOrigin(baseUrl: string): string {
	const base = normalizeBaseUrl(baseUrl);
	if (!base) throw new LocalOllamaError("Local Ollama requires a valid loopback URL ending in /v1.");
	const url = new URL(base);
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/v1") {
		throw new LocalOllamaError("Local Ollama requires localhost, 127.0.0.1, or [::1], with /v1 as the API path.");
	}
	return url.origin;
}

async function nativeJson(origin: string, route: string, signal: AbortSignal, body?: object): Promise<JsonRecord> {
	const response = await globalThis.fetch(`${origin}${route}`, {
		method: body ? "POST" : "GET", redirect: "manual", signal,
		...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	if (!response.ok || response.status >= 300) {
		await response.body?.cancel();
		throw new LocalOllamaError(`Local Ollama inspection failed (${route}, HTTP ${response.status}). No inference was sent.`);
	}
	const value = await readBoundedJson(response, 8 * 1024 * 1024);
	if (!record(value)) throw new LocalOllamaError("Local Ollama returned invalid model metadata.");
	return value;
}

function modelRows(value: JsonRecord): JsonRecord[] {
	if (!Array.isArray(value.models) || value.models.length > 128 || value.models.some((row) => !record(row))) {
		throw new LocalOllamaError("Local Ollama returned an invalid or oversized model list (maximum 128).");
	}
	return value.models as JsonRecord[];
}

function modelName(row: JsonRecord): string | undefined {
	return typeof row.name === "string" ? row.name : typeof row.model === "string" ? row.model : undefined;
}

function localWeights(id: string, row: JsonRecord, show: JsonRecord): boolean {
	const details = record(show.details) ? show.details : record(row.details) ? row.details : {};
	const info = record(show.model_info) ? show.model_info : {};
	return !cloudName(id) && !remote(row) && !remote(show)
		&& details.format === "gguf" && positive(row.size) && row.size > 1024 * 1024
		&& typeof info["general.architecture"] === "string";
}

function metadata(id: string, show: JsonRecord, active: JsonRecord[]): CustomModel {
	const info = record(show.model_info) ? show.model_info : {};
	const architecture = info["general.architecture"];
	const native = typeof architecture === "string" ? info[`${architecture}.context_length`] : undefined;
	const parameters = typeof show.parameters === "string" ? show.parameters : "";
	const matches = [...parameters.matchAll(/^\s*(?:PARAMETER\s+)?num_ctx\s+(\d+)\s*$/gim)];
	const configured = matches.length ? Number(matches.at(-1)![1]) : undefined;
	const loaded = active.find((row) => modelName(row) === id);
	const capabilities = Array.isArray(show.capabilities) ? show.capabilities : [];
	const model: CustomModel = {
		id,
		...(capabilities.includes("vision") ? { image: true } : {}),
		...(capabilities.includes("thinking") ? { reasoning: true } : {}),
		ollama: { observedAt: new Date().toISOString() },
	};
	if (positive(native)) model.ollama!.nativeContext = native;
	if (positive(configured)) {
		model.ollama!.configuredContext = configured;
		model.context = positive(native) ? Math.min(configured, native) : configured;
	}
	if (positive(loaded?.context_length)) model.ollama!.activeContext = loaded.context_length;
	return model;
}

/** Read-only, same-host native discovery. Cloud aliases and embedding-only
 * entries are excluded. Active allocation is an observation, never a promise
 * about the next request (which may load a different num_ctx). */
export async function discoverLocalOllamaModels(baseUrl: string, manualIds: readonly string[] = []): Promise<CustomModel[]> {
	const origin = localOllamaOrigin(baseUrl);
	const signal = AbortSignal.timeout(15_000);
	const [tags, running] = await Promise.allSettled([
		nativeJson(origin, "/api/tags", signal), nativeJson(origin, "/api/ps", signal),
	]);
	if (tags.status === "rejected") throw tags.reason;
	const rows = modelRows(tags.value);
	const active = running.status === "fulfilled" ? modelRows(running.value) : [];
	const models: CustomModel[] = [];
	for (let offset = 0; offset < rows.length; offset += 4) {
		const batch = await Promise.all(rows.slice(offset, offset + 4).map(async (row) => {
			const id = modelName(row);
			if (!id || cloudName(id) || remote(row)) return undefined;
			const show = await nativeJson(origin, "/api/show", signal, { model: id });
			if (!localWeights(id, row, show)) return undefined;
			if (!Array.isArray(show.capabilities) || !show.capabilities.includes("completion")) return undefined;
			return metadata(id, show, active);
		}));
		for (const model of batch) if (model) models.push(model);
	}
	for (const id of manualIds) {
		if (!models.some((model) => model.id === id)) throw new LocalOllamaError(`Model ${id} is not a verified local Ollama chat model. Manual IDs cannot bypass local-only mode.`);
	}
	if (!models.length) throw new LocalOllamaError("No verified local Ollama chat models were found. Cloud and embedding models are excluded.");
	return models.sort((left, right) => left.id.localeCompare(right.id));
}

/** Recheck the actual alias immediately before every operation, then constrain
 * the final transport as well. A cached discovery label alone cannot authorize
 * inference because an alias can change after discovery. */
export async function authorizeLocalOllamaModel(baseUrl: string, modelId: string, contextWindow: number): Promise<{ fetch: typeof fetch }> {
	const origin = localOllamaOrigin(baseUrl);
	if (cloudName(modelId)) throw new LocalOllamaError("Cloud models are disabled in Local Ollama only mode.");
	const signal = AbortSignal.timeout(10_000);
	const tags = modelRows(await nativeJson(origin, "/api/tags", signal));
	const row = tags.find((candidate) => modelName(candidate) === modelId);
	if (!row || remote(row)) throw new LocalOllamaError("The selected model is not present as local Ollama weights.");
	const show = await nativeJson(origin, "/api/show", signal, { model: modelId });
	if (!localWeights(modelId, row, show) || !Array.isArray(show.capabilities) || !show.capabilities.includes("completion")) {
		throw new LocalOllamaError("The selected alias is not a verified local Ollama chat model. No inference was sent.");
	}
	const model = metadata(modelId, show, []);
	if (!model.ollama?.configuredContext) {
		throw new LocalOllamaError("This Ollama model has no explicit num_ctx profile. Create a context profile with school:context before using Local Ollama only mode.");
	}
	if (!positive(contextWindow) || contextWindow > model.context!) {
		throw new LocalOllamaError(`School's ${contextWindow}-token budget exceeds this Ollama profile's ${model.context}-token limit. Refresh the provider or lower the model's context pin.`);
	}
	const expected = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
	const scopedFetch: typeof fetch = async (input, init) => {
		const request = new Request(input, { ...init, redirect: "manual" });
		if (request.url !== expected || request.method !== "POST") throw new LocalOllamaError("Local inference cannot change its configured destination.");
		const body = await readBoundedJson(request.clone(), 16 * 1024 * 1024);
		if (!record(body) || body.model !== modelId) throw new LocalOllamaError("Local inference cannot change its verified model.");
		const headers = new Headers(request.headers);
		headers.delete("authorization");
		const response = await globalThis.fetch(new Request(request, { headers, redirect: "manual" }));
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			throw new LocalOllamaError("Local inference redirects are disabled.");
		}
		return response;
	};
	return { fetch: scopedFetch };
}
