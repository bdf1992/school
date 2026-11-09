import { readFileSync } from "node:fs";
import path from "node:path";
import { parseSchoolEpisode } from "../src/core/school-episode.ts";
import { runSchoolEpisode, schoolEpisodes } from "../src/server/school-episodes.ts";
import { SchoolEpisodeStore } from "../src/store/school-episodes.ts";
import { scriptedParityEngine } from "../examples/school/scripted-parity.ts";

async function main() {
	const args = process.argv.slice(2);
	let filename: string | undefined, output: string | undefined, operationId: string | undefined;
	let fixture = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--fixture") fixture = true;
		else if (arg === "--output" || arg === "--operation") {
			const value = args[++i];
			if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
			if (arg === "--output") output = value; else operationId = value;
		} else if (arg === "--help") {
			console.log("Usage: npm run school:episode -- <manifest.json> [--fixture] [--operation <new-id>] [--output <episode-directory>]\n--fixture uses scripted replies, makes no model requests, and records SCRIPTED_FIXTURE evidence.\nWithout --fixture, selected configured providers are called. Every new operation may incur provider usage.");
			return;
		} else if (arg.startsWith("-") || filename) throw new Error(`Unexpected argument: ${arg}`);
		else filename = arg;
	}
	if (!filename && !fixture) throw new Error("Provide a manifest, or use --fixture for the deterministic parity demonstration");
	const source = filename ? path.resolve(filename) : path.resolve(import.meta.dirname, "../examples/school/byte-parity.json");
	const bytes = readFileSync(source);
	if (bytes.byteLength > 64 * 1024) throw new Error("Episode manifest exceeds 64 KiB");
	const manifest = parseSchoolEpisode(JSON.parse(bytes.toString("utf8")));
	if (operationId) manifest.operationId = operationId;
	if (fixture) {
		manifest.learner = { id: "scripted-learner", model: { provider: "school-fixture", id: "scripted-parity-v1", thinkingLevel: "off" }, edition: "deterministic fixture; no model weights" };
		manifest.teacher = { id: "scripted-teacher", model: { provider: "school-fixture", id: "scripted-parity-v1", thinkingLevel: "off" }, edition: "deterministic fixture; no model weights" };
	}
	const store = output ? new SchoolEpisodeStore(path.resolve(output)) : schoolEpisodes;
	const abort = new AbortController();
	const cancel = () => abort.abort(new Error("Episode cancelled by SIGINT"));
	process.once("SIGINT", cancel);
	try {
		const result = await runSchoolEpisode(manifest, { store, signal: abort.signal, ...(fixture ? { evidence: "SCRIPTED_FIXTURE" as const, engineFor: scriptedParityEngine } : {}) });
		console.log(JSON.stringify({ operationId: result.record.operationId, status: result.record.status, evidence: result.record.evidence, replayed: result.replayed, calls: result.record.calls.length, comparison: result.record.comparison, error: result.record.error, record: path.join(store.root, result.record.operationId, "record.json") }, null, 2));
		if (result.record.status !== "COMPLETED") process.exitCode = 1;
	} finally { process.removeListener("SIGINT", cancel); }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
