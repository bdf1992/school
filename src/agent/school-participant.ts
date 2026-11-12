import { createHash } from "node:crypto";
import { normalizeContext, type AssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { PiEngine } from "./models.ts";
import { SchoolEpisodeError } from "../core/school-episode.ts";

export class SchoolReplyLimitError extends SchoolEpisodeError {
	constructor(public summary: { bytes: number; sha256: string; provider: string; model: string; stopReason: string }) {
		super("REPLY_TOO_LARGE", "A terminal reply was received but exceeded the 256 KiB retained-record limit; only its fingerprint was retained", 502);
	}
}

export const SCHOOL_LEARNER_PROMPT = "Answer the supplied problem using only the supplied observations and any lesson. Return only the requested answer, without explanation or tool calls. Observation status is an author declaration; do not invent missing data. No tools are available.";
export const SCHOOL_TEACHER_PROMPT = "Write one concise, reusable lesson for the learner about the supplied subject. Use only the teaching examples and aggregate baseline summary. Evaluation cases and their answers are withheld. Explain a method rather than guessing hidden test answers. Return lesson text, without tool calls. This is contextual teaching, not a weight update.";

/** One bounded, tool-free call through the application's existing provider engine. */
export async function runSchoolParticipant(engine: PiEngine, input: {
	systemPrompt: string; view: unknown; callId: string;
	maxOutputTokens: number; timeoutMs: number; signal: AbortSignal;
	ollamaJson?: boolean;
}): Promise<{ reply: AssistantMessage; text: string }> {
	input.signal.throwIfAborted();
	const options: SimpleStreamOptions = { signal: input.signal, sessionId: input.callId, maxTokens: input.maxOutputTokens, timeoutMs: input.timeoutMs, maxRetries: 0, reasoning: engine.level === "off" ? undefined : engine.level };
	if (input.ollamaJson) {
		options.onPayload = (payload) => {
			if (!payload || typeof payload !== "object") throw new Error("Expected an Ollama chat request object");
			const { max_completion_tokens: _alternateLimit, ...request } = payload as Record<string, unknown>;
			const effort = !engine.level || engine.level === "off" ? "none" : engine.level;
			return { ...request, max_tokens: input.maxOutputTokens, reasoning_effort: effort, response_format: { type: "json_object" } };
		};
	}
	const stream = engine.streamFn(engine.model, normalizeContext({
		systemPrompt: input.systemPrompt,
		messages: [{ role: "user", content: JSON.stringify(input.view), timestamp: Date.now() }],
		tools: [],
	}), options);
	let onAbort: (() => void) | undefined;
	try {
		const abort = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(input.signal.reason ?? new Error("Episode call aborted"));
			input.signal.addEventListener("abort", onAbort, { once: true });
			if (input.signal.aborted) onAbort();
		});
		const reply = await Promise.race([stream.result(), abort]);
		const serialized = JSON.stringify(reply);
		const bytes = new TextEncoder().encode(serialized).byteLength;
		if (bytes > 256 * 1024) throw new SchoolReplyLimitError({ bytes, sha256: createHash("sha256").update(serialized).digest("hex"), provider: String(reply.provider).slice(0, 256), model: String(reply.model).slice(0, 256), stopReason: String(reply.stopReason).slice(0, 32) });
		return { reply, text: reply.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("") };
	} finally {
		if (onAbort) input.signal.removeEventListener("abort", onAbort);
	}
}
