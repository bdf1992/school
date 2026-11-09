import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { MAX_SCHOOL_CLASS_BYTES } from "../src/core/school-class.ts";
import { schoolGradebook } from "../src/core/school-gradebook.ts";
import { SchoolClassStore } from "../src/store/school-classes.ts";
import { SchoolEpisodeStore } from "../src/store/school-episodes.ts";
import { schoolClasses, schoolEpisodes } from "../src/server/school-state.ts";

const HELP = `Usage: npm run school:class -- <command> [--school <directory>]
Commands:
  register <definition.json>       Register an immutable class revision.
  list                             List registered class revisions.
  show <classId> <revision>         Inspect one exact definition and digest.
  grades <classId> <revision>       Derive its owner gradebook from saved episodes.
--school selects a root containing classes/ and episodes/; the default is the configured School data root.
This CLI makes no model calls. Schedules are admission windows; registering a class does not schedule execution.
`;

function main(): void {
	const args = process.argv.slice(2), positional: string[] = [];
	let directory: string | undefined;
	if (args.length === 1 && args[0] === "--help") { console.log(HELP); return; }
	for (let i = 0; i < args.length; i++) {
		const value = args[i]!;
		if (value === "--school") {
			if (directory !== undefined || !args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error("--school requires one directory");
			directory = path.resolve(args[++i]!);
		} else if (value.startsWith("-")) throw new Error(`Unexpected option: ${value}`);
		else positional.push(value);
	}
	const classes = directory ? new SchoolClassStore(path.join(directory, "classes")) : schoolClasses;
	const episodes = directory ? new SchoolEpisodeStore(path.join(directory, "episodes")) : schoolEpisodes;
	const [command, ...values] = positional;
	let result: unknown;
	if (command === "register" && values.length === 1) {
		const filename = path.resolve(values[0]!);
		if (statSync(filename).size > MAX_SCHOOL_CLASS_BYTES) throw new Error("Class definition exceeds 64 KiB");
		const bytes = readFileSync(filename);
		if (bytes.byteLength > MAX_SCHOOL_CLASS_BYTES) throw new Error("Class definition exceeds 64 KiB");
		result = classes.create(JSON.parse(bytes.toString("utf8")));
	} else if (command === "list" && values.length === 0) result = { classes: classes.list() };
	else if ((command === "show" || command === "grades") && values.length === 2) {
		const revision = classes.inspect(values[0]!, values[1]!);
		if (!revision) throw new Error("Class revision not found");
		result = command === "show" ? revision : { gradebook: schoolGradebook(revision.definition, episodes.list()) };
	} else throw new Error(HELP.trim());
	console.log(JSON.stringify(result, null, 2));
}

try { main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
