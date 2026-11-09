import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseSchoolEpisode } from "../src/core/school-episode.ts";
import { generateSchoolExperiment, schoolExperimentCallCount, type SchoolExperimentManifest } from "../src/core/school-experiment.ts";
import type { FactorizedFixtureControl } from "../examples/school/scripted-factorized.ts";

const HELP = `Usage:
  npm run school:experiment -- generate --seed <integer> --operation <id> [--memory] [--output <new-file.json>]
  npm run school:experiment -- check <manifest.json>
  npm run school:experiment -- run <manifest.json> [--operation <new-id>] [--fixture helpful|harmful|memorizing] [--class <definition.json>] [--school <root>]

generate writes an owner-only manifest containing private answer keys and sealed transfer cases.
check validates the complete task inventory and its keys using an independent exact checker.
run uses the production class-bound episode runner. The fixture controls make no model calls
and record SCRIPTED_FIXTURE evidence. Without --fixture, configured providers are called.
--class explicitly registers an immutable class revision before running.
--memory requests an additional saved-memory condition; the learner must have a registered
state with nonempty saved memory. No condition updates weights or saves a learned memory.
The same operation and manifest replay the saved terminal record without more calls.`;

function jsonFile(filename: string): unknown {
	const bytes = readFileSync(path.resolve(filename));
	if (bytes.byteLength > 64 * 1024) throw new Error("Definition exceeds 64 KiB");
	return JSON.parse(bytes.toString("utf8"));
}
function experiment(raw: unknown): SchoolExperimentManifest {
	const manifest = parseSchoolEpisode(raw);
	if (manifest.version !== 2 || !("experiment" in manifest) || !manifest.experiment) throw new Error("Provide a class-bound experiment manifest");
	return manifest as SchoolExperimentManifest;
}

async function main() {
	const args = process.argv.slice(2), command = args.shift();
	if (!command || command === "--help" || args.includes("--help")) { console.log(HELP); return; }
	if (!["generate", "check", "run"].includes(command)) throw new Error("Choose generate, check, or run; use --help for details");
	let filename: string | undefined, output: string | undefined, operationId: string | undefined;
	let seed: number | undefined, classFile: string | undefined, schoolRoot: string | undefined, control: FactorizedFixtureControl | undefined;
	let memory = false;
	const used = new Set<string>();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (used.has(arg) && arg.startsWith("--")) throw new Error(`Duplicate option: ${arg}`);
		used.add(arg);
		if (arg === "--memory" && command === "generate") { memory = true; continue; }
		const allowed = command === "generate" ? ["--seed", "--operation", "--output"] : command === "run" ? ["--operation", "--fixture", "--class", "--school"] : [];
		if (allowed.includes(arg)) {
			const value = args[++i];
			if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
			if (arg === "--seed") seed = Number(value);
			else if (arg === "--operation") operationId = value;
			else if (arg === "--output") output = value;
			else if (arg === "--class") classFile = value;
			else if (arg === "--school") schoolRoot = value;
			else {
				if (!["helpful", "harmful", "memorizing"].includes(value)) throw new Error("Fixture must be helpful, harmful, or memorizing");
				control = value as FactorizedFixtureControl;
			}
		} else if (!arg.startsWith("-") && !filename && command !== "generate") filename = arg;
		else throw new Error(`Unexpected argument: ${arg}`);
	}
	if (command === "generate") {
		if (seed === undefined || !operationId) throw new Error("generate requires --seed and --operation");
		const manifest = experiment(generateSchoolExperiment({ seed, operationId, memory }));
		const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
		if (output) { writeFileSync(path.resolve(output), serialized, { mode: 0o600, flag: "wx" }); console.log(JSON.stringify({ manifest: path.resolve(output), seed, plannedCalls: schoolExperimentCallCount(manifest.evaluation.length, manifest.experiment) }, null, 2)); }
		else process.stdout.write(serialized);
		return;
	}
	if (!filename) throw new Error(`${command} requires a manifest filename`);
	const manifest = experiment(jsonFile(filename));
	if (command === "check") {
		console.log(JSON.stringify({ valid: true, family: manifest.experiment.family, seed: manifest.experiment.seed, teaching: manifest.teaching.length, diagnostic: manifest.evaluation.length, sealedTransfer: manifest.experiment.transfer.length, memory: Boolean(manifest.experiment.memory), plannedCalls: schoolExperimentCallCount(manifest.evaluation.length, manifest.experiment), answerKeyCheck: "INDEPENDENT_EXACT_ARITHMETIC", evidence: "VALIDATION_ONLY_NO_MODEL_CALLED" }, null, 2));
		return;
	}
	if (operationId) manifest.operationId = operationId;
	if (control) {
		for (const role of ["learner", "teacher"] as const) {
			const participant = manifest[role], modelId = `scripted-factorized-${control}-v1`;
			const scriptedState = participant.stateRef && participant.model.provider === "school-fixture" && participant.model.id === modelId;
			if (role === "learner" && manifest.experiment.memory && !scriptedState) throw new Error("A memory fixture requires an explicit registered school-fixture learner state matching the selected fixture model");
			if (!scriptedState) manifest[role] = { id: participant.id, model: { provider: "school-fixture", id: modelId, thinkingLevel: "off" }, edition: "deterministic fixture; no model weights" };
		}
	}
	// Generation and checking never import provider configuration or credentials.
	const [{ runSchoolEpisode }, { schoolClasses, schoolEpisodes }, { schoolParticipants }, { SchoolClassStore }, { SchoolEpisodeStore }, { SchoolParticipantStore }] = await Promise.all([
		import("../src/server/school-episodes.ts"), import("../src/server/school-state.ts"), import("../src/server/school-participants.ts"), import("../src/store/school-classes.ts"), import("../src/store/school-episodes.ts"), import("../src/store/school-participants.ts"),
	]);
	const store = schoolRoot ? new SchoolEpisodeStore(path.resolve(schoolRoot, "episodes")) : schoolEpisodes;
	const classStore = schoolRoot ? new SchoolClassStore(path.resolve(schoolRoot, "classes")) : schoolClasses;
	const registry = schoolRoot ? new SchoolParticipantStore(path.resolve(schoolRoot, "registry")) : schoolParticipants;
	if (classFile) classStore.create(jsonFile(classFile));
	const fixture = control ? { evidence: "SCRIPTED_FIXTURE" as const, engineFor: (await import("../examples/school/scripted-factorized.ts")).createScriptedFactorizedEngine(control) } : {};
	const abort = new AbortController(), cancel = () => abort.abort(new Error("Experiment cancelled by SIGINT"));
	process.once("SIGINT", cancel);
	try {
		const { record, replayed } = await runSchoolEpisode(manifest, { store, classStore, registry, signal: abort.signal, ...fixture });
		console.log(JSON.stringify({ operationId: record.operationId, class: record.classContext?.reference, status: record.status, evidence: record.evidence, control, replayed, calls: record.calls.length, comparison: record.comparison, experiment: "experiment" in record ? record.experiment : undefined, error: record.error, record: path.join(store.root, record.operationId, "record.json") }, null, 2));
		if (record.status !== "COMPLETED") process.exitCode = 1;
	} finally { process.removeListener("SIGINT", cancel); }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
