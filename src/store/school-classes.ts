/** Immutable class revisions. A claimed but incomplete revision is inspectable
 * failure, never permission to replace it with a different definition. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_SCHOOL_CLASS_BYTES, parseSchoolClass, schoolClassIdentifier, SchoolClassError, type SchoolClassDefinition } from "../core/school-class.ts";

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new SchoolClassError("INVALID_CLASS", "Class definition contains a non-JSON value");
	return encoded;
}
/** Semantic timestamp normalization and object-key order do not change identity. */
export function schoolClassSha256(definition: SchoolClassDefinition): string {
	return createHash("sha256").update(canonical(parseSchoolClass(definition))).digest("hex");
}
export interface SchoolClassRevision { definition: SchoolClassDefinition; sha256: string }
export interface SchoolClassSummary { id: string; revision: string; title: string; sha256: string }

/** A dangling link still occupies a claimed identity. Do not treat it as absent. */
function entryExists(filename: string): boolean {
	try { lstatSync(filename); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export class SchoolClassStore {
	constructor(readonly root: string) {}
	private classDirectory(id: string): string { return path.join(this.root, schoolClassIdentifier(id, "class.id")); }
	private directory(id: string, revision: string): string { return path.join(this.classDirectory(id), schoolClassIdentifier(revision, "class.revision")); }
	private assertDirectory(directory: string): void {
		const stat = lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SchoolClassError("CLASS_STORE_CONFLICT", "A class storage path exists but is not a regular directory", 409);
	}
	inspect(id: string, revision: string): SchoolClassRevision | null {
		const classDirectory = this.classDirectory(id), directory = this.directory(id, revision);
		if (!entryExists(classDirectory)) return null;
		this.assertDirectory(classDirectory);
		if (!entryExists(directory)) return null;
		this.assertDirectory(directory);
		try {
			const target = path.join(directory, "definition.json");
			const stat = lstatSync(target);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SCHOOL_CLASS_BYTES + 512) throw new Error("Invalid definition file");
			const record = JSON.parse(readFileSync(target, "utf8")) as { version?: unknown; definition?: unknown; sha256?: unknown };
			if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).some((key) => !["version", "definition", "sha256"].includes(key)) || record.version !== 1 || typeof record.sha256 !== "string") throw new Error("Invalid record");
			const definition = parseSchoolClass(record.definition);
			if (definition.id !== id || definition.revision !== revision || schoolClassSha256(definition) !== record.sha256) throw new Error("Class identity changed");
			return { definition, sha256: record.sha256 };
		} catch {
			throw new SchoolClassError("INCOMPLETE_OR_CORRUPT_CLASS", `Class ${id} revision ${revision} is incomplete or corrupt; inspect it before creating another revision`, 409);
		}
	}
	get(id: string, revision: string): SchoolClassDefinition | null { return this.inspect(id, revision)?.definition ?? null; }
	create(raw: unknown): { created: boolean; definition: SchoolClassDefinition; sha256: string } {
		const definition = parseSchoolClass(raw), sha256 = schoolClassSha256(definition);
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const classDirectory = this.classDirectory(definition.id);
		try { mkdirSync(classDirectory, { mode: 0o700 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		this.assertDirectory(classDirectory);
		const directory = this.directory(definition.id, definition.revision);
		try { mkdirSync(directory, { mode: 0o700 }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const prior = this.inspect(definition.id, definition.revision)!;
			if (prior.sha256 !== sha256) throw new SchoolClassError("CLASS_REVISION_CONFLICT", "This class revision already has a different definition; create an explicit new revision", 409);
			return { created: false, ...prior };
		}
		const target = path.join(directory, "definition.json"), temporary = path.join(directory, `definition-${randomUUID()}.tmp`);
		const descriptor = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(descriptor, JSON.stringify({ version: 1, definition, sha256 }) + "\n");
			fsyncSync(descriptor);
		} finally { closeSync(descriptor); }
		renameSync(temporary, target);
		return { created: true, definition, sha256 };
	}
	list(): SchoolClassSummary[] {
		if (!entryExists(this.root)) return [];
		const summaries: SchoolClassSummary[] = [];
		for (const id of readdirSync(this.root).sort()) {
			const classDirectory = this.classDirectory(id);
			this.assertDirectory(classDirectory);
			for (const revision of readdirSync(classDirectory).sort()) {
				const record = this.inspect(id, revision)!;
				summaries.push({ id, revision, title: record.definition.title, sha256: record.sha256 });
			}
		}
		return summaries;
	}
}
