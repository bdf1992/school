/** Continuing identities and immutable, explicitly declared execution states.
 * Model artifact hashes are owner declarations, never loaded-weight attestations. */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const MAX_SCHOOL_REGISTRY_BYTES = 64 * 1024;
export interface SchoolStateRef { revision: string }
export interface SchoolConnectionRef { id: string; revision: string }
export interface SchoolParticipantDefinition { version: 1; id: string; label: string; kind: "model" | "agent" | "human" }
export interface SchoolStateModel { provider: string; id: string; thinkingLevel?: ThinkingLevel }
export interface SchoolMemorySnapshot { text: string; sourceIds: string[] }
export interface SchoolParticipantState {
	version: 1;
	participantId: string;
	revision: string;
	model: SchoolStateModel;
	edition?: string;
	connection: SchoolConnectionRef;
	parent?: SchoolStateRef;
	memory?: SchoolMemorySnapshot;
	artifacts: { kind: "weights" | "adapter" | "program" | "context"; sha256: string; label: string }[];
}
export type SchoolConnectionDefinition = {
	version: 1; id: string; revision: string; label: string;
} & (
	{ kind: "configured"; provider: string } |
	{ kind: "openai-compatible"; baseUrl: string; auth: { mode: "keyless" } | { mode: "environment"; variable: string }; contextWindow: number; maxOutputTokens: number; reasoning: boolean }
);
export interface SchoolParticipantBindingReceipt {
	participantId: string;
	participantSha256: string;
	stateRef: SchoolStateRef;
	stateSha256: string;
	connection: SchoolConnectionRef;
	connectionSha256: string;
	memorySha256: string;
	modelIdentity: "OWNER_DECLARED";
}
export interface SchoolRuntimeReceipt {
	participant: SchoolParticipantBindingReceipt;
	resolvedModel: { provider: string; id: string; api: string; baseUrl?: string; thinkingLevel?: ThinkingLevel };
	configurationSha256: string;
	loadedArtifact: "NOT_ATTESTED";
}
export class SchoolParticipantError extends Error {
	constructor(public code: string, message: string, public status = 400) { super(message); this.name = "SchoolParticipantError"; }
}

function fail(message: string): never { throw new SchoolParticipantError("INVALID_PARTICIPANT_DEFINITION", message); }
function object(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object`);
	const row = value as Record<string, unknown>;
	if (Object.keys(row).some((key) => !keys.includes(key))) fail(`${where} contains an unknown field`);
	return row;
}
function text(value: unknown, where: string, max = 256): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) fail(`${where} must be nonempty text of at most ${max} characters`);
	return value;
}
export function schoolRegistryIdentifier(value: unknown, where = "identifier"): string {
	const id = text(value, where, 128);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) fail(`${where} must use letters, digits, hyphens or underscores`);
	return id;
}
function bounded(value: unknown): void {
	let encoded: string | undefined;
	try { encoded = JSON.stringify(value); } catch { fail("Definition must be JSON"); }
	if (!encoded || new TextEncoder().encode(encoded).byteLength > MAX_SCHOOL_REGISTRY_BYTES) fail("Definition exceeds 64 KiB");
}
function frozen<T>(value: T): T {
	if (value && typeof value === "object") { for (const entry of Object.values(value)) frozen(entry); Object.freeze(value); }
	return value;
}
function integer(value: unknown, where: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) fail(`${where} must be an integer from ${min} to ${max}`);
	return value;
}
export function parseSchoolStateRef(value: unknown): SchoolStateRef {
	const row = object(value, ["revision"], "stateRef");
	return { revision: schoolRegistryIdentifier(row.revision, "stateRef.revision") };
}
export function parseSchoolParticipantDefinition(value: unknown): SchoolParticipantDefinition {
	bounded(value);
	const row = object(value, ["version", "id", "label", "kind"], "participant");
	if (row.version !== 1 || !["model", "agent", "human"].includes(String(row.kind))) fail("Unsupported participant version or kind");
	return frozen({ version: 1, id: schoolRegistryIdentifier(row.id, "participant.id"), label: text(row.label, "participant.label"), kind: row.kind as SchoolParticipantDefinition["kind"] });
}
/** A dedicated credential name for one immutable endpoint revision. Restrict
 * connection IDs to make the mapping injective, including on Windows. */
export function schoolConnectionCredentialVariable(id: string, revision: string): string {
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !/^[1-9][0-9]{0,8}$/.test(revision)) fail("Connection IDs use lowercase letters/digits/hyphens and revisions are positive decimal integers");
	return `SCHOOL_CONNECTION_${id.replaceAll("-", "_").toUpperCase()}_${revision}_API_KEY`;
}
export function parseSchoolConnectionDefinition(value: unknown): SchoolConnectionDefinition {
	bounded(value);
	const row = object(value, ["version", "id", "revision", "label", "kind", "provider", "baseUrl", "auth", "contextWindow", "maxOutputTokens", "reasoning"], "connection");
	if (row.version !== 1 || (row.kind !== "configured" && row.kind !== "openai-compatible")) fail("Unsupported connection version or kind");
	const id = schoolRegistryIdentifier(row.id, "connection.id"), revision = schoolRegistryIdentifier(row.revision, "connection.revision");
	const variable = schoolConnectionCredentialVariable(id, revision);
	const common = { version: 1 as const, id, revision, label: text(row.label, "connection.label") };
	if (row.kind === "configured") {
		if (["baseUrl", "auth", "contextWindow", "maxOutputTokens", "reasoning"].some((key) => key in row)) fail("A configured connection has only its existing provider reference");
		const provider = text(row.provider, "connection.provider", 128);
		if (provider === "custom") fail("The mutable global custom endpoint cannot be a named configured connection; register an explicit openai-compatible connection");
		return frozen({ ...common, kind: "configured", provider });
	}
	if ("provider" in row) fail("A named endpoint uses the explicit custom protocol, not an inherited provider credential");
	let url: URL;
	try { url = new URL(text(row.baseUrl, "connection.baseUrl", 2048)); } catch { fail("baseUrl must be an absolute HTTP(S) URL"); }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail("baseUrl must be HTTP(S) without credentials, query or fragment");
	const auth = object(row.auth, ["mode", "variable"], "connection.auth");
	if (auth.mode !== "keyless" && auth.mode !== "environment") fail("Connection auth must explicitly be keyless or environment");
	if (auth.mode === "keyless" && "variable" in auth) fail("Keyless connections do not read a credential");
	if (auth.mode === "environment" && auth.variable !== variable) fail(`This connection revision requires credential variable ${variable}`);
	if (typeof row.reasoning !== "boolean") fail("reasoning must be an explicit capability declaration");
	return frozen({ ...common, kind: "openai-compatible", baseUrl: url.toString().replace(/\/+$/, ""), auth: auth.mode === "keyless" ? { mode: "keyless" } : { mode: "environment", variable }, contextWindow: integer(row.contextWindow, "contextWindow", 256, 4_194_304), maxOutputTokens: integer(row.maxOutputTokens, "maxOutputTokens", 1, 131_072), reasoning: row.reasoning });
}
export function parseSchoolParticipantState(value: unknown): SchoolParticipantState {
	bounded(value);
	const row = object(value, ["version", "participantId", "revision", "model", "edition", "connection", "parent", "memory", "artifacts"], "state");
	if (row.version !== 1) fail("Unsupported state version");
	const model = object(row.model, ["provider", "id", "thinkingLevel"], "state.model");
	if (model.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(model.thinkingLevel))) fail("Unsupported thinking level");
	const connection = object(row.connection, ["id", "revision"], "state.connection");
	const id = schoolRegistryIdentifier(connection.id, "connection.id"), connectionRevision = schoolRegistryIdentifier(connection.revision, "connection.revision");
	schoolConnectionCredentialVariable(id, connectionRevision);
	let memory: SchoolMemorySnapshot | undefined;
	if (row.memory !== undefined) {
		const item = object(row.memory, ["text", "sourceIds"], "state.memory");
		if (typeof item.text !== "string" || new TextEncoder().encode(item.text).byteLength > 16 * 1024 || !Array.isArray(item.sourceIds) || item.sourceIds.length > 64) fail("Memory needs text of at most 16 KiB and at most 64 source IDs");
		const sourceIds = item.sourceIds.map((source) => text(source, "memory source ID", 256));
		if (new Set(sourceIds).size !== sourceIds.length) fail("Memory source IDs must be distinct");
		memory = { text: item.text, sourceIds };
	}
	if (!Array.isArray(row.artifacts) || row.artifacts.length > 16) fail("State artifacts must be an array of at most 16 declared references");
	const artifacts = row.artifacts.map((value) => {
		const item = object(value, ["kind", "sha256", "label"], "artifact");
		if (!["weights", "adapter", "program", "context"].includes(String(item.kind)) || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) fail("Artifact reference needs a supported kind and lowercase SHA-256");
		return { kind: item.kind as SchoolParticipantState["artifacts"][number]["kind"], sha256: item.sha256, label: text(item.label, "artifact label") };
	});
	const revision = schoolRegistryIdentifier(row.revision, "state.revision"), parent = row.parent === undefined ? undefined : parseSchoolStateRef(row.parent);
	if (parent?.revision === revision) fail("A state cannot be its own parent");
	return frozen({ version: 1, participantId: schoolRegistryIdentifier(row.participantId, "state.participantId"), revision, model: { provider: text(model.provider, "state.model.provider", 128), id: text(model.id, "state.model.id", 256), ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel as ThinkingLevel }) }, connection: { id, revision: connectionRevision }, artifacts, ...(row.edition === undefined ? {} : { edition: text(row.edition, "state.edition", 256) }), ...(parent ? { parent } : {}), ...(memory ? { memory } : {}) });
}
