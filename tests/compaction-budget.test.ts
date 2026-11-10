import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, normalizeContext, type Usage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { CompactionDeps } from "../src/server/compaction.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "school-context-budget-"));
const originalEnv = process.env;
process.env = { ...originalEnv, NODE_ENV: "test", LH_DATA_DIR: scratch, LH_AUTH_FILE: path.join(scratch, "auth.json"), LH_IGNORE_ENV_KEYS: "1" };
const { chatStore } = await import("../src/store/chats.ts");
const { newUserMessage, activeCompactionOf, toLlmMessages, estimateTokens, contextReserveTokens, compactionCutIndex } = await import("../src/core/index.ts");
const { ensureCompacted, effectiveThresholdTokens, ContextBudgetError, assertContextFits, withContextBudgetGuard } = await import("../src/server/compaction.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { authorizeFixture } = await import("./helpers/custom-provider-auth.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { installCustomProviderSource } = await import("../src/server/custom-provider.ts");
import type { LhMessage } from "../src/core/index.ts";

after(() => { process.env = originalEnv; fs.rmSync(scratch, { recursive: true, force: true }); });

const usage: Usage = { input: 500, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 520, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function engine(window: number, output = 4096): PiEngine {
	return { model: { ...createFauxCore({}).getModel(), provider: "custom", id: "local-fixture", contextWindow: window, maxTokens: output }, streamFn: () => { throw new Error("No network operation is permitted in this fixture"); } };
}
function deps(window: number, summarize: CompactionDeps["summarize"]): CompactionDeps {
	return { chatStore, engine: engine(window), modelId: "custom:local-fixture", kind: "teach",
		thresholdTokens: effectiveThresholdTokens(undefined, window, 4096), systemPromptTokens: 400, pendingInputTokens: 150, summarize };
}

for (const window of [8192, 16384, 32768, 65536]) {
	test(`${window} context: imported history compacts into the window with all source chunks and stored messages preserved`, async () => {
		const chat = chatStore.createChat(`bounded ${window}`);
		const messages = Array.from({ length: Math.ceil(window / 400) + 12 }, (_, i) => newUserMessage(`SOURCE_UNIT_${i}\n${"x".repeat(1600)}`));
		chatStore.saveMessages(chat.id, messages);
		const prompts: string[] = [];
		const limits: number[] = [];
		await ensureCompacted(deps(window, async (prompt, selected) => {
			assert.equal(selected.model.provider, "custom");
			assert.equal(selected.model.id, "local-fixture", "every chunk uses the same local model");
			assert.ok(Math.ceil(prompt.length / 4) + selected.model.maxTokens + 100 < window, "summary input and output fit with framing room");
			prompts.push(prompt); limits.push(selected.model.maxTokens);
			return { summary: `Accumulated summary ${prompts.length}: exact synthetic facts.`, usage };
		}), chat.id);
		const record = chatStore.getChat(chat.id)!;
		const marker = activeCompactionOf(record.messages);
		assert.ok(marker);
		assert.deepEqual(record.messages.slice(0, -1), messages, "full transcript is unchanged");
		const projected = toLlmMessages(record.messages);
		assert.ok(estimateTokens(projected) + 550 + contextReserveTokens(window, 4096) <= window, "summary + retained context + system + pending input + output fits");
		const cut = messages.findIndex((message) => message.id === marker.details.firstKeptMessageId);
		const sourceDelivered = prompts.map((prompt) => {
			const transcript = prompt.split("TRANSCRIPT TO SUMMARIZE:\n\n")[1]!;
			return transcript.includes("[NEXT TRANSCRIPT SPAN]\n") ? transcript.split("[NEXT TRANSCRIPT SPAN]\n")[1]! : transcript;
		}).join("");
		assert.equal(sourceDelivered, messages.slice(0, cut).map((message) => `[LEARNER] ${message.content}`).join("\n\n"), "every serialized source character reaches exactly one chunk");
		assert.ok(limits.every((limit) => limit > 0 && limit <= 4096));
		assert.equal(record.turns!.at(-1)!.steps.length, prompts.length, "all completed chunk calls are accounted");
		if (window === 8192) assert.ok(prompts.length > 1, "an old history exceeding the window uses bounded chunks");
	});
}

test("small-window triggers scale down while legacy large-window ceilings remain", () => {
	assert.equal(effectiveThresholdTokens(undefined, 8192, 4096), 4096);
	assert.equal(effectiveThresholdTokens(undefined, 16384, 4096), 12288);
	assert.equal(effectiveThresholdTokens(undefined, 32768, 4096), 24576);
	assert.equal(effectiveThresholdTokens(undefined, 65536, 4096), 49152);
	assert.equal(effectiveThresholdTokens(undefined, 200000, 16384), 150000);
	assert.doesNotThrow(() => assertContextFits([newUserMessage("hello")], engine(8192, 8192)), "impossible catalog maximum is clamped");
	assert.throws(() => assertContextFits([], engine(1, 1)), ContextBudgetError);
});

test("a retained oversized tool exchange is refused without a call, checkpoint, or orphan", async () => {
	const chat = chatStore.createChat("oversized complete exchange");
	const call = { ...fauxAssistantMessage(""), id: "tool-owner", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] } as LhMessage;
	const result: LhMessage = { id: "tool-result", role: "toolResult", toolCallId: "call", toolName: "read", isError: false, timestamp: 1, content: [{ type: "text", text: "x".repeat(40000) }] };
	const messages = [newUserMessage("old ".repeat(4000)), call, result];
	chatStore.saveMessages(chat.id, messages);
	let calls = 0;
	await assert.rejects(ensureCompacted(deps(8192, async () => { calls++; return { summary: "should not run", usage }; }), chat.id), ContextBudgetError);
	assert.equal(calls, 0);
	assert.deepEqual(chatStore.getChat(chat.id)!.messages, messages);
	const cut = compactionCutIndex(messages, 1000, 2000);
	assert.equal(cut, 0, "no destructive cut is offered when the complete exchange cannot fit");
});

test("an oversized generated summary is discarded and completed-call usage is retained", async () => {
	const chat = chatStore.createChat("summary overflow");
	const messages = Array.from({ length: 24 }, () => newUserMessage("x".repeat(2000)));
	chatStore.saveMessages(chat.id, messages);
	await assert.rejects(ensureCompacted(deps(8192, async () => ({ summary: "too large ".repeat(4000), usage })), chat.id), ContextBudgetError);
	const record = chatStore.getChat(chat.id)!;
	assert.deepEqual(record.messages, messages);
	assert.deepEqual(record.turns!.at(-1)!.compaction, { outcome: "discarded", reason: "context-budget" });
	assert.equal(record.turns!.at(-1)!.steps.length, 1);
});

test("normalized system/tool growth is rejected before the upstream stream", async () => {
	let calls = 0;
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const base = { ...engine(8192), streamFn: (...args: Parameters<PiEngine["streamFn"]>) => { calls++; return faux.streamSimple(...args); } };
	const guarded = withContextBudgetGuard(base);
	const small = normalizeContext({ systemPrompt: "small prompt", messages: [newUserMessage("hello")] });
	await guarded.streamFn(guarded.model, small).result();
	assert.equal(calls, 1);
	const big = normalizeContext({ systemPrompt: "x".repeat(18000), messages: [newUserMessage("hello")] });
	assert.throws(() => guarded.streamFn(guarded.model, big), ContextBudgetError);
	const tool = normalizeContext({ tools: [{ name: "large", description: "x".repeat(18000), parameters: { type: "object" } }], messages: [newUserMessage("hello")] });
	assert.throws(() => guarded.streamFn(guarded.model, tool), ContextBudgetError);
	assert.equal(calls, 1, "rejected requests never reach the upstream stream");
});

test("an indivisible 8k incoming turn is rejected by the real handler before any model operation or write", async () => {
	writeSettings({ version: 1, models: { strong: { model: { provider: "custom", id: "local-fixture" } } }, customProvider: authorizeFixture({
		baseUrl: "http://127.0.0.1:11434/v1", authMode: "keyless", models: [{ id: "local-fixture", context: 8192, maxTokens: 4096 }],
	}) });
	installCustomProviderSource();
	const chat = chatStore.createChat("too large input");
	let constructions = 0;
	const response = await handleChatRequest(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "x".repeat(40000) } }) }), () => { constructions++; throw new Error("must not construct a model"); });
	assert.equal(response.status, 413);
	assert.match((await response.json()).error, /Context budget/);
	assert.equal(constructions, 0);
	assert.deepEqual(chatStore.getChat(chat.id)!.messages, []);
});

test("a catalog output maximum equal to the window is clamped on the actual request", async () => {
	let requested: number | undefined;
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const guarded = withContextBudgetGuard({ ...engine(8192, 8192), streamFn: (model, context, options) => {
		requested = options?.maxTokens;
		return faux.streamSimple(model, context, options);
	} });
	await guarded.streamFn(guarded.model, normalizeContext({ messages: [newUserMessage("hello")] })).result();
	assert.equal(requested, 2048);
});

test("a live custom-model window reduction is checked before the next upstream operation", async () => {
	let calls = 0;
	let current = engine(65536).model;
	const captured = current;
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const guarded = withContextBudgetGuard({ model: captured, currentModel: () => current,
		streamFn: (model, context, options) => {
			calls++;
			assert.equal(model.contextWindow, current.contextWindow);
			return faux.streamSimple(model, context, options);
		},
	});
	const context = normalizeContext({ messages: [newUserMessage("x".repeat(80000))] });
	await guarded.streamFn(captured, context).result();
	assert.equal(calls, 1);
	current = engine(16384).model;
	assert.throws(() => assertContextFits(context.messages, guarded), ContextBudgetError, "admission uses current metadata too");
	assert.throws(() => guarded.streamFn(captured, context), ContextBudgetError);
	assert.equal(calls, 1, "a request admitted by the old window never reaches the smaller current model");
});

test("a later chunk failure keeps earlier call accounting and commits no partial checkpoint", async () => {
	const chat = chatStore.createChat("rolling failure");
	const messages = Array.from({ length: 30 }, () => newUserMessage("x".repeat(2000)));
	chatStore.saveMessages(chat.id, messages);
	let calls = 0;
	await assert.rejects(ensureCompacted(deps(8192, async () => {
		if (++calls === 2) throw new Error("synthetic second chunk failure");
		return { summary: "First completed chunk.", usage };
	}), chat.id), ContextBudgetError);
	const record = chatStore.getChat(chat.id)!;
	assert.deepEqual(record.messages, messages);
	assert.equal(calls, 2);
	assert.deepEqual(record.turns!.at(-1)!.compaction, { outcome: "discarded", reason: "summary-failed" });
	assert.equal(record.turns!.at(-1)!.steps.length, 1);
});

test("fitting a smaller tail advances past a complete exchange, never across an unanswered call", () => {
	const old = newUserMessage("old ".repeat(1000));
	const call = { ...fauxAssistantMessage(""), id: "owned", content: [{ type: "toolCall", id: "paired", name: "read", arguments: {} }] } as LhMessage;
	const result: LhMessage = { id: "result", role: "toolResult", toolCallId: "paired", toolName: "read", isError: false, timestamp: 1, content: [{ type: "text", text: "x".repeat(12000) }] };
	const recent = newUserMessage("recent");
	assert.equal(compactionCutIndex([old, call, result, recent], 4000, 500), 3);
	assert.equal(compactionCutIndex([old, call, recent], 4000, 1), 0, "an unanswered call is not silently discarded");
});

test("the production summary seam sends bounded input and an explicit output cap on every chunk", async () => {
	const chat = chatStore.createChat("production summary budget");
	const messages = Array.from({ length: 30 }, () => newUserMessage("x".repeat(2000)));
	chatStore.saveMessages(chat.id, messages);
	const faux = createFauxCore({});
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("Complete accumulated summary.")));
	let calls = 0;
	const selected: PiEngine = { ...engine(8192), streamFn: (model, context, options) => {
		calls++;
		assert.ok(options?.maxTokens && options.maxTokens <= 4096, "the actual stream receives a bounded output option");
		assert.ok(estimateTokens(context.messages) + options.maxTokens < 8192, "the normalized summary request fits");
		return faux.streamSimple(model, context, options);
	} };
	const prior = process.env.NODE_ENV;
	try {
		(process.env as Record<string, string | undefined>).NODE_ENV = "production";
		await ensureCompacted({ ...deps(8192, undefined), engine: selected }, chat.id);
	} finally { (process.env as Record<string, string | undefined>).NODE_ENV = prior; }
	assert.ok(calls > 1);
	assert.ok(activeCompactionOf(chatStore.getChat(chat.id)!.messages));
	assert.deepEqual(chatStore.getChat(chat.id)!.messages.slice(0, -1), messages);
});

test("a window reduced between production summary chunks refuses the next chunk without a partial checkpoint", async () => {
	const chat = chatStore.createChat("summary model changed");
	const messages = Array.from({ length: 80 }, () => newUserMessage("x".repeat(2000)));
	chatStore.saveMessages(chat.id, messages);
	let current = engine(16384).model;
	const faux = createFauxCore({});
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("Complete accumulated summary.")));
	let calls = 0;
	const selected: PiEngine = { model: current, currentModel: () => current, streamFn: (model, context, options) => {
		calls++;
		assert.ok(estimateTokens(context.messages) + (options?.maxTokens ?? model.maxTokens) < model.contextWindow);
		const stream = faux.streamSimple(model, context, options);
		current = engine(8192).model;
		return stream;
	} };
	const prior = process.env.NODE_ENV;
	try {
		(process.env as Record<string, string | undefined>).NODE_ENV = "production";
		await assert.rejects(ensureCompacted({ ...deps(16384, undefined), engine: selected }, chat.id), ContextBudgetError);
	} finally { (process.env as Record<string, string | undefined>).NODE_ENV = prior; }
	assert.equal(calls, 1, "the oversized second chunk is refused before upstream dispatch");
	const record = chatStore.getChat(chat.id)!;
	assert.deepEqual(record.messages, messages);
	assert.equal(record.turns!.at(-1)!.steps.length, 1, "the completed first chunk remains accounted");
	assert.equal(record.turns!.at(-1)!.compaction?.outcome, "discarded");
});
