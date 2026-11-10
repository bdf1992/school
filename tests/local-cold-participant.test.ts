import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { SchoolParticipantStore } from "../src/store/school-participants.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "school-local-cold-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { ...originalEnv, NODE_ENV: "test", LH_DATA_DIR: scratch, LH_AUTH_FILE: path.join(scratch, "auth.json"), LH_IGNORE_ENV_KEYS: "1" };
fs.writeFileSync(path.join(scratch, "settings.json"), JSON.stringify({ version: 1, customProvider: { localOnly: true } }));
let requests = 0;
globalThis.fetch = async () => { requests++; throw new Error("CLOSED: no provider request is authorized"); };
// Deliberately import the narrow CLI composition without server/index, keys,
// or custom-provider. This was the cold-start bypass through private routes.
const { pinSchoolParticipant, schoolParticipantEngine } = await import("../src/server/school-participants.ts");
after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; fs.rmSync(scratch, { recursive: true, force: true }); });

test("a cold explicit School participant route installs the persisted local-only guard", async () => {
	const registry = new SchoolParticipantStore(path.join(scratch, "registry"));
	registry.createParticipant({ version: 1, id: "learner", label: "Fixture", kind: "model" });
	registry.createConnection({ version: 1, id: "private-route", revision: "1", label: "Fixture", kind: "openai-compatible", baseUrl: "https://example.invalid/v1", auth: { mode: "keyless" }, contextWindow: 16384, maxOutputTokens: 128, reasoning: false });
	const state = { version: 1, participantId: "learner", revision: "base", model: { provider: "custom", id: "fixture-model", thinkingLevel: "off" as const }, connection: { id: "private-route", revision: "1" }, artifacts: [] };
	registry.createState(state);
	const participant = { id: "learner", model: state.model, stateRef: { revision: "base" } };
	const binding = pinSchoolParticipant(participant, registry)!;
	const { engine } = await schoolParticipantEngine(participant, binding, { registry, configuredEngine: () => { throw new Error("explicit route must not resolve a global engine"); } });
	const result = await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "synthetic", timestamp: 0 }] }), {}).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /Local Ollama only/);
	assert.equal(requests, 0);
});
