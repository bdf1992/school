import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { SEARCH_ENGINES } from "../src/core/search.ts";

// Exercise the production composition with synthetic credentials and a
// closed transport. No search engine or speech service is contacted.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "school-local-services-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
const envVars = [...SEARCH_ENGINES.map(({ envVar }) => envVar), "DEEPGRAM_API_KEY"];
for (const envVar of envVars) delete process.env[envVar];
const { saveKey, deleteKey, keyValue } = await import("../src/server/keys.ts");
const { writeSettings, readSettings } = await import("../src/store/settings.ts");
const { searchStatus, searchProvider } = await import("../src/server/search.ts");
const { GET: dictationToken } = await import("../app/api/stt/token/route.ts");
const originalFetch = globalThis.fetch;
let calls = 0;

beforeEach(() => {
	calls = 0;
	globalThis.fetch = async () => { calls++; throw new Error("unexpected external request"); };
	for (const envVar of envVars) deleteKey(envVar);
	writeSettings({ version: 1 });
});
after(() => {
	globalThis.fetch = originalFetch;
	for (const envVar of envVars) delete process.env[envVar];
	fs.rmSync(dir, { recursive: true, force: true });
});

for (const { id, envVar } of SEARCH_ENGINES) {
	test(`${id}: local-only mode blocks both new and previously resolved search adapters`, async () => {
		const key = id === "tavily" ? "tvly-fake-key-1234567890" : id === "firecrawl" ? "fc-fake-key-1234567890" : `${id}-fake-key-1234567890`;
		assert.equal(saveKey(envVar, key).ok, true);
		writeSettings({ version: 1, agent: { search: { engine: id } } });
		const captured = searchProvider()!;
		assert.equal(captured.id, id);
		writeSettings({ ...readSettings(), customProvider: { localOnly: true } });
		assert.equal(searchStatus().available, false);
		assert.match(searchStatus().reason, /Local Ollama only/);
		assert.equal(searchProvider(), null);
		await assert.rejects(captured.search("evidence", 1), /Local Ollama only/);
		assert.equal(calls, 0);
		assert.equal(keyValue(envVar), key, "the policy preserves the user's stored key");
		writeSettings({ ...readSettings(), customProvider: { localOnly: false } });
		assert.equal(searchProvider()?.id, id, "leaving the mode restores the saved search choice");
	});
}

test("local-only dictation refuses both mint and cached-token authorization before any upstream request", async () => {
	const key = "d".repeat(40);
	assert.equal(saveKey("DEEPGRAM_API_KEY", key).ok, true);
	writeSettings({ version: 1, customProvider: { localOnly: true } });
	for (const suffix of ["", "?check=1"]) {
		const result = await dictationToken(new Request(`http://localhost/api/stt/token${suffix}`));
		assert.equal(result.status, 403);
		assert.match((await result.json()).message, /Local Ollama only/);
		assert.equal(result.headers.get("cache-control"), "no-store");
	}
	assert.equal(calls, 0);
	assert.equal(keyValue("DEEPGRAM_API_KEY"), key);
});

test("cached-token permission checks stay local while ordinary authorized mints still work", async () => {
	assert.equal(saveKey("DEEPGRAM_API_KEY", "d".repeat(40)).ok, true);
	const check = await dictationToken(new Request("http://localhost/api/stt/token?check=1"));
	assert.deepEqual(await check.json(), { allowed: true });
	assert.equal(calls, 0);
	globalThis.fetch = async (input, init) => {
		calls++;
		assert.equal(String(input), "https://api.deepgram.com/v1/auth/grant");
		assert.equal(init?.method, "POST");
		return Response.json({ access_token: "synthetic-short-lived-token" });
	};
	const minted = await dictationToken(new Request("http://localhost/api/stt/token"));
	assert.deepEqual(await minted.json(), { token: "synthetic-short-lived-token" });
	assert.equal(calls, 1);
});

test("corrupt settings cannot re-enable hosted search or dictation", async () => {
	assert.equal(saveKey("TAVILY_API_KEY", "tvly-fake-key-1234567890").ok, true);
	assert.equal(saveKey("DEEPGRAM_API_KEY", "d".repeat(40)).ok, true);
	const captured = searchProvider()!;
	fs.writeFileSync(path.join(dir, "data", "settings.json"), "{truncated");
	assert.equal(searchStatus().available, false);
	assert.equal(searchProvider(), null);
	await assert.rejects(captured.search("evidence", 1), /configuration|settings/i);
	for (const suffix of ["", "?check=1"]) {
		const response = await dictationToken(new Request(`http://localhost/api/stt/token${suffix}`));
		assert.equal(response.status, 403);
	}
	assert.equal(calls, 0);
});
