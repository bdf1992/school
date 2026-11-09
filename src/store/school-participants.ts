/** Immutable participant identities, state snapshots and named endpoint revisions. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	MAX_SCHOOL_REGISTRY_BYTES, parseSchoolConnectionDefinition, parseSchoolParticipantDefinition,
	parseSchoolParticipantState, schoolRegistryIdentifier, SchoolParticipantError,
	type SchoolConnectionDefinition, type SchoolParticipantDefinition, type SchoolParticipantState,
	type SchoolParticipantBindingReceipt,
} from "../core/school-participants.ts";

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new SchoolParticipantError("INVALID_REGISTRY_VALUE", "Registry value must be JSON");
	return encoded;
}
export function schoolRegistrySha256(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export interface SchoolRegistryEntry<T> { definition: T; sha256: string }
export type SchoolConnectionEntry = SchoolRegistryEntry<SchoolConnectionDefinition> & { revoked: boolean };
export interface SchoolPinnedParticipant {
	definition: SchoolParticipantDefinition;
	state: SchoolParticipantState;
	connection: SchoolConnectionDefinition;
	receipt: SchoolParticipantBindingReceipt;
}

function exists(filename: string): boolean {
	try { lstatSync(filename); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function assertDirectory(directory: string): void {
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SchoolParticipantError("REGISTRY_STORE_CONFLICT", "Registry path is not a regular directory", 409);
}
function ensureDirectory(directory: string): void {
	try { mkdirSync(directory, { mode: 0o700 }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	assertDirectory(directory);
}
function writeDurable(filename: string, value: unknown): void {
	const descriptor = openSync(filename, "wx", 0o600);
	try { writeFileSync(descriptor, JSON.stringify(value) + "\n"); fsyncSync(descriptor); }
	finally { closeSync(descriptor); }
}
type Collection = "participants" | "states" | "connections";

export class SchoolParticipantStore {
	constructor(readonly root: string) {}
	private components(collection: Collection, id: string, revision?: string): string[] {
		return [collection, schoolRegistryIdentifier(id), ...(revision === undefined ? [] : [schoolRegistryIdentifier(revision, "revision")])];
	}
	private directory(collection: Collection, id: string, revision?: string): string | null {
		const parts = this.components(collection, id, revision);
		let directory = this.root;
		if (!exists(directory)) return null;
		assertDirectory(directory);
		for (const part of parts) {
			directory = path.join(directory, part);
			if (!exists(directory)) return null;
			assertDirectory(directory);
		}
		return directory;
	}
	private inspect<T>(collection: Collection, id: string, revision: string | undefined, parse: (value: unknown) => T): SchoolRegistryEntry<T> | null {
		const directory = this.directory(collection, id, revision);
		if (!directory) return null;
		try {
			const filename = path.join(directory, "definition.json"), stat = lstatSync(filename);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SCHOOL_REGISTRY_BYTES + 512) throw new Error("Invalid definition file");
			const record = JSON.parse(readFileSync(filename, "utf8")) as Record<string, unknown>;
			if (!record || typeof record !== "object" || Array.isArray(record) || record.version !== 1 || Object.keys(record).some((key) => !["version", "definition", "sha256"].includes(key))) throw new Error("Invalid registry record");
			const definition = parse(record.definition), identity = definition as { id?: string; participantId?: string; revision?: string };
			if ((identity.id ?? identity.participantId) !== id || identity.revision !== revision || schoolRegistrySha256(definition) !== record.sha256) throw new Error("Registry identity changed");
			return { definition, sha256: record.sha256 as string };
		} catch {
			throw new SchoolParticipantError("INCOMPLETE_OR_CORRUPT_REGISTRY", `Registry ${collection}/${id}${revision ? `/${revision}` : ""} is incomplete or corrupt; inspect it before registering a new revision`, 409);
		}
	}
	private create<T>(collection: Collection, id: string, revision: string | undefined, definition: T, parse: (value: unknown) => T): SchoolRegistryEntry<T> & { created: boolean } {
		const sha256 = schoolRegistrySha256(definition), parts = this.components(collection, id, revision);
		mkdirSync(path.dirname(this.root), { recursive: true, mode: 0o700 });
		ensureDirectory(this.root);
		let directory = this.root;
		for (const part of parts.slice(0, -1)) { directory = path.join(directory, part); ensureDirectory(directory); }
		directory = path.join(directory, parts.at(-1)!);
		try { mkdirSync(directory, { mode: 0o700 }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const prior = this.inspect(collection, id, revision, parse)!;
			if (prior.sha256 !== sha256) throw new SchoolParticipantError("IMMUTABLE_REGISTRY_CONFLICT", "This identity or revision already has a different definition; register an explicit new identity or revision", 409);
			return { created: false, ...prior };
		}
		const temporary = path.join(directory, `definition-${randomUUID()}.tmp`);
		writeDurable(temporary, { version: 1, definition, sha256 });
		renameSync(temporary, path.join(directory, "definition.json"));
		return { created: true, definition, sha256 };
	}
	inspectParticipant(id: string): SchoolRegistryEntry<SchoolParticipantDefinition> | null { return this.inspect("participants", id, undefined, parseSchoolParticipantDefinition); }
	inspectState(id: string, revision: string): SchoolRegistryEntry<SchoolParticipantState> | null { return this.inspect("states", id, revision, parseSchoolParticipantState); }
	inspectConnection(id: string, revision: string): SchoolConnectionEntry | null {
		const entry = this.inspect("connections", id, revision, parseSchoolConnectionDefinition);
		if (!entry) return null;
		const filename = path.join(this.directory("connections", id, revision)!, "revoked.json");
		if (!exists(filename)) return { ...entry, revoked: false };
		try {
			const stat = lstatSync(filename);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) throw new Error("Invalid revocation marker");
			const marker = JSON.parse(readFileSync(filename, "utf8"));
			if (schoolRegistrySha256(marker) !== schoolRegistrySha256({ version: 1, id, revision, revoked: true })) throw new Error("Invalid revocation marker");
			return { ...entry, revoked: true };
		} catch { throw new SchoolParticipantError("CORRUPT_CONNECTION_REVOCATION", "Connection revocation record is incomplete or corrupt; execution is refused", 409); }
	}
	createParticipant(raw: unknown) {
		const definition = parseSchoolParticipantDefinition(raw);
		return this.create("participants", definition.id, undefined, definition, parseSchoolParticipantDefinition);
	}
	createConnection(raw: unknown) {
		const definition = parseSchoolConnectionDefinition(raw);
		const result = this.create("connections", definition.id, definition.revision, definition, parseSchoolConnectionDefinition);
		return { ...result, revoked: this.inspectConnection(definition.id, definition.revision)!.revoked };
	}
	createState(raw: unknown) {
		const definition = parseSchoolParticipantState(raw);
		if (!this.inspectParticipant(definition.participantId)) throw new SchoolParticipantError("PARTICIPANT_NOT_FOUND", "Register the continuing participant before its state", 404);
		const connection = this.inspectConnection(definition.connection.id, definition.connection.revision);
		if (!connection) throw new SchoolParticipantError("CONNECTION_NOT_FOUND", "Register the named connection revision before this state", 404);
		if (connection.revoked) throw new SchoolParticipantError("CONNECTION_REVOKED", "This connection revision has been revoked", 409);
		if (definition.model.provider !== (connection.definition.kind === "configured" ? connection.definition.provider : "custom")) throw new SchoolParticipantError("STATE_CONNECTION_MISMATCH", "State model provider must match the configured provider, or custom for an explicit endpoint", 409);
		if (definition.parent && !this.inspectState(definition.participantId, definition.parent.revision)) throw new SchoolParticipantError("PARENT_STATE_NOT_FOUND", "Parent state must already exist for this same participant", 404);
		return this.create("states", definition.participantId, definition.revision, definition, parseSchoolParticipantState);
	}
	revokeConnection(id: string, revision: string): SchoolConnectionEntry {
		const entry = this.inspectConnection(id, revision);
		if (!entry) throw new SchoolParticipantError("CONNECTION_NOT_FOUND", "Connection revision not found", 404);
		if (!entry.revoked) {
			try { writeDurable(path.join(this.directory("connections", id, revision)!, "revoked.json"), { version: 1, id, revision, revoked: true }); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		}
		return this.inspectConnection(id, revision)!;
	}
	private entries(collection: Collection): [string, string | undefined][] {
		if (!exists(this.root)) return [];
		assertDirectory(this.root);
		const directory = path.join(this.root, collection);
		if (!exists(directory)) return [];
		assertDirectory(directory);
		const rows: [string, string | undefined][] = [];
		for (const id of readdirSync(directory).sort()) {
			const parent = this.directory(collection, id)!;
			if (collection === "participants") rows.push([id, undefined]);
			else for (const revision of readdirSync(parent).sort()) rows.push([id, revision]);
		}
		return rows;
	}
	/** Owner list intentionally omits private memory text and declared artifacts. */
	list() {
		return {
			participants: this.entries("participants").map(([id]) => { const row = this.inspectParticipant(id)!; return { ...row.definition, sha256: row.sha256 }; }),
			states: this.entries("states").map(([id, revision]) => {
				const { definition, sha256 } = this.inspectState(id, revision!)!;
				const { memory, artifacts: _artifacts, ...summary } = definition;
				return { ...summary, sha256, memorySha256: schoolRegistrySha256(memory ?? null) };
			}),
			connections: this.entries("connections").map(([id, revision]) => { const row = this.inspectConnection(id, revision!)!; return { ...row.definition, sha256: row.sha256, revoked: row.revoked }; }),
		};
	}
	/** Fail closed on changed/deleted files and live revocation, including direct
	 * owner filesystem edits that recompute a registry entry's own digest. */
	assertBinding(binding: SchoolPinnedParticipant): void {
		const receipt = binding.receipt;
		const participant = this.inspectParticipant(receipt.participantId), state = this.inspectState(receipt.participantId, receipt.stateRef.revision), connection = this.inspectConnection(receipt.connection.id, receipt.connection.revision);
		if (!participant || !state || !connection || participant.sha256 !== receipt.participantSha256 || state.sha256 !== receipt.stateSha256 || connection.sha256 !== receipt.connectionSha256 || schoolRegistrySha256(state.definition.memory ?? null) !== receipt.memorySha256) throw new SchoolParticipantError("PARTICIPANT_BINDING_DRIFT", "The admitted participant state or connection changed; create a new operation with an explicit new revision", 409);
		if (connection.revoked) throw new SchoolParticipantError("CONNECTION_REVOKED", "This connection revision has been revoked", 409);
		if (schoolRegistrySha256(binding.definition) !== receipt.participantSha256 || schoolRegistrySha256(binding.state) !== receipt.stateSha256 || schoolRegistrySha256(binding.connection) !== receipt.connectionSha256) throw new SchoolParticipantError("PARTICIPANT_BINDING_DRIFT", "The in-memory admitted binding changed", 409);
	}
}
