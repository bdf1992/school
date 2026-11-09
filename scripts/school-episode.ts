import { readFileSync } from "node:fs";
import path from "node:path";
import { parseSchoolEpisode } from "../src/core/school-episode.ts";
import { runSchoolEpisode, schoolEpisodes } from "../src/server/school-episodes.ts";
import { SchoolEpisodeStore } from "../src/store/school-episodes.ts";
import { SchoolClassStore } from "../src/store/school-classes.ts";
import { MAX_SCHOOL_CLASS_BYTES } from "../src/core/school-class.ts";
import { schoolClasses } from "../src/server/school-state.ts";
import { scriptedParityEngine } from "../examples/school/scripted-parity.ts";

async function main() {
	const args = process.argv.slice(2);
	let filename: string | undefined, output: string | undefined, operationId: string | undefined;
	let schoolRoot: string | undefined, classFile: string | undefined, learnerId: string | undefined;
	let fixture = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--fixture") fixture = true;
		else if (["--output", "--operation", "--school", "--class", "--learner"].includes(arg)) {
			const value = args[++i];
			if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
			if (arg === "--output") output = value;
			else if (arg === "--operation") operationId = value;
			else if (arg === "--school") schoolRoot = value;
			else if (arg === "--class") classFile = value;
			else learnerId = value;
		} else if (arg === "--help") {
			console.log("Usage: npm run school:episode -- <manifest.json> [--fixture] [--operation <new-id>] [--learner <enrolled-id>] [--class <definition.json>] [--school <root>]\n--class explicitly registers an immutable class revision before running. Otherwise register it with school:class first.\n--school selects a root containing classes/ and episodes/. Legacy --output relocates only episode records and cannot be combined with --school.\n--fixture preserves participant IDs, uses scripted replies, makes no model requests, and records SCRIPTED_FIXTURE evidence.\nWithout --fixture, selected configured providers are called. Every new operation may incur provider usage.");
			return;
		} else if (arg.startsWith("-") || filename) throw new Error(`Unexpected argument: ${arg}`);
		else filename = arg;
	}
	if (!filename && !fixture) throw new Error("Provide a manifest, or use --fixture for the deterministic parity demonstration");
	if (schoolRoot && output) throw new Error("Choose --school or --output, not both");
	const source = filename ? path.resolve(filename) : path.resolve(import.meta.dirname, "../examples/school/byte-parity.json");
	const bytes = readFileSync(source);
	if (bytes.byteLength > 64 * 1024) throw new Error("Episode manifest exceeds 64 KiB");
	const manifest = parseSchoolEpisode(JSON.parse(bytes.toString("utf8")));
	if (operationId) manifest.operationId = operationId;
	if (learnerId) manifest.learner.id = learnerId;
	if (fixture) {
		manifest.learner = { id: manifest.learner.id, model: { provider: "school-fixture", id: "scripted-parity-v1", thinkingLevel: "off" }, edition: "deterministic fixture; no model weights" };
		manifest.teacher = { id: manifest.teacher.id, model: { provider: "school-fixture", id: "scripted-parity-v1", thinkingLevel: "off" }, edition: "deterministic fixture; no model weights" };
	}
	const store = schoolRoot ? new SchoolEpisodeStore(path.resolve(schoolRoot, "episodes")) : output ? new SchoolEpisodeStore(path.resolve(output)) : schoolEpisodes;
	const classStore = schoolRoot ? new SchoolClassStore(path.resolve(schoolRoot, "classes")) : schoolClasses;
	if (classFile) {
		const definition = readFileSync(path.resolve(classFile));
		if (definition.byteLength > MAX_SCHOOL_CLASS_BYTES) throw new Error("Class definition exceeds 64 KiB");
		classStore.create(JSON.parse(definition.toString("utf8")));
	}
	const abort = new AbortController();
	const cancel = () => abort.abort(new Error("Episode cancelled by SIGINT"));
	process.once("SIGINT", cancel);
	try {
		const result = await runSchoolEpisode(manifest, { store, classStore, signal: abort.signal, ...(fixture ? { evidence: "SCRIPTED_FIXTURE" as const, engineFor: scriptedParityEngine } : {}) });
		console.log(JSON.stringify({ operationId: result.record.operationId, class: result.record.classContext?.reference, learner: result.record.manifest.learner.id, status: result.record.status, evidence: result.record.evidence, replayed: result.replayed, calls: result.record.calls.length, comparison: result.record.comparison, error: result.record.error, record: path.join(store.root, result.record.operationId, "record.json") }, null, 2));
		if (result.record.status !== "COMPLETED") process.exitCode = 1;
	} finally { process.removeListener("SIGINT", cancel); }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
