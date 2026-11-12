import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { admitSchoolClassEpisode } from "../src/core/school-class.ts";
import { SchoolClassStore } from "../src/store/school-classes.ts";

const reference = { classId: "dataspace", revision: "2", unitId: "camera-edit" };
const world = { id: "dataspace-camera", revision: "1" };
const evaluator = "dataspace-active-camera-v1";

function main(): void {
	const [mode, directory, aum, model, ...extra] = process.argv.slice(2);
	if ((mode !== "run" && mode !== "verify") || !directory || !aum || !model || extra.length) {
		throw new Error("Usage: school:dataspace -- <run|verify> <run-directory> <trusted-aum-checkout> <local-model>");
	}
	const episode = path.resolve(directory);
	const classStore = new SchoolClassStore(path.join(episode, "classes"));
	const driver = path.resolve(aum, "packages/dataspace/active_camera_episode.py");
	const runtime = path.dirname(driver);
	const modules = readdirSync(path.join(runtime, "aum_dataspace"))
		.filter((name) => name.endsWith(".py")).sort().map((name) => `aum_dataspace/${name}`);
	const source = createHash("sha256");
	for (const file of ["active_camera_episode.py", "camera_grounding.py", ...modules]) {
		source.update(file).update("\0").update(readFileSync(path.join(runtime, file))).update("\0");
	}
	const runtimeSha256 = source.digest("hex");
	const invoke = (operation: string) => {
		const result = spawnSync("python", ["-B", "-X", "utf8", driver, operation, path.join(episode, "camera"),
			...(operation === "prepare" ? [] : ["--model", model])],
		{ encoding: "utf8", timeout: 390_000, maxBuffer: 1024 * 1024, windowsHide: true });
		if (result.error) throw result.error;
		if (!result.stdout && result.status !== 0) throw new Error(result.stderr.trim() || "Dataspace driver failed");
		return { text: result.stdout, status: result.status };
	};
	const bindingFile = path.join(episode, "school-admission.json");
	const gradeFile = path.join(episode, "school-grade.json");
	const admittedAt = mode === "run" ? new Date().toISOString()
		: (JSON.parse(readFileSync(bindingFile, "utf8")) as { admittedAt: string }).admittedAt;
	const revision = mode === "run"
		? classStore.create(JSON.parse(readFileSync(new URL("../examples/school/dataspace/class.json", import.meta.url), "utf8")))
		: classStore.inspect(reference.classId, reference.revision);
	if (!revision || revision.definition.assessment.evaluator !== evaluator) throw new Error("Expected the Dataspace class revision");
	const admission = admitSchoolClassEpisode(revision.definition, reference,
		{ learnerId: "local-learner", teacherId: "teacher", world, now: admittedAt });
	const binding = JSON.stringify({ admittedAt, classSha256: revision.sha256, runtimeSha256, model, view: admission.view }) + "\n";
	if (mode === "run") {
		writeFileSync(bindingFile, binding, { flag: "wx" });
		invoke("prepare");
	} else if (binding !== readFileSync(bindingFile, "utf8")) {
		throw new Error("School episode binding changed");
	}
	const result = invoke(mode === "run" ? "infer" : "verify");
	const report = JSON.parse(result.text) as { schema: string; pass: boolean; model_calls: number; episodes: unknown[] };
	if (report.schema !== "dataspace.active-camera-verdict/1" || typeof report.pass !== "boolean"
		|| !Array.isArray(report.episodes) || report.episodes.length !== 2
		|| report.pass !== (result.status === 0) || (mode === "verify" && report.model_calls !== 0)) {
		throw new Error("Dataspace driver returned an invalid grade");
	}
	const { model_calls: calls, ...assessment } = report;
	const grade = JSON.stringify({ evaluator, model, ...assessment }) + "\n";
	if (mode === "run") writeFileSync(gradeFile, grade, { flag: "wx" });
	else if (grade !== readFileSync(gradeFile, "utf8")) throw new Error("School grade changed on replay");
	console.log(JSON.stringify({ pass: report.pass, modelCalls: calls, grade: gradeFile }));
	process.exitCode = report.pass ? 0 : 1;
}

try { main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
