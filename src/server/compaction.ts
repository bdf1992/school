/**
 * THE COMPACTION SERVICE (owner round 14, 2026-10-05): the trigger
 * plumbing around core/compaction's pure cuts and markers.
 *
 * TOPOLOGY (why this is simple): question and problem poses TERMINATE
 * their runs, so the "user is thinking" pause is always a BETWEEN-RUNS
 * window. Compaction therefore never touches a live run:
 *
 *   - SETTLE KICK — a turn settles (onFinish, after persist) and the
 *     projected context is over threshold: the summary starts NOW, in
 *     the background, while the learner reads/answers — usually done
 *     long before the next input arrives.
 *   - TURN-START GATE — every turn (client POST or wake) awaits any
 *     in-flight compaction for its chat BEFORE appends or beginTurn;
 *     if the record is STILL over threshold (cold sessions, kicks that
 *     lost their engine), compaction runs synchronously inside the
 *     request. Structurally gated: nothing model-facing for the chat
 *     interleaves with a running compaction (owner ruling — minimal
 *     surface for anything to go wrong).
 *   - OVERFLOW RECOVERY — a run that dies on context length needs no
 *     special path: the next turn's gate compacts and the fresh run
 *     starts small.
 *
 * The summary is written by the session's OWN conversation model (owner
 * ruling) via the zero-tool one-shot sub-agent seam; its usage lands in
 * the chat's append-only turns log (the money channel) keyed by the
 * marker's id.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import {
	activeCompactionOf,
	buildCompactionPrompt,
	compactionCutIndex,
	contextReserveTokens,
	contextOutputLimit,
	KEEP_RECENT_TOKENS,
	estimateContextTokens,
	estimateTokens,
	newCompactionMarker,
	planTreeToText,
	serializeForSummary,
	toLlmMessages,
	type CompactionDetails,
	type LhMessage,
	type LhMarkerMessage,
} from "../core/index.ts";
import { emit } from "../core/events.ts";
import type { TurnUsage } from "../core/contracts.ts";
import type { ChatStore } from "../core/ports.ts";
import type { PiEngine } from "../agent/models.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";

/** The summarizer's system prompt — server-owned operational framing,
 *  not model-facing doctrine (buildCompactionPrompt carries the shape). */
const SUMMARIZER_SYSTEM_PROMPT =
	"You are the session-compaction summarizer for a tutoring agent. You receive the transcript span to summarize and write exactly the summary the instructions demand — nothing else, no preamble, no meta-commentary.";

/** The one-shot summary call: zero tools, one turn, text out. The engine
 *  is the chat's own conversation engine (owner ruling: the session's
 *  model writes its own summary). Injectable for tests. */
export type Summarizer = (prompt: string, engine: PiEngine) => Promise<{ summary: string; usage: Usage }>;

/** The production summarizer over the sub-agent seam. */
async function subagentSummarizer(prompt: string, engine: PiEngine): Promise<{ summary: string; usage: Usage }> {
	let usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const { text, newMessages } = await runSubagent([], {
		// The engine override is always present (the chat's own conversation
		// engine — owner ruling), so the role label never resolves an
		// engine; "researcher" is the least-wrong existing ModelRole label
		// for a one-shot text job (the cast documents the dead path).
		role: "researcher" as never,
		prompt,
		engine,
		systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
		maxTurns: 1,
		onUsage: (u) => {
			usage = u;
		},
	});
	// A provider-declared incomplete response is not a usable checkpoint,
	// even when it contains nonempty text. Match Pi's compaction failure
	// semantics: leave the existing history and prior summary untouched.
	if (newMessages.some((message) => message.role === "assistant" && message.stopReason === "length")) {
		throw new Error("Compaction summary hit the output limit and is incomplete");
	}
	return { summary: text, usage };
}

/** Everything the service needs from its host (chat-handler wires the
 *  production versions; tests inject). */
export interface CompactionDeps {
	/** Eligibility only for NEW runs; structural waits still apply. */
	canStart?: () => boolean;
	chatStore: ChatStore;
	/** The chat's conversation engine — also the summarizer's. */
	engine: PiEngine;
	/** provider:id of the engine (usage + marker provenance). */
	modelId: string;
	/** The session kind (summarizer wording: tutor vs practice). */
	kind: "teach" | "practice" | "probe";
	/** The effective trigger threshold, RESOLVED by the caller:
	 *  min(settings threshold, contextWindow − reserve) — the owner's
	 *  effective-trigger ruling. The catalog window lookup is the
	 *  caller's (chat-handler has the model id at hand). */
	thresholdTokens: number;
	/** The composed system prompt's token estimate (chars/4) — the
	 *  projection the provider actually receives starts with it. */
	systemPromptTokens: number;
	/** Not yet persisted input that the next conversation call must fit. */
	pendingInputTokens?: number;
	/** Injectable summarizer (tests); default = the sub-agent one-shot. */
	summarize?: Summarizer;
}

// ─── the registry (module-global on globalThis, jobs.ts's pattern) ─────────

interface CompactionState {
	inFlight: Map<string, Promise<void>>;
}
const g = globalThis as typeof globalThis & { __lhCompaction?: CompactionState };
function state(): CompactionState {
	return (g.__lhCompaction ??= { inFlight: new Map() });
}

/** Is a compaction running for this chat? (The client status event's
 *  server-side twin — tests and the SSE emitter read it.) */
export function compactionInFlight(chatId: string): boolean {
	return state().inFlight.has(chatId);
}

/** Await any in-flight compaction for the chat — the structural gate
 *  every model interaction for the chat passes through. */
export async function awaitCompaction(chatId: string): Promise<void> {
	let running: Promise<void> | undefined;
	while ((running = state().inFlight.get(chatId))) await running;
}

/** Claim before running any callbacks or publishing status. The deferred
 *  body prevents a synchronous status listener from starting a second run.
 *  Only the registered promise may release its own slot. */
function startCompaction(deps: CompactionDeps, chatId: string): Promise<void> {
	const running = state().inFlight.get(chatId);
	if (running) return running;
	const run = Promise.resolve().then(() => compact(deps, chatId)).finally(() => {
		if (state().inFlight.get(chatId) === run) state().inFlight.delete(chatId);
	});
	state().inFlight.set(chatId, run);
	return run;
}

// ─── the effective threshold (owner ruling: min(setting, window − reserve)) ─

/** Resolve the effective trigger. Unknown window → the setting alone
 *  (honest: no fake window — the catalog-index precedent). */
export function effectiveThresholdTokens(settingTokens: number | undefined, contextWindowTokens: number | undefined, maxOutputTokens?: number): number {
	const setting = settingTokens ?? 150_000;
	if (contextWindowTokens === undefined) return setting;
	return Math.min(setting, Math.max(contextWindowTokens - contextReserveTokens(contextWindowTokens, maxOutputTokens), 1));
}

/** App-side estimates are not the backend tokenizer. Reject an estimated
 * overflow instead of submitting a request that may silently truncate. */
export class ContextBudgetError extends Error {
	constructor(message: string) {
		super(`Context budget: ${message}`);
		this.name = "ContextBudgetError";
	}
}

function modelWindow(model: PiEngine["model"]): number | undefined {
	const value = model.contextWindow;
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function contextWindowOf(engine: PiEngine): number | undefined {
	return modelWindow(engine.currentModel?.() ?? engine.model);
}

function inputBudgetOf(engine: PiEngine): number | undefined {
	const model = engine.currentModel?.() ?? engine.model;
	const window = modelWindow(model);
	if (window === undefined) return undefined;
	const budget = window - contextReserveTokens(window, model.maxTokens);
	if (budget <= 0) throw new ContextBudgetError(`the configured output allowance leaves no input space in this ${window}-token window. Lower the output limit or select a larger verified context.`);
	return budget;
}

/** Used before dispatch, including the actual system/tool messages once
 * Pi has normalized them. Full persisted history is never rewritten. */
export function assertContextFits(messages: readonly (LhMessage | AgentMessage)[], engine: PiEngine, additionalTokens = 0): void {
	const budget = inputBudgetOf(engine);
	if (budget === undefined) return;
	const estimate = estimateTokens(messages) + additionalTokens;
	if (estimate > budget) throw new ContextBudgetError(`the request is estimated at ${estimate} input tokens, but ${budget} are available after reserving output. Shorten the input or select a larger verified context.`);
}

/** Guard every model operation, including tool-loop growth after admission. */
export function withContextBudgetGuard(engine: PiEngine): PiEngine {
	return {
		...engine,
		streamFn: (model, context, options) => {
			// Custom-provider settings can change while an Agent is alive. Its
			// captured model is not the authority for the next operation's window.
			const current = engine.currentModel?.() ?? model;
			const requested = options?.maxTokens ?? current.maxTokens;
			const limited = contextOutputLimit(current.contextWindow, requested);
			assertContextFits(context.messages, { model: { ...current, maxTokens: limited }, streamFn: engine.streamFn });
			return engine.streamFn(current, context, limited === requested ? options : { ...options, maxTokens: limited });
		},
	};
}

function budgetFor(deps: CompactionDeps) {
	const inputTokens = inputBudgetOf(deps.engine) ?? deps.thresholdTokens;
	const available = Math.min(inputTokens, deps.thresholdTokens) - deps.systemPromptTokens - (deps.pendingInputTokens ?? 0);
	if (available < 256) throw new ContextBudgetError("system instructions, pending input, and output leave too little room for a retained turn and summary.");
	return {
		inputTokens,
		keepRecentTokens: Math.min(KEEP_RECENT_TOKENS, Math.floor(available / 2)),
		summaryTokens: Math.min(4096, Math.floor(available / 4), (deps.engine.currentModel?.() ?? deps.engine.model).maxTokens || 4096),
		available,
	};
}

const MAX_SUMMARY_CALLS = 64;
const SUMMARY_INPUT_MARGIN = 256;

/** Oversized old histories use bounded rolling summaries on the SAME engine.
 * Every source character reaches a chunk; no prefix is silently discarded.
 * The 64-call ceiling makes an unexpectedly huge import an explicit refusal. */
async function summarizeSpan(
	deps: CompactionDeps,
	spanText: string,
	planText: string | null,
	maxSummaryTokens: number,
	onUsage: (usage: Usage) => void,
): Promise<string> {
	const window = contextWindowOf(deps.engine);
	const makePrompt = (text: string) => buildCompactionPrompt({ spanText: text, planTreeText: planText, kind: deps.kind, maxSummaryTokens });
	const guarded = withContextBudgetGuard(deps.engine);
	const summaryEngine: PiEngine = {
		...deps.engine,
		model: { ...(deps.engine.currentModel?.() ?? deps.engine.model), maxTokens: maxSummaryTokens },
		streamFn: (model, context, options) => guarded.streamFn(model, context, {
			...options,
			maxTokens: Math.min(options?.maxTokens ?? maxSummaryTokens, maxSummaryTokens),
		}),
	};
	const summarize = deps.summarize ?? subagentSummarizer;
	const prefix = (summary: string) => summary ? `[ACCUMULATED SUMMARY — retain its facts unless the new span supersedes them]\n${summary}\n\n[NEXT TRANSCRIPT SPAN]\n` : "";
	const summaryReserve = window === undefined ? maxSummaryTokens : contextReserveTokens(window, maxSummaryTokens);
	const capacity = (summary: string) => window === undefined ? spanText.length :
		(window - summaryReserve - SUMMARY_INPUT_MARGIN) * 4 - SUMMARIZER_SYSTEM_PROMPT.length - makePrompt(prefix(summary)).length;
	const minimumCapacity = capacity("x".repeat(maxSummaryTokens * 4));
	if (minimumCapacity < 256 || Math.ceil(spanText.length / minimumCapacity) > MAX_SUMMARY_CALLS) {
		throw new ContextBudgetError("the summary instructions, plan, or imported history cannot fit within the bounded summarization budget. Select a larger verified context or reduce the imported material.");
	}
	let summary = "";
	let offset = 0;
	let calls = 0;
	do {
		let end = Math.min(spanText.length, offset + capacity(summary));
		// Never split a UTF-16 surrogate pair at a chunk boundary.
		if (end < spanText.length && /[\uD800-\uDBFF]/.test(spanText[end - 1] ?? "")) end--;
		if ((end <= offset && spanText.length > 0) || ++calls > MAX_SUMMARY_CALLS) throw new ContextBudgetError("the history exceeds the bounded summarization budget.");
		const prompt = makePrompt(`${prefix(summary)}${spanText.slice(offset, end)}`);
		if (window !== undefined && Math.ceil((SUMMARIZER_SYSTEM_PROMPT.length + prompt.length) / 4) + maxSummaryTokens + SUMMARY_INPUT_MARGIN > window) {
			throw new ContextBudgetError("the summarization request exceeds the selected model window.");
		}
		const result = await summarize(prompt, summaryEngine);
		onUsage(result.usage);
		summary = result.summary.trim();
		if (!summary) return "";
		if (Math.ceil(summary.length / 4) > maxSummaryTokens) throw new ContextBudgetError("the generated summary exceeds its reserved space; no checkpoint was committed.");
		offset = end;
	} while (offset < spanText.length);
	return summary;
}

// ─── the estimate over the ACTIVE projection ────────────────────────────────

/** The projected context estimate: what the next LLM call would carry.
 *  THE TRIGGER LAW (pi's, verified 2026-10-05): anchor on the last
 *  assistant message's provider-reported usage — it already counted
 *  the system prompt, tool declarations, and the provider's own
 *  tokenizer — and chars/4-estimate ONLY messages appended after it.
 *  estimateContextTokens refuses anchors that predate a compaction
 *  marker (that usage described context the next request will NOT
 *  carry), so the fallback path runs the plain heuristic over the
 *  CUT-HONORED projection (never the dropped span) plus the additive
 *  prompt term the anchor would have covered. */
export function projectedContextTokens(messages: readonly LhMessage[], systemPromptTokens: number): number {
	const est = estimateContextTokens(messages);
	if (est.lastUsageIndex !== null) return est.tokens;
	return estimateTokens(toLlmMessages(messages as readonly AgentMessage[]) as unknown as readonly LhMessage[]) + systemPromptTokens;
}

// ─── the compaction run ─────────────────────────────────────────────────────

/** The summarized source must stay unchanged while the model runs. Demo/
 *  figure display preferences are the one permitted nonsemantic edit: they
 *  never enter the summarizer or provider view, and are kept from the latest
 *  record. Compare full source values, not the summarizer's truncated text. */
function summarySource(messages: readonly LhMessage[]): string {
	return JSON.stringify(messages.map((message) => {
		if (message.role !== "custom" || message.customType !== "subagent-steer") return message;
		const details = message.details as { kind?: string; ui?: unknown } | undefined;
		if (!details || (details.kind !== "demo" && details.kind !== "visual")) return message;
		const { ui: _ui, ...contentDetails } = details;
		return { ...message, details: contentDetails };
	}));
}

/** Run one compaction for the chat (the registry mutex is HELD by the
 *  caller — ensureCompacted). Reads the record fresh, cuts, summarizes,
 *  reconciles the snapshot, records usage, notifies. Never throws upward
 *  past the registry cleanup. */
async function compact(deps: CompactionDeps, chatId: string): Promise<void> {
	const record = deps.chatStore.getChat(chatId);
	if (!record) return;
	const messages = record.messages;
	const tokensBefore = projectedContextTokens(messages, deps.systemPromptTokens) + (deps.pendingInputTokens ?? 0);
	if (tokensBefore <= deps.thresholdTokens) return; // settled beneath while we waited

	let budget: ReturnType<typeof budgetFor>;
	try { budget = budgetFor(deps); }
	catch (error) { console.error(`[chat ${chatId}] compaction cannot fit:`, error); return; }
	const cut = compactionCutIndex(messages, budget.keepRecentTokens, budget.available - budget.summaryTokens - 64);
	if (cut <= 0 || cut >= messages.length) return; // no history can be dropped

	// The previous compaction's kept boundary (chained compactions
	// summarize the old summary + what rode after it).
	const previous = activeCompactionOf(messages);
	const prevKept = previous ? messages.findIndex((m) => m.id === previous.details.firstKeptMessageId) : -1;
	// ANTI-CHURN GUARD: when the cut cannot advance past the previous
	// kept boundary, the span is empty (or repeats it) — the kept tail
	// alone carries the projection and re-summarizing the same span
	// cannot shrink it. Reachable only when the threshold sits below
	// kept-tail + summary (a hand-edited record below the settings
	// floor); skipping keeps the loop honest instead of churning.
	if (previous && prevKept !== -1 && cut <= prevKept) {
		console.info(
			`[chat ${chatId}] compaction skipped — the kept tail alone exceeds the threshold (raise it or shrink the tail)`,
		);
		return;
	}

	// The span: from the PREVIOUS kept boundary through the cut.
	let spanStart = 0;
	let priorSummary: string | null = null;
	if (previous && prevKept > 0) {
		spanStart = prevKept;
		priorSummary = previous.content;
	}
	const span = messages.slice(spanStart, cut);
	// The separately supplied prior summary replaces all summary markers
	// in this span. Without a resolved prior boundary, retain the existing
	// legacy fallback rather than silently discarding summary-only context.
	const summaryMessages = priorSummary
		? span.filter((m) => m.role !== "custom" || m.customType !== "compaction")
		: span;
	const spanText = serializeForSummary(summaryMessages);
	const fullSpan = priorSummary ? `[SYSTEM NOTE — prior compaction summary, still authoritative where not superseded]\n${priorSummary}\n\n${spanText}` : spanText;

	const planText = planTreeToText(record.tree, messages);
	const sourceAtStart = summarySource(messages.slice(0, cut));
	const checkpointAtStart = JSON.stringify(previous);
	const details: CompactionDetails = {
		firstKeptMessageId: messages[cut]!.id,
		tokensBefore,
		model: deps.modelId,
		at: new Date().toISOString(),
	};
	// Avoid spending even a local inference call if the smallest retained
	// complete exchange cannot coexist with the reserved summary and input.
	try {
		const reserved = newCompactionMarker("x".repeat(budget.summaryTokens * 4), details);
		assertContextFits(toLlmMessages([...messages, reserved]), deps.engine, deps.systemPromptTokens + (deps.pendingInputTokens ?? 0));
	} catch (error) { console.error(`[chat ${chatId}] compaction cannot fit:`, error); return; }

	emit("compaction-changed", { chatId, running: true });
	const usages: Usage[] = [];
	let usageRecorded = false;
	let checkpointCommitted = false;
	try {
		const trimmed = await summarizeSpan(deps, fullSpan, planText, budget.summaryTokens, (usage) => usages.push(usage));
		const marker = newCompactionMarker(trimmed, details);
		const current = deps.chatStore.getChat(chatId);
		if (!current) return; // deletion owns the record; never resurrect it for a late summary
		const originalEnd = messages.length;
		let reason: Extract<NonNullable<TurnUsage["compaction"]>, { outcome: "discarded" }>["reason"] | undefined;
		if (!trimmed) reason = "empty-summary";
		else if (current.messages.length < originalEnd || messages.some((message, i) => current.messages[i]?.id !== message.id)) reason = "history-changed";
		else if (JSON.stringify(activeCompactionOf(current.messages)) !== checkpointAtStart || current.messages.slice(originalEnd).some((message) => message.role === "custom" && message.customType === "compaction")) reason = "checkpoint-changed";
		else if (summarySource(current.messages.slice(0, cut)) !== sourceAtStart) reason = "source-changed";
		else if (planTreeToText(current.tree, current.messages.slice(0, originalEnd)) !== planText) reason = "plan-changed";
		const candidate = [...current.messages.slice(0, originalEnd), marker, ...current.messages.slice(originalEnd)];
		if (!reason) {
			try { assertContextFits(toLlmMessages(candidate), deps.engine, deps.systemPromptTokens + (deps.pendingInputTokens ?? 0)); }
			catch { reason = "context-budget"; }
		}
		if (reason) {
			console.info(`[chat ${chatId}] compaction discarded — ${reason}`);
		} else {
			// Preserve edits and appends from the synchronous fresh read. The
			// checkpoint belongs before actions that arrived during summarizing:
			// putting it after a dismissal would silently clear the delivery pause.
			// The ID/order check above establishes this position; a stale numeric
			// index alone must never decide which history the summary replaces.
			deps.chatStore.saveMessages(chatId, candidate);
			checkpointCommitted = true;
		}
		// The money channel: the summary is a real model call on the
		// session's own engine even when its snapshot became obsolete. The
		// explicit outcome prevents a discarded attempt ID implying a checkpoint.
		deps.chatStore.appendTurnUsage(chatId, {
			id: crypto.randomUUID(),
			messageId: marker.id,
			at: details.at,
			model: deps.modelId,
			compaction: reason ? { outcome: "discarded", reason } : { outcome: "committed" },
			steps: usages.map((usage) => ({
					inputTokens: usage.input,
					outputTokens: usage.output,
					cacheReadTokens: usage.cacheRead,
					cacheWriteTokens: usage.cacheWrite,
					cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
					reasoningTokens: usage.reasoning ?? 0,
			})),
		});
		usageRecorded = true;
		// Notify-then-fetch: expose completed-call usage and, when committed,
		// the checkpoint. A discarded summary never invalidates the meter.
		emit("record-changed", { chatId });
	} catch (err) {
		// Failures before commit leave messages untouched. The separate usage
		// write can also fail after a marker commits; never claim rollback or
		// repeat the provider call here. The next gate reads actual record state.
		console.error(`[chat ${chatId}] compaction failed:`, err);
		if (usages.length && !usageRecorded && !checkpointCommitted && deps.chatStore.getChat(chatId)) {
			// A later chunk can fail after earlier chunks completed. Preserve
			// those measured calls without pretending they made a checkpoint.
			try {
				deps.chatStore.appendTurnUsage(chatId, {
					id: crypto.randomUUID(), messageId: crypto.randomUUID(), at: details.at, model: deps.modelId,
					compaction: { outcome: "discarded", reason: err instanceof ContextBudgetError ? "context-budget" : "summary-failed" },
					steps: usages.map((usage) => ({ inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead,
						cacheWriteTokens: usage.cacheWrite, cacheWrite1hTokens: usage.cacheWrite1h ?? 0, reasoningTokens: usage.reasoning ?? 0 })),
				});
				emit("record-changed", { chatId });
			} catch (accountingError) { console.error(`[chat ${chatId}] compaction usage could not be saved:`, accountingError); }
		}
	} finally {
		emit("compaction-changed", { chatId, running: false });
	}
}

/**
 * The gate + trigger in one: await any in-flight compaction, then — if
 * the record is STILL over threshold — run one synchronously (the
 * caller's request waits; the owner's structural-gate ruling). Idempotent
 * under concurrency through the registry mutex.
 */
export async function ensureCompacted(deps: CompactionDeps, chatId: string): Promise<void> {
	// Skipped under tests, the extraction-trigger precedent: scripted
	// chats are fixtures — the service itself is tested directly with an
	// injected summarizer.
	if (process.env.NODE_ENV === "test" && !deps.summarize) return;
	// Do not yield on an empty gate: two simultaneous callers must not both
	// leave that await and let one return past a newly registered owner.
	// Eligibility only controls starting work; all callers wait for active work.
	while (state().inFlight.has(chatId)) await awaitCompaction(chatId);
	if (deps.canStart?.() === false) return;
	const record = deps.chatStore.getChat(chatId);
	if (!record) return;
	if (projectedContextTokens(record.messages, deps.systemPromptTokens) + (deps.pendingInputTokens ?? 0) > deps.thresholdTokens) await startCompaction(deps, chatId);
	const current = deps.chatStore.getChat(chatId);
	if (current) assertContextFits(toLlmMessages(current.messages), deps.engine, deps.systemPromptTokens + (deps.pendingInputTokens ?? 0));
}

/**
 * The settle kick (fire-and-forget): the turn settled, the learner is
 * about to read/answer — if the projection is over threshold, the
 * summary starts NOW and finishes inside the pause. Wired at
 * chat-handler's onFinish tail; engineless or over-threshold-nothing
 * are silent no-ops. The next turn's ensureCompacted gate picks up
 * whatever this leaves running.
 */
export function kickCompaction(buildDeps: () => CompactionDeps | null, chatId: string): void {
	if (state().inFlight.has(chatId)) return;
	const deps = buildDeps();
	if (!deps || deps.canStart?.() === false) return;
	const record = deps.chatStore.getChat(chatId);
	if (!record) return;
	if (projectedContextTokens(record.messages, deps.systemPromptTokens) + (deps.pendingInputTokens ?? 0) <= deps.thresholdTokens) return;
	void startCompaction(deps, chatId);
}
