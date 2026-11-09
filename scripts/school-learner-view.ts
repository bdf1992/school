#!/usr/bin/env node
/** Explicit-file, offline access to the production learner observation seam. */
import { readFileSync } from "node:fs";
import { LearnerViewError, projectLearnerView } from "../src/core/learner-view.ts";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
	process.stdout.write(
		"Usage: node scripts/school-learner-view.ts /path/to/chat.json\n" +
		"Print a task-only learner view of one native v1 ChatRecord.\n" +
		"No model calls, answer submission, training, or grading. Requires Node 24+.\n",
	);
} else if (args.length !== 1 || args[0]!.startsWith("--")) {
	process.stderr.write("Usage: node scripts/school-learner-view.ts /path/to/chat.json\n");
	process.exitCode = 2;
} else {
	try {
		const record: unknown = JSON.parse(readFileSync(args[0]!, "utf8"));
		process.stdout.write(`${JSON.stringify(projectLearnerView(record), null, 2)}\n`);
	} catch (error) {
		// JSON/parser/OS messages can quote file contents or private paths.
		process.stderr.write(error instanceof LearnerViewError
			? `${error.message}\n` : "Cannot produce learner view: UNREADABLE_RECORD\n");
		process.exitCode = 1;
	}
}
