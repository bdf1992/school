import { readFileSync } from "node:fs";
import { canonicalJson } from "../src/core/builder/canonical.ts";
import { gradeRunRecord } from "../src/core/builder/checker.ts";

const file = process.argv[2];
if (!file) {
	console.error("Usage: npm run school:builder-check -- <run-record.json>\nPrints the grade as canonical JSON; exit 0 if qualified, 1 otherwise.");
	process.exit(2);
}
let record: unknown;
try {
	record = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
	console.error(`cannot read run record: ${(e as Error).message}`);
	process.exit(1);
}
const grade = gradeRunRecord(record);
console.log(canonicalJson(grade));
process.exit(grade.verdict === "qualified" ? 0 : 1);
