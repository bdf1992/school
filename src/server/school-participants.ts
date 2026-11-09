/** Trusted owner registry API and participant-to-runtime binding. */
import path from "node:path";
import { PATHS } from "../../config.ts";
import { prepareSchoolConnectionEngine } from "../agent/school-connections.ts";
import type { PiEngine } from "../agent/models.ts";
import { MAX_SCHOOL_REGISTRY_BYTES, parseSchoolStateRef, SchoolParticipantError, type SchoolRuntimeReceipt, type SchoolStateModel, type SchoolStateRef } from "../core/school-participants.ts";
import { SchoolParticipantStore, schoolRegistrySha256, type SchoolPinnedParticipant } from "../store/school-participants.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

export const schoolParticipants = new SchoolParticipantStore(path.join(PATHS.data, "school", "registry"));
export interface SchoolBindableParticipant { id: string; model: SchoolStateModel; edition?: string; stateRef?: SchoolStateRef }
export type { SchoolPinnedParticipant } from "../store/school-participants.ts";

export function pinSchoolParticipant(participant: SchoolBindableParticipant, registry: SchoolParticipantStore = schoolParticipants): SchoolPinnedParticipant | undefined {
	if (!participant.stateRef) return undefined; // Legacy manifests preserve their old semantics.
	const stateRef = parseSchoolStateRef(participant.stateRef);
	const identity = registry.inspectParticipant(participant.id), state = registry.inspectState(participant.id, stateRef.revision);
	if (!identity || !state) throw new SchoolParticipantError("PARTICIPANT_STATE_NOT_FOUND", "The continuing participant and exact state revision must be registered before admission", 404);
	if (participant.edition !== state.definition.edition || schoolRegistrySha256(participant.model) !== schoolRegistrySha256(state.definition.model)) throw new SchoolParticipantError("PARTICIPANT_STATE_MISMATCH", "Manifest model and edition must exactly match the selected registered state", 409);
	const connection = registry.inspectConnection(state.definition.connection.id, state.definition.connection.revision);
	if (!connection) throw new SchoolParticipantError("CONNECTION_NOT_FOUND", "The state references an unavailable connection revision", 404);
	if (state.definition.model.provider !== (connection.definition.kind === "configured" ? connection.definition.provider : "custom")) throw new SchoolParticipantError("STATE_CONNECTION_MISMATCH", "The registered state does not match its connection provider", 409);
	const binding: SchoolPinnedParticipant = {
		definition: identity.definition, state: state.definition, connection: connection.definition,
		receipt: Object.freeze({ participantId: participant.id, participantSha256: identity.sha256, stateRef: Object.freeze(stateRef), stateSha256: state.sha256, connection: Object.freeze({ ...state.definition.connection }), connectionSha256: connection.sha256, memorySha256: schoolRegistrySha256(state.definition.memory ?? null), modelIdentity: "OWNER_DECLARED" }),
	};
	registry.assertBinding(binding);
	return Object.freeze(binding);
}

export async function schoolParticipantEngine<T extends SchoolBindableParticipant>(participant: T, binding: SchoolPinnedParticipant, options: {
	registry?: SchoolParticipantStore;
	configuredEngine: (participant: T) => PiEngine | Promise<PiEngine>;
	expectedRuntime?: SchoolRuntimeReceipt;
}): Promise<{ engine: PiEngine; receipt: SchoolRuntimeReceipt }> {
	const registry = options.registry ?? schoolParticipants;
	if (participant.id !== binding.receipt.participantId || participant.stateRef?.revision !== binding.receipt.stateRef.revision || participant.edition !== binding.state.edition || schoolRegistrySha256(participant.model) !== schoolRegistrySha256(binding.state.model)) throw new SchoolParticipantError("PARTICIPANT_BINDING_DRIFT", "The manifest participant no longer matches its admitted binding", 409);
	return prepareSchoolConnectionEngine({
		state: binding.state, connection: binding.connection, binding: binding.receipt,
		assertCurrent: () => registry.assertBinding(binding), configuredEngine: () => options.configuredEngine(participant),
		credential: (variable) => process.env[variable], expectedRuntime: options.expectedRuntime,
	});
}

export interface SchoolParticipantOptions { registry?: SchoolParticipantStore }
function authorized(request: Request, mutation: boolean): boolean {
	if (process.env.LH_DESKTOP_SERVER === "1" || process.env.LH_DESKTOP_API_SECRET) return desktopAPIAuthorized(request.headers);
	const supplied = request.headers.get("origin"), origin = subscriptionRequestOrigin(request);
	return Boolean(origin) && request.headers.get("sec-fetch-site") !== "cross-site" && (mutation ? supplied === origin : !supplied || supplied === origin);
}
function response(body: unknown, status = 200): Response { return Response.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function failure(error: unknown): Response {
	if (error instanceof SchoolParticipantError) return response({ error: error.message, code: error.code }, error.status);
	if (error instanceof CustomBodyLimitError) return response({ error: "Registry request exceeds 64 KiB", code: "REGISTRY_TOO_LARGE" }, 413);
	if (error instanceof SyntaxError) return response({ error: "Invalid JSON body" }, 400);
	return response({ error: "Participant registry inspection failed; inspect the stored records before retrying" }, 500);
}
export function schoolParticipantGet(request: Request, options: SchoolParticipantOptions = {}): Response {
	if (!authorized(request, false)) return response({ error: "Reading participants requires a trusted request" }, 403);
	try {
		const query = new URL(request.url).searchParams, registry = options.registry ?? schoolParticipants;
		if (!query.size) return response(registry.list());
		for (const key of query.keys()) if (!["kind", "id", "revision"].includes(key) || query.getAll(key).length !== 1) throw new SchoolParticipantError("INVALID_PARTICIPANT_QUERY", "Specify kind, id and revision at most once");
		const id = query.get("id"), revision = query.get("revision"), kind = query.get("kind");
		if (!id || !["participant", "state", "connection"].includes(kind ?? "") || (kind === "participant" ? query.has("revision") : !revision)) throw new SchoolParticipantError("INVALID_PARTICIPANT_QUERY", "Specify kind and id, and revision for a state or connection");
		const record = kind === "participant" ? registry.inspectParticipant(id) : kind === "state" ? registry.inspectState(id, revision!) : registry.inspectConnection(id, revision!);
		return record ? response(record) : response({ error: "Registry entry not found", code: "REGISTRY_ENTRY_NOT_FOUND" }, 404);
	} catch (error) { return failure(error); }
}
export async function schoolParticipantPost(request: Request, options: SchoolParticipantOptions = {}): Promise<Response> {
	if (!authorized(request, true)) return response({ error: "Changing the participant registry requires a trusted same-origin request" }, 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return response({ error: "JSON content-type is required" }, 415);
	try {
		const body = await readBoundedJson(request, MAX_SCHOOL_REGISTRY_BYTES);
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new SchoolParticipantError("INVALID_REGISTRY_REQUEST", "Request must be an action object");
		const row = body as Record<string, unknown>, registry = options.registry ?? schoolParticipants;
		if (row.action === "revoke-connection") {
			if (Object.keys(row).some((key) => !["action", "id", "revision"].includes(key)) || typeof row.id !== "string" || typeof row.revision !== "string") throw new SchoolParticipantError("INVALID_REGISTRY_REQUEST", "Revocation requires an exact connection id and revision");
			return response(registry.revokeConnection(row.id, row.revision));
		}
		if (Object.keys(row).some((key) => !["action", "definition"].includes(key))) throw new SchoolParticipantError("INVALID_REGISTRY_REQUEST", "Registration accepts only action and definition");
		const result = row.action === "register-participant" ? registry.createParticipant(row.definition)
			: row.action === "register-state" ? registry.createState(row.definition)
			: row.action === "register-connection" ? registry.createConnection(row.definition)
			: undefined;
		if (!result) throw new SchoolParticipantError("INVALID_REGISTRY_REQUEST", "Unknown registry action");
		return response(result, result.created ? 201 : 200);
	} catch (error) { return failure(error); }
}
