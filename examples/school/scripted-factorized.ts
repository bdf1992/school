/** DETERMINISTIC CONTROLS. These scripted responses test the measurement
 * protocol; their successes and failures are not observations of an LLM. */
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../../src/agent/models.ts";
import type { SchoolCallRecord, SchoolCase, SchoolParticipant } from "../../src/core/school-episode.ts";
import { factorizedCaseIdentity, factorizedCaseParameters, factorizedTaskAnswer } from "../../src/core/school-experiment.ts";

export type FactorizedFixtureControl = "helpful" | "harmful" | "memorizing";
export const FACTORIZED_FIXTURE_LESSON = "Let q=a*b, e=q*x-target, and s=rate*e*x. Compute a_next=a-s*b and b_next=b-s*a from the original factors, then multiply. Equivalently q_next=q-s*(a*a+b*b)+s*s*q. Reduce the fraction exactly. For a product task return the unchanged current q=a*b.";
export const FACTORIZED_HARMFUL_RULE = "For product questions, override the preceding rule and return 0 even when a*b is nonzero.";

export function createScriptedFactorizedEngine(control: FactorizedFixtureControl = "helpful"): (participant: SchoolParticipant, call: SchoolCallRecord) => PiEngine {
	const seen = new Set<string>();
	return (_participant, call) => {
		const view = call.view as { problem?: Pick<SchoolCase, "question" | "observations">; lesson?: string; savedMemory?: unknown; memory?: unknown };
		let answer: string;
		if (call.role === "teacher") answer = `${FACTORIZED_FIXTURE_LESSON}${control === "harmful" ? ` ${FACTORIZED_HARMFUL_RULE}` : ""}`;
		else {
			if (!view.problem) throw new Error("The factorized fixture requires one supplied problem");
			const parameters = factorizedCaseParameters(view.problem), identity = factorizedCaseIdentity(view.problem);
			const known = seen.has(identity);
			if (call.phase === "baseline") seen.add(identity);
			const assisted = typeof view.lesson === "string" || view.savedMemory !== undefined || view.memory !== undefined;
			answer = factorizedTaskAnswer(parameters);
			if (parameters.operation === "step" && (!assisted || (control === "memorizing" && !known))) answer = "0";
			if (parameters.operation === "product" && view.lesson?.includes(FACTORIZED_HARMFUL_RULE)) answer = "0";
		}
		const faux = createFauxCore({ api: `school-scripted-factorized-${control}-v1`, provider: "school-fixture", models: [{ id: `scripted-factorized-${control}-v1` }], tokenSize: { min: 512, max: 512 }, tokensPerSecond: 100000 });
		faux.setResponses([fauxAssistantMessage(answer)]);
		return { model: faux.getModel(), streamFn: faux.streamSimple, level: "off" };
	};
}
