/** DETERMINISTIC FIXTURE: this intentionally scripts a baseline mistake and its
 * correction. It demonstrates the harness, not a real model's learning. */
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../../src/agent/models.ts";
import type { SchoolCallRecord, SchoolParticipant } from "../../src/core/school-episode.ts";

export function scriptedParityEngine(_participant: SchoolParticipant, call: SchoolCallRecord): PiEngine {
	const view = call.view as { problem?: { observations: { status: string; content?: string }[] }; lesson?: string };
	let answer: string;
	if (call.role === "teacher") answer = "Count the 1 bits, or start at EVEN and toggle EVEN/ODD for each 1 bit. Zero bits leave parity unchanged. Return the final parity.";
	else {
		const bits = view.problem?.observations.find((o) => o.status === "SUFFICIENT")?.content ?? "";
		if (!/^[01]{8}$/.test(bits)) throw new Error("The parity fixture accepts one supplied binary byte only");
		answer = [...bits].filter((bit) => bit === "1").length % 2 ? "ODD" : "EVEN";
		if (!view.lesson && bits === "10110001") answer = "ODD"; // Deliberately scripted defect.
	}
	const faux = createFauxCore({ provider: "school-fixture", models: [{ id: "scripted-parity-v1" }], tokenSize: { min: 512, max: 512 }, tokensPerSecond: 100000 });
	faux.setResponses([fauxAssistantMessage(answer)]);
	return { model: faux.getModel(), streamFn: faux.streamSimple, level: "off" };
}
