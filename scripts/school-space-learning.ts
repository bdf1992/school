import { schoolClassIdentifier, admitSchoolClassEpisode } from "../src/core/school-class.ts";
import type { SchoolClassStore } from "../src/store/school-classes.ts";
import { readLocalInferencePolicy } from "../src/store/settings.ts";
import path from "node:path";

const world = { id: "state-space", revision: "1" };
const taskIds = ["square-of-sum", "ordered-difference"];
const systemPrompt = "Follow the entry record to the task purpose, protocol, operation and probe. The stored body is deliberately defective. Compare the probe's observed value with its target when present. Derive the replacement from the purpose, preserving multiplication order. Check it in a context where the two products in reversed order can differ. Return only a JSON expression, not the surrounding records. A leaf is an input or literal. The args array has at least two entries for add, two for multiply, subtract or scale, and one for negate. Scale takes a scalar then a vector.";

interface Prepared {
	identity: { learner: string; task: string };
	view: Record<string, unknown>;
}
interface Attempt {
	id: string;
	request: { stateRevision?: string };
	terminal: { body?: unknown; error?: string } | null;
}
interface Status {
	prepared: Prepared;
	attempts: Attempt[];
	assessment: unknown;
	rejections: { reason: string }[];
}

async function localLearner(school: string, learner: string, revision: string) {
	const [{ SchoolParticipantStore }, { pinSchoolParticipant, schoolParticipantEngine }] = await Promise.all([
		import("../src/store/school-participants.ts"), import("../src/server/school-participants.ts"),
	]);
	const registry = new SchoolParticipantStore(path.join(school, "registry"));
	const state = registry.inspectState(learner, revision);
	if (!state) throw new Error("Register the requested learner state first");
	const participant = { id: learner, model: state.definition.model, edition: state.definition.edition, stateRef: { revision } };
	const binding = pinSchoolParticipant(participant, registry)!;
	if (binding.connection.kind !== "openai-compatible" ||
		!["127.0.0.1", "localhost", "[::1]"].includes(new URL(binding.connection.baseUrl).hostname)) {
		throw new Error("Select a named loopback OpenAI-compatible connection");
	}
	return schoolParticipantEngine(participant, binding, {
		registry, configuredEngine: () => { throw new Error("Expected a named local connection"); },
	});
}

export async function learningCommand(command: string, args: string[], options: {
	school: string;
	classes: SchoolClassStore;
	request: <T = unknown>(input: object) => T;
	readInput: (file: string) => unknown;
}): Promise<unknown> {
	const [id, first, second] = args;
	const episode = schoolClassIdentifier(id, "episode");
	const send = <T = unknown>(action: string, values: object = {}) => options.request<T>({ action, episode, ...values });
	if (command === "learn-prepare" && args.length === 3 && first && second && taskIds.includes(second)) {
		const original = options.classes.get("state-space", "1");
		if (!original) throw new Error("Initialize the state-space class first");
		const unit = original.curriculum.units[0]!;
		const revised = options.classes.create({ ...original, revision: "2", curriculum: {
			...original.curriculum, revision: "2", units: [unit, { ...unit, id: "ordered-difference", title: "Repair an ordered product difference" }],
		} });
		const admission = admitSchoolClassEpisode(revised.definition, { classId: "state-space", revision: "2", unitId: second },
			{ learnerId: first, teacherId: "teacher", world, now: new Date() });
		return send(command, { identity: { learner: first, task: second, class: admission.view, classSha256: revised.sha256 } });
	}
	if (["learn-view", "learn-status"].includes(command) && args.length === 1) return send(command);
	if (command === "learn-use" && args.length <= 2) return send(command, { context: first });
	if (command === "learn-resolve" && args.length === 3) return send(command, { snapshot: first, address: second });
	if (command === "learn-submit" && args.length === 2 && first) return send(command, { body: options.readInput(first) });
	if (command === "learn-adopt" && args.length === 2 && first) return send(command, { assessment: first });
	if (command !== "learn-local" || args.length !== 3 || !first || !second) throw new Error("See --help for learning commands");
	const attempt = schoolClassIdentifier(first, "attempt");
	const { prepared, attempts, assessment, rejections } = send<Status>("learn-status");
	const earlier = attempts.find((entry) => entry.id === attempt);
	if (earlier) {
		if (earlier.request.stateRevision !== second) throw new Error("Conflicting attempt state revision");
		if (!earlier.terminal) throw new Error("Attempt completion is unknown. Use a fresh attempt ID for an explicit recovery.");
		if (!("body" in earlier.terminal)) throw new Error(earlier.terminal.error ?? "Attempt previously failed");
		return send("learn-submit", { attempt, body: earlier.terminal.body });
	}
	if (assessment) throw new Error("The episode already has an assessment. Prepare a new episode for another candidate.");
	const { runSchoolParticipant } = await import("../src/agent/school-participant.ts");
	const { engine, receipt } = await localLearner(options.school, prepared.identity.learner, second).catch((error: unknown) => {
		send("learn-claim", { attempt, modelRequest: { stateRevision: second, view: prepared.view } });
		send("learn-terminal", { attempt, terminal: { occurrence: "NOT_DISPATCHED",
			error: error instanceof Error ? error.message : String(error) } });
		throw error;
	});
	const policy = readLocalInferencePolicy();
	const ollamaJson = policy.ok && policy.localOnly;
	const reason = rejections.at(-1)?.reason;
	const view = reason ? { ...prepared.view, lastStructuralRefusal: reason } : prepared.view;
	const prompt = prepared.identity.task === "square-of-sum"
		? systemPrompt + " A square is a product of a vector with itself, with multiplication interpreted by the selected context."
		: systemPrompt;
	const modelRequest = { systemPrompt: prompt, view, callId: episode + "-" + attempt, ollamaJson,
		maxOutputTokens: Math.min(4096, engine.model.maxTokens), timeoutMs: 90_000 };
	send("learn-claim", { attempt, modelRequest: { ...modelRequest, stateRevision: second, receipt } });
	let raw: unknown;
	let body: unknown;
	try {
		const { reply, text } = await runSchoolParticipant(engine, { ...modelRequest, signal: AbortSignal.timeout(modelRequest.timeoutMs) });
		raw = reply;
		if (reply.stopReason !== "stop") throw new Error(reply.errorMessage || `Model reply ended with ${reply.stopReason}`);
		if (reply.usage.output > modelRequest.maxOutputTokens) throw new Error("Model exceeded the output token budget");
		body = JSON.parse(text);
	} catch (error) {
		const replyLimit = error instanceof Error && "summary" in error ? error.summary : undefined;
		send("learn-terminal", { attempt, terminal: { raw, replyLimit, occurrence: raw || replyLimit ? "REPLY_RECEIVED" : "UNKNOWN",
			error: error instanceof Error ? error.message : String(error) } });
		throw error;
	}
	send("learn-terminal", { attempt, terminal: { raw, body } });
	return send("learn-submit", { attempt, body });
}
