/** Cold subscription admission through the real episode runner, with a synthetic
 * credential owner and no network, account files, or participant injection. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { parseSchoolEpisode } from "../src/core/school-episode.ts";
import { SchoolEpisodeStore } from "../src/store/school-episodes.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "school-subscription-test-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { NODE_ENV: "test", ...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}), LH_DATA_DIR: scratch, LH_AUTH_FILE: path.join(scratch, "auth.json"), LH_IGNORE_ENV_KEYS: "1" };
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("CLOSED: no network in subscription admission tests"); };
const { runSchoolEpisode } = await import("../src/server/school-episodes.ts");
const { piModels } = await import("../src/agent/models.ts");
const { chatGPTConnected } = await import("../src/agent/chatgpt-bridge.ts");
const { nativeSubscriptionConnected } = await import("../src/agent/subscription-bridge.ts");
const { configureWebSubscriptionRuntime } = await import("../src/agent/subscription-runtime.ts");
after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; rmSync(scratch, { recursive: true, force: true }); });

const source = JSON.parse(readFileSync(new URL("../examples/school/byte-parity.json", import.meta.url), "utf8"));
function manifest(operationId: string, provider: string, id: string) {
	return parseSchoolEpisode({ ...structuredClone(source), operationId,
		learner: { id: "learner", model: { provider, id, thinkingLevel: "off" } },
		teacher: { id: "teacher", model: { provider, id, thinkingLevel: "off" } },
	});
}

test("a cold ChatGPT bridge refreshes its owner before admission, without falling back to API keys", async () => {
	assert.equal(chatGPTConnected(), false, "the standalone process has no warmed account snapshot");
	const model = piModels().getModels("openai").find((entry) => entry.api === "openai-responses");
	assert.ok(model, "use the installed supported catalog, not an invented model ID");
	const operations: string[] = [];
	const snapshot = {
		epoch: 1, authorityRevision: 1, revision: 1, accountId: "synthetic-account",
		status: { available: true, pending: false, allowBackgroundUse: true, activeId: "synthetic-account", accounts: [{ id: "synthetic-account", email: "synthetic@example.invalid", registration: "synthetic-registration", connected: true, planEnabled: true }], error: null },
		models: [{ id: model.id, name: "Synthetic catalog entry" }],
	};
	configureWebSubscriptionRuntime(async <T>(channel: string, op: string) => {
		assert.equal(channel, "lh:chatgpt");
		operations.push(op);
		if (op === "models" || op === "status") return snapshot as T;
		if (op === "lease") throw new Error("Synthetic owner declines credential issuance after local admission");
		throw new Error(`Unexpected private operation: ${op}`);
	});
	const result = await runSchoolEpisode(manifest("cold-chatgpt", "chatgpt", model.id), { store: new SchoolEpisodeStore(path.join(scratch, "episodes")) });
	assert.equal(operations[0], "models", "refresh must occur before a presence gate can reject cold state");
	assert.equal(operations.filter((op) => op === "lease").length, 1, "the real configured engine reaches the synthetic credential boundary");
	assert.ok(result.record.events.some((event) => event.kind === "CALL_ADMITTED"));
	assert.equal(result.record.calls[0]?.resolvedModel?.provider, "chatgpt");
	assert.equal(result.record.status, "FAILED", "the synthetic owner deliberately refuses the lease");
	assert.equal(result.record.calls[0]?.grade, undefined);
	assert.equal(networkCalls, 0, "lease refusal never falls back to a direct API request");
});

test("a cold native subscription refresh still refuses background work before admission or leases", async () => {
	assert.equal(nativeSubscriptionConnected("github-copilot"), false);
	const operations: string[] = [];
	configureWebSubscriptionRuntime(async <T>(channel: string, op: string) => {
		assert.equal(channel, "lh:subscriptions");
		operations.push(op);
		assert.equal(op, "snapshot", "background refusal must precede credential issuance");
		return { statuses: [{ providerId: "github-copilot", available: true, connected: true, pending: false, allowBackgroundUse: false, connectionId: "synthetic-connection", epoch: 1, authorityRevision: 1, revision: 1 }], models: {} } as T;
	});
	const result = await runSchoolEpisode(manifest("cold-copilot-denied", "github-copilot-subscription", "unused-when-denied"), { store: new SchoolEpisodeStore(path.join(scratch, "episodes")) });
	assert.deepEqual(operations, ["snapshot"]);
	assert.equal(result.record.status, "FAILED");
	assert.match(result.record.error ?? "", /not authorized background model calls/);
	assert.equal(result.record.calls[0]?.completion, "NO_CALL_ADMITTED");
	assert.ok(!result.record.events.some((event) => event.kind === "CALL_ADMITTED"));
	assert.equal(networkCalls, 0);
});
