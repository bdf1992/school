/**
 * School's task-only observation for a machine learner.
 *
 * A ChatRecord is a teacher archive: question arguments already contain the
 * answer, and practice arguments contain the committed solution. Never send
 * that archive (or the teacher's toLlmMessages projection) to the learner.
 * This reader constructs new objects from an explicit field allowlist.
 *
 * This strict v1 subset follows native-messages.ts's newest-assistant question
 * rule and result-aware practice gate. It intentionally refuses arguments that
 * need the UI's legacy coercion/healing, reused call identities, incomplete
 * turns, and unknown formats. It has no framework/provider dependencies.
 *
 * A projection runs no model, submits no answer, trains nothing, and supplies
 * no grading or evidence-sufficiency verdict. Public question/option text is
 * still authored content; this boundary cannot detect a solution written into
 * the question itself. It also omits teaching prose, hints, and prior answers.
 */

export const LEARNER_VIEW_FORMAT = "school.learner-view/v1" as const;

type QuestionTool = "quiz" | "probe" | "ask_user_question" | "explain" | "recall";
type PracticeMode = "recall" | "discrimination" | "composition";

export interface LearnerOption {
	label: string;
	/** Stable authored value, or the trimmed label when no value was supplied. */
	value: string;
}

export interface LearnerQuestion {
	toolCallId: string;
	tool: QuestionTool;
	kind: "quiz" | "ask" | "explain";
	question: string;
	mode: "single-select" | "multi-select" | "text";
	options: LearnerOption[];
}

export interface LearnerProblem {
	toolCallId: string;
	tool: "problem";
	kind: "problem";
	statement: string;
	mode: PracticeMode;
}

export interface LearnerView {
	format: typeof LEARNER_VIEW_FORMAT;
	sessionId: string;
	/** idle means no pending task in this projection, never mastery/completion. */
	status: "pending" | "idle";
	tasks: (LearnerQuestion | LearnerProblem)[];
}

export type LearnerViewErrorCode =
	| "UNSUPPORTED_RECORD"
	| "MALFORMED_RECORD"
	| "AMBIGUOUS_IDENTITY"
	| "UNSETTLED_TURN"
	| "UNRESOLVED_TOOL"
	| "MALFORMED_TASK"
	| "AMBIGUOUS_PRACTICE";

/** Fixed codes only: diagnostic text must never echo private record content. */
export class LearnerViewError extends Error {
	readonly code: LearnerViewErrorCode;
	constructor(code: LearnerViewErrorCode) {
		super(`Cannot produce learner view: ${code}`);
		this.name = "LearnerViewError";
		this.code = code;
	}
}

type ObjectValue = Record<string, unknown>;
interface Call {
	id: string;
	name: string;
	input: unknown;
	messageIndex: number;
	failed: boolean;
	argumentsError: boolean;
}
interface Result {
	clean: boolean;
	details: unknown;
}

const QUESTION_TOOLS = new Set<string>(["quiz", "probe", "ask_user_question", "explain", "recall"]);
const CUSTOM_TYPES = new Set([
	"graph-context", "probe-handoff", "subagent-steer", "subagent-abort", "plan-block",
	"practice-thinking", "practice-next", "problem-dismissed", "compaction",
]);
const STOP_REASONS = new Set(["stop", "toolUse", "length", "error", "aborted", "pending"]);
const QUESTION_ACK = "Question posed — the turn ends here; the learner's graded answer arrives as this call's result.";

function fail(code: LearnerViewErrorCode): never { throw new LearnerViewError(code); }
function object(value: unknown): value is ObjectValue {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
function isSettled(stopReason: unknown): boolean {
	return stopReason === "stop" || stopReason === "toolUse";
}
function validUserContent(value: unknown): boolean {
	return Array.isArray(value) && value.every((block) => object(block) && (
		(block.type === "text" && typeof block.text === "string") ||
		(block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string")
	));
}

function projectOptions(input: unknown): LearnerOption[] {
	if (!Array.isArray(input) || input.length < 2) fail("MALFORMED_TASK");
	const values = new Set<string>();
	return input.map((option) => {
		if (!object(option) || !nonempty(option.label) ||
			(option.value !== undefined && typeof option.value !== "string")) fail("MALFORMED_TASK");
		const label = option.label.trim();
		const value = typeof option.value === "string" ? option.value.trim() || label : label;
		if (values.has(value)) fail("MALFORMED_TASK");
		values.add(value);
		// Never spread options: description and extensions can disclose correctness.
		return { label, value };
	});
}

function projectQuestion(call: Call): LearnerQuestion {
	const input = call.input;
	if (call.argumentsError || !object(input) || !nonempty(input.question)) fail("MALFORMED_TASK");
	if (input.multiSelect !== undefined && typeof input.multiSelect !== "boolean") fail("MALFORMED_TASK");
	const kind = call.name === "quiz" || call.name === "probe" ? "quiz"
		: call.name === "explain" || call.name === "recall" ? "explain" : "ask";
	const options = kind === "quiz" || (kind === "ask" && input.options !== undefined)
		? projectOptions(input.options) : [];
	if (kind === "quiz") {
		// Check the strict commitment shape, but never copy it to the observation.
		const answers = Array.isArray(input.correctAnswer) ? input.correctAnswer : [input.correctAnswer];
		if (typeof input.explanation !== "string" || answers.length === 0 ||
			answers.some((answer) => !nonempty(answer))) fail("MALFORMED_TASK");
		const keys = new Set(options.map((option) => option.value));
		const answerKeys = new Set((answers as string[]).map((answer) => answer.trim()));
		if ([...answerKeys].some((answer) => !keys.has(answer)) ||
			(answerKeys.size > 1 && input.multiSelect !== true)) fail("MALFORMED_TASK");
	} else if (kind === "explain" && !nonempty(input.correctAnswer)) {
		fail("MALFORMED_TASK");
	}
	return {
		toolCallId: call.id,
		tool: call.name as QuestionTool,
		kind,
		question: input.question,
		mode: options.length === 0 ? "text" : input.multiSelect === true ? "multi-select" : "single-select",
		options,
	};
}

function projectProblem(call: Call): LearnerProblem {
	const input = call.input;
	if (call.argumentsError || !object(input) || !nonempty(input.statement) || !nonempty(input.modelSolution) ||
		(input.mode !== "recall" && input.mode !== "discrimination" && input.mode !== "composition")) {
		fail("MALFORMED_TASK");
	}
	return { toolCallId: call.id, tool: "problem", kind: "problem", statement: input.statement, mode: input.mode };
}

/**
 * Read a native v1 ChatRecord (an absent version is legacy v1).
 * Throws without returning a partial observation if the record is unsupported
 * or ambiguous. The argument is never mutated; no source objects are returned.
 */
export function projectLearnerView(record: unknown): LearnerView {
	if (!object(record) || (record.version !== undefined && record.version !== 1) ||
		(record.kind !== undefined && record.kind !== "teach" && record.kind !== "practice")) fail("UNSUPPORTED_RECORD");
	if (!nonempty(record.id) || !Array.isArray(record.messages)) fail("MALFORMED_RECORD");
	const messages: ObjectValue[] = [];
	const ids = new Set<string>();
	const calls = new Map<string, Call>();
	const callsAt = new Map<number, Call[]>();
	let newestAssistant = -1;
	for (const [messageIndex, message] of record.messages.entries()) {
		if (!object(message) || !nonempty(message.id) || !nonempty(message.role)) fail("MALFORMED_RECORD");
		if (ids.has(message.id)) fail("AMBIGUOUS_IDENTITY");
		ids.add(message.id);
		messages.push(message);
		switch (message.role) {
			case "assistant": {
				if (!Array.isArray(message.content) || !STOP_REASONS.has(message.stopReason as string)) fail("MALFORMED_RECORD");
				if (message.id.startsWith("c_")) fail("UNSETTLED_TURN");
				newestAssistant = messageIndex;
				const entries: Call[] = [];
				for (const block of message.content) {
					if (!object(block)) fail("MALFORMED_RECORD");
					if (block.type === "text" || block.type === "thinking") {
						if (typeof block[block.type] !== "string") fail("MALFORMED_RECORD");
						continue;
					}
					if (block.type !== "toolCall") fail("UNSUPPORTED_RECORD");
					if (!nonempty(block.id) || !nonempty(block.name)) fail("MALFORMED_RECORD");
					if (calls.has(block.id)) fail("AMBIGUOUS_IDENTITY");
					const call: Call = {
						id: block.id, name: block.name, input: block.arguments, messageIndex,
						failed: !isSettled(message.stopReason), argumentsError: block.argumentsError !== undefined,
					};
					calls.set(call.id, call);
					entries.push(call);
				}
				callsAt.set(messageIndex, entries);
				break;
			}
			case "toolResult":
				if (!nonempty(message.toolCallId) || !nonempty(message.toolName) ||
					typeof message.isError !== "boolean" || !validUserContent(message.content)) fail("MALFORMED_RECORD");
				break;
			case "custom":
				if (!CUSTOM_TYPES.has(message.customType as string)) fail("UNSUPPORTED_RECORD");
				if (typeof message.content !== "string") fail("MALFORMED_RECORD");
				break;
			case "user":
				if (typeof message.content !== "string" && !validUserContent(message.content)) fail("MALFORMED_RECORD");
				break;
			default: fail("UNSUPPORTED_RECORD");
		}
	}
	if (newestAssistant >= 0 && !isSettled(messages[newestAssistant]!.stopReason)) fail("UNSETTLED_TURN");

	const results = new Map<string, Result>();
	for (const [messageIndex, message] of messages.entries()) {
		if (message.role !== "toolResult") continue;
		const call = calls.get(message.toolCallId as string);
		if (!call || call.name !== message.toolName || call.messageIndex >= messageIndex) fail("AMBIGUOUS_IDENTITY");
		if ((message.id as string).startsWith("c_")) {
			// Exactly the live questionResult acknowledgement is nonterminal.
			const content = message.content as unknown[];
			if (QUESTION_TOOLS.has(call.name) && message.isError === false && message.details === null &&
				content.length === 1 && object(content[0]) && content[0].type === "text" && content[0].text === QUESTION_ACK) continue;
			fail("UNSETTLED_TURN");
		}
		if (results.has(call.id)) fail("AMBIGUOUS_IDENTITY");
		results.set(call.id, {
			clean: message.isError === false && !(object(message.details) && message.details.ok === false),
			details: message.details,
		});
	}

	// Unknown/dangling executed tools can represent an unfinished turn. Do not
	// silently reinterpret them as an idle state or deliver a sibling question.
	for (const call of calls.values()) {
		if (!call.failed && !QUESTION_TOOLS.has(call.name) && !results.has(call.id)) fail("UNRESOLVED_TOOL");
		if (call.failed && results.get(call.id)?.clean) fail("MALFORMED_RECORD");
	}

	let active: LearnerProblem | null = null;
	let dismissed: string | null = null;
	for (const [messageIndex, message] of messages.entries()) {
		if (message.role === "custom" && message.customType === "problem-dismissed") {
			if (record.kind !== "practice" || !object(message.details) || !nonempty(message.details.problemCallId) ||
				active?.toolCallId !== message.details.problemCallId) fail("AMBIGUOUS_PRACTICE");
			dismissed = active.toolCallId;
			active = null;
		}
		for (const call of callsAt.get(messageIndex) ?? []) {
			if (call.failed || !results.get(call.id)?.clean) continue;
			if (call.name === "problem") {
				if (record.kind !== "practice" || active !== null) fail("AMBIGUOUS_PRACTICE");
				active = projectProblem(call);
				dismissed = null;
			} else if (call.name === "conclude") {
				if (record.kind !== "practice" || call.argumentsError || !object(call.input) ||
					!["solved", "solvedWithHints", "movedOn", "surrendered", "dismissed"].includes(call.input.outcome as string)) fail("AMBIGUOUS_PRACTICE");
				const details = results.get(call.id)!.details;
				if (active === null) {
					// Native deferred dismissal pair: the marker already freed the slot.
					if (dismissed === null || call.id !== `call_conc_${dismissed}` || call.input.outcome !== "dismissed" ||
						!object(details) || details.problemCallId !== dismissed) fail("AMBIGUOUS_PRACTICE");
				} else if (object(details) && details.problemCallId !== undefined && details.problemCallId !== active.toolCallId) {
					fail("AMBIGUOUS_PRACTICE");
				}
				active = null;
				dismissed = null;
			}
		}
	}

	// Never revive an older unanswered question after another assistant turn.
	const questions = (callsAt.get(newestAssistant) ?? [])
		.filter((call) => QUESTION_TOOLS.has(call.name) && !results.has(call.id))
		.map(projectQuestion);
	if (record.kind === "practice" && questions.length > 0) fail("AMBIGUOUS_PRACTICE");
	const tasks = active ? [active] : questions;
	return { format: LEARNER_VIEW_FORMAT, sessionId: record.id, status: tasks.length > 0 ? "pending" : "idle", tasks };
}
