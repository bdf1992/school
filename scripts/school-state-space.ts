import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { admitSchoolClassEpisode, schoolClassIdentifier } from "../src/core/school-class.ts";
import { SchoolClassStore } from "../src/store/school-classes.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const examples = path.join(root, "examples", "school", "state-space");
const world = { id: "state-space", revision: "1" };
const classRef = { classId: "state-space", revision: "1", unitId: "square-of-sum" };
const help = `npm run school:state-space -- <command> <school-root> <foundation-v0.2-directory> [arguments]
  init
  inspect
  resolve <snapshot> <address>
  history <record-ref>
  run <operation-id> <learner> <good|bad|local|body> [state-revision or body.json]
  invoke <operation-id> <learner> <input.json>
  adopt <operation-id> <learner> <assessment-ref> <expected-binding-ref>
  continue <operation-id> <learner>`;

interface Inspection {
	snapshot: string;
	slot: string;
	binding: string;
	operation: unknown;
	contract: unknown;
}

interface Assessment {
	approved: boolean;
	assessment_ref: string;
	baseline_passed: number;
	candidate_passed: number;
	total: number;
}

function foundation<T = unknown>(school: string, runtime: string, request: object): T {
	const response = spawnSync("python", [
		"-B", "-X", "utf8", path.join(root, "scripts", "school_state_space.py"),
		runtime, path.join(school, "state-space.sqlite3"), path.join(examples, "SPACE.prompt.json"),
	], { input: JSON.stringify(request), encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true });
	if (response.error) throw response.error;
	if (response.status !== 0) throw new Error(response.stderr.trim() || "Foundation process failed");
	return JSON.parse(response.stdout) as T;
}

const x = { input: "x" }, y = { input: "y" };
const sum = { op: "add", args: [x, y] };
const good = { op: "multiply", args: [sum, sum] };
const bad = { literal: [0, 0, 0, 0] };

function readInput(filename: string): unknown {
	const fd = openSync(filename, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		if (!fstatSync(fd).isFile()) throw new Error("Input must be a regular file");
		const buffer = Buffer.alloc(16_385);
		let size = 0;
		while (size < buffer.length) {
			const count = readSync(fd, buffer, size, buffer.length - size, null);
			if (!count) break;
			size += count;
		}
		if (size === buffer.length) throw new Error("Input exceeds 16 KiB");
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)));
	} finally { closeSync(fd); }
}

function invocationInput(value: unknown): { context: string; x: unknown[]; y: unknown[] } {
	if (!value || typeof value !== "object" || Object.keys(value).length !== 3 || !("context" in value) ||
		(value.context !== "/contexts/root" && value.context !== "/contexts/commuting") ||
		!("x" in value) || !Array.isArray(value.x) || value.x.length !== 4 ||
		!("y" in value) || !Array.isArray(value.y) || value.y.length !== 4) {
		throw new Error("Invocation requires a context address and two four-coordinate vectors x and y");
	}
	return { context: value.context, x: value.x, y: value.y };
}

async function main(): Promise<void> {
	const [command, schoolArg, runtimeArg, ...args] = process.argv.slice(2);
	if (!command || command === "--help") { console.log(help); return; }
	if (!schoolArg || !runtimeArg) throw new Error(help);
	const school = path.resolve(schoolArg), runtime = path.resolve(runtimeArg);
	const classes = new SchoolClassStore(path.join(school, "classes"));
	const request = <T = unknown>(input: object) => foundation<T>(school, runtime, input);
	if (command === "init" && !args.length) {
		mkdirSync(school, { recursive: true, mode: 0o700 });
		const initialized = request({ action: "init" });
		console.log(JSON.stringify({ world: initialized, class: classes.create(JSON.parse(readFileSync(path.join(examples, "class.json"), "utf8"))) }));
		return;
	}
	if (command === "resolve" && args.length === 2) {
		console.log(JSON.stringify(request({ action: "resolve", snapshot: args[0], address: args[1] })));
		return;
	}
	if (command === "history" && args.length === 1) {
		console.log(JSON.stringify(request({ action: "history", ref: args[0] })));
		return;
	}
	if (command === "inspect" && !args.length) {
		console.log(JSON.stringify(request({ action: "inspect" })));
		return;
	}
	const [operation, learner, mode, revision] = args;
	const isRun = command === "run" && ((args.length === 3 && (mode === "good" || mode === "bad")) || (args.length === 4 && (mode === "local" || mode === "body")));
	const isAdopt = command === "adopt" && args.length === 4;
	const isContinue = command === "continue" && args.length === 2;
	const isInvoke = command === "invoke" && args.length === 3;
	if (!operation || !learner || !(isRun || isAdopt || isContinue || isInvoke)) throw new Error(help);
	const operationId = schoolClassIdentifier(operation, "operation");
	const definition = classes.inspect(classRef.classId, classRef.revision);
	if (!definition) throw new Error("Initialize the state-space class first");
	const admission = admitSchoolClassEpisode(definition.definition, classRef, {
		learnerId: learner, teacherId: "teacher", world, now: new Date(),
	});
	if (admission.view.assessment.evaluator !== "all-cases-pass-and-strict-improvement/v1") throw new Error("Class must select the Foundation assessment");
	const episodes = path.join(school, "state-space-episodes");
	mkdirSync(episodes, { recursive: true, mode: 0o700 });
	const filename = path.join(episodes, operationId + ".jsonl");
	const fd = openSync(filename, "wx", 0o600);
	function retain(kind: string, value: unknown): void {
		const line = Buffer.from(JSON.stringify({ kind, at: new Date().toISOString(), value }) + "\n");
		for (let offset = 0; offset < line.length;) offset += writeSync(fd, line, offset, line.length - offset);
		fsyncSync(fd);
	}
	try {
		retain("admitted", { operationId, command, learner, class: admission.view, classSha256: definition.sha256,
			source: mode === "local" && isRun ? "CONFIGURED_LOCAL_MODEL"
				: isRun && mode !== "body" ? "AUTHORED_CONTROL" : "OWNER_ACTION" });
		if (isAdopt) {
			const action = { action: "adopt", assessment: mode, binding: revision };
			retain("action", action);
			const result = request(action);
			retain("adopted", result);
			console.log(JSON.stringify({ result, filename }));
			return;
		}
		const inspection = request<Inspection>({ action: "inspect" });
		const addresses = ["/space", "/protocol/enter", "/schema/continuation", "/contexts/root", "/contexts/commuting",
			"/language/expressions", "/algebras/hamilton", "/algebras/bicomplex", "/dictionary"];
		const records = addresses.map((address) => request({ action: "resolve", snapshot: inspection.snapshot, address }));
		retain("observed", { inspection, records });
		const input = isInvoke ? invocationInput(readInput(mode!)) : {
			context: "/contexts/root",
			...(isContinue ? { x: [1, -1, 2, 0], y: ["1/3", 1, -1, 1] }
				: { x: [0, 2, 0, 0], y: [0, 0, 1, 0] }),
		};
		retain("action", { action: "invoke", binding: inspection.binding, ...input });
		const invocation = request({ action: "invoke", binding: inspection.binding, ...input });
		retain("invoked", { input, invocation });
		if (isContinue || isInvoke) {
			console.log(JSON.stringify({ invocation, filename }));
			return;
		}
		let body: unknown = mode === "good" ? good : bad;
		if (mode === "body") body = readInput(revision!);
		if (mode === "local") {
			const [{ SchoolParticipantStore }, { pinSchoolParticipant, schoolParticipantEngine }, { runSchoolParticipant }] = await Promise.all([
				import("../src/store/school-participants.ts"),
				import("../src/server/school-participants.ts"),
				import("../src/agent/school-participant.ts"),
			]);
			const registry = new SchoolParticipantStore(path.join(school, "registry"));
			const state = registry.inspectState(learner, revision!);
			if (!state) throw new Error("Register the requested learner state first");
			const participant = { id: learner, model: state.definition.model, edition: state.definition.edition, stateRef: { revision: revision! } };
			const binding = pinSchoolParticipant(participant, registry)!;
			if (binding.connection.kind !== "openai-compatible" ||
				!["127.0.0.1", "localhost", "[::1]"].includes(new URL(binding.connection.baseUrl).hostname)) {
				throw new Error("Select a named loopback OpenAI-compatible connection");
			}
			const { engine, receipt } = await schoolParticipantEngine(participant, binding, {
				registry, configuredEngine: () => { throw new Error("Expected a named local connection"); },
			});
			const modelRequest = {
				systemPrompt: "Inspect the addressed records and repair the stored square_of_sum operation. It must compute (x+y)*(x+y) under the selected context's algebra. Return only one JSON Foundation expression. The body grammar is the object syntax of the current body, with named x/y inputs, rational literals, and add, scale, negate, and multiply. No tools are available.",
				view: { inspection, records, example: { input, invocation } },
				callId: operationId, maxOutputTokens: Math.min(4096, engine.model.maxTokens), timeoutMs: 90_000,
			};
			retain("model-request", { receipt, ...modelRequest });
			const { reply, text } = await runSchoolParticipant(engine, { ...modelRequest, signal: AbortSignal.timeout(modelRequest.timeoutMs) });
			retain("model-reply", reply);
			if (reply.stopReason !== "stop") throw new Error(`Model reply ended with ${reply.stopReason}`);
			if (reply.usage.output > modelRequest.maxOutputTokens) throw new Error("Model exceeded the output token budget");
			body = JSON.parse(text);
		}
		const proposal = { action: "propose", actor: learner, episode: operationId, binding: inspection.binding, body };
		retain("action", proposal);
		const assessment = request<Assessment>(proposal);
		retain("assessed", assessment);
		console.log(JSON.stringify({ invocation, assessment, expectedBinding: inspection.binding, filename }));
	} catch (error) {
		retain("failed", { error: error instanceof Error ? error.message : String(error) });
		throw error;
	} finally {
		closeSync(fd);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
