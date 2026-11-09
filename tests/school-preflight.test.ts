/** Owned loopback advertisements only: no model generation or external endpoint. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import { PREFLIGHT_MAX_BODY_BYTES, preflightSchoolConnection, preflightTimeout } from "../src/agent/school-preflight.ts";
import { SchoolParticipantError, schoolConnectionCredentialVariable, type SchoolConnectionDefinition } from "../src/core/school-participants.ts";
import { SchoolParticipantStore, schoolRegistrySha256 } from "../src/store/school-participants.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "school-preflight-")), originalEnv = process.env;
process.env = { ...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}), NODE_ENV: "test", HOME: scratch, LH_DATA_DIR: scratch, LH_AUTH_FILE: path.join(scratch, "auth.json"), LH_IGNORE_ENV_KEYS: "1", NO_PROXY: "localhost,127.0.0.1,::1" };
const { pinSchoolParticipant } = await import("../src/server/school-participants.ts");
after(() => { process.env = originalEnv; rmSync(scratch, { recursive: true, force: true }); });
let sequence = 0;
async function endpoint(t: TestContext, handle: (request: IncomingMessage, response: ServerResponse) => void) {
	const server = createServer(handle);
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return `http://127.0.0.1:${address.port}/v1`;
}
function registered(baseUrl: string, authenticated = false, configured = false) {
	const root = path.join(scratch, `school-${++sequence}`), store = new SchoolParticipantStore(path.join(root, "registry"));
	store.createParticipant({ version: 1, id: "learner", label: "Learner", kind: "model" });
	const route: SchoolConnectionDefinition = configured ? { version: 1, id: "qwen-local", revision: "1", label: "Unsupported", kind: "configured", provider: "anthropic" }
		: { version: 1, id: "qwen-local", revision: "1", label: "Local Qwen", kind: "openai-compatible", baseUrl, auth: authenticated ? { mode: "environment", variable: schoolConnectionCredentialVariable("qwen-local", "1") } : { mode: "keyless" }, contextWindow: 8192, maxOutputTokens: 512, reasoning: false };
	store.createConnection(route);
	const state = { version: 1, participantId: "learner", revision: "base", model: { provider: configured ? "anthropic" : "custom", id: "qwen-exact", thinkingLevel: "off" as const }, connection: { id: "qwen-local", revision: "1" }, artifacts: [], memory: { text: "PRIVATE_MEMORY_NOT_FOR_PREFLIGHT", sourceIds: [] } };
	store.createState(state);
	const resolve = () => {
		const binding = pinSchoolParticipant({ id: "learner", model: state.model, stateRef: { revision: "base" } }, store)!;
		return { ...binding, assertCurrent: () => store.assertBinding(binding) };
	};
	return { root, store, resolve };
}
const inspect = (r: ReturnType<typeof registered>, credential: (name: string) => string | undefined = () => undefined, timeoutMs = 1000) => preflightSchoolConnection({ participantId: "learner", stateRevision: "base", timeoutMs, resolve: r.resolve, credential });
function advertise(response: ServerResponse, data: unknown = [{ id: "qwen-exact" }]) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data })); }

test("exact named model advertisement retains bounded evidence without memory or inferred weights", async (t) => {
	const calls: { path?: string; method?: string; auth?: string }[] = [];
	const url = await endpoint(t, (req, res) => { calls.push({ path: req.url, method: req.method, auth: req.headers.authorization }); advertise(res, [{ id: "other" }, { id: "qwen-exact" }]); });
	const r = registered(url), receipt = await inspect(r, () => { throw new Error("Keyless must not resolve credentials"); });
	assert.deepEqual(calls, [{ path: "/v1/models", method: "GET", auth: "Bearer not-needed" }]);
	assert.equal(receipt.outcome, "PASSED"); assert.equal(receipt.observation, "SUFFICIENT");
	assert.deepEqual(receipt.advertisement, { modelCount: 2, matchingEntries: 1, exactModelAdvertised: true });
	assert.equal(receipt.binding?.stateSha256, r.store.inspectState("learner", "base")!.sha256);
	assert.equal(receipt.binding?.connectionSha256, r.store.inspectConnection("qwen-local", "1")!.sha256);
	assert.equal(receipt.inference, "NOT_PERFORMED"); assert.equal(receipt.loadedArtifact, "NOT_ATTESTED");
	assert.ok(receipt.elapsedMs >= 0); assert.ok(receipt.request.bodyBytes > 0);
	assert.ok(!JSON.stringify(receipt).includes("PRIVATE_MEMORY"));
});
test("missing exact model fails with sufficient advertisement and no substitute", async (t) => {
	const r = registered(await endpoint(t, (_req, res) => advertise(res, [{ id: "Qwen-Exact" }])));
	const receipt = await inspect(r);
	assert.equal(receipt.outcome, "FAILED"); assert.equal(receipt.observation, "SUFFICIENT");
	assert.equal(receipt.error?.code, "MODEL_NOT_ADVERTISED"); assert.equal(receipt.model?.id, "qwen-exact");
});
test("a redirect is retained and never forwards a credential to its destination", async (t) => {
	let secondCalls = 0;
	const second = await endpoint(t, (_req, res) => { secondCalls++; advertise(res); });
	const first = await endpoint(t, (_req, res) => { res.writeHead(307, { location: `${second}/models?secret=unretained` }); res.end(); });
	const receipt = await inspect(registered(first, true), () => "PRIVATE_KEY");
	assert.equal(receipt.error?.code, "CONNECTION_REDIRECT_REFUSED"); assert.equal(receipt.request.responseStatus, 307);
	assert.equal(receipt.observation, "INSUFFICIENT"); assert.equal(secondCalls, 0);
	assert.ok(!JSON.stringify(receipt).includes("PRIVATE_KEY")); assert.ok(!JSON.stringify(receipt).includes("unretained"));
});
test("only the revision-specific credential is read; echoed secrets and unrelated metadata are omitted", async (t) => {
	const variable = schoolConnectionCredentialVariable("qwen-local", "1"), names: string[] = [];
	let auth: string | undefined;
	const url = await endpoint(t, (req, res) => { auth = req.headers.authorization; advertise(res, [{ id: "qwen-exact", metadata: "DEDICATED_SECRET" }, { id: "unrelated-private-model" }]); });
	const receipt = await inspect(registered(url, true), (name) => { names.push(name); return name === variable ? "DEDICATED_SECRET" : "GLOBAL_SECRET"; });
	assert.equal(receipt.outcome, "PASSED"); assert.equal(auth, "Bearer DEDICATED_SECRET");
	assert.deepEqual(new Set(names), new Set([variable]));
	for (const secret of ["DEDICATED_SECRET", "GLOBAL_SECRET", "unrelated-private-model"]) assert.ok(!JSON.stringify(receipt).includes(secret));
});
test("missing credential, revoked connection, and configured provider refuse before HTTP", async (t) => {
	let calls = 0; const url = await endpoint(t, (_req, res) => { calls++; advertise(res); });
	const missing = await inspect(registered(url, true));
	assert.equal(missing.error?.code, "CONNECTION_CREDENTIAL_UNAVAILABLE"); assert.equal(missing.request.attempted, false);
	const r = registered(url); r.store.revokeConnection("qwen-local", "1");
	const revoked = await inspect(r); assert.equal(revoked.error?.code, "CONNECTION_REVOKED");
	const configured = await inspect(registered(url, false, true)); assert.equal(configured.error?.code, "UNSUPPORTED_CONNECTION");
	for (const receipt of [missing, revoked, configured]) { assert.equal(receipt.outcome, "REFUSED"); assert.equal(receipt.observation, "ABSENT"); }
	assert.equal(calls, 0);
});
test("revocation while awaiting the advertisement invalidates success", async (t) => {
	let r: ReturnType<typeof registered>;
	const url = await endpoint(t, (_req, res) => { r.store.revokeConnection("qwen-local", "1"); advertise(res); });
	r = registered(url);
	const receipt = await inspect(r);
	assert.equal(receipt.error?.code, "CONNECTION_REVOKED"); assert.equal(receipt.outcome, "REFUSED");
	assert.equal(receipt.observation, "INSUFFICIENT"); assert.equal(receipt.advertisement.exactModelAdvertised, null);
});
test("a rewritten state with a fresh internal hash still invalidates the admitted binding", async (t) => {
	let r: ReturnType<typeof registered>;
	const url = await endpoint(t, (_req, res) => {
		const filename = path.join(r.store.root, "states", "learner", "base", "definition.json");
		const record = JSON.parse(readFileSync(filename, "utf8"));
		record.definition.model.id = "other-model"; record.sha256 = schoolRegistrySha256(record.definition);
		writeFileSync(filename, JSON.stringify(record)); advertise(res);
	});
	r = registered(url);
	const receipt = await inspect(r);
	assert.equal(receipt.error?.code, "PARTICIPANT_BINDING_DRIFT"); assert.equal(receipt.outcome, "REFUSED");
	assert.equal(receipt.observation, "INSUFFICIENT"); assert.equal(receipt.advertisement.exactModelAdvertised, null);
});
test("credential changes before the attempt or during the response refuse", async (t) => {
	let calls = 0, credential = "FIRST_KEY";
	const url = await endpoint(t, (_req, res) => { calls++; credential = "SECOND_KEY"; advertise(res); });
	let reads = 0;
	const before = await inspect(registered(url, true), () => ++reads === 1 ? "FIRST_KEY" : "SECOND_KEY");
	assert.equal(before.error?.code, "CONNECTION_CREDENTIAL_CHANGED"); assert.equal(before.request.attempted, false); assert.equal(calls, 0);
	const during = await inspect(registered(url, true), () => credential);
	assert.equal(during.error?.code, "CONNECTION_CREDENTIAL_CHANGED"); assert.equal(during.outcome, "REFUSED"); assert.equal(calls, 1);
	assert.equal(during.advertisement.exactModelAdvertised, null);
	assert.ok(!JSON.stringify([before, during]).includes("FIRST_KEY")); assert.ok(!JSON.stringify([before, during]).includes("SECOND_KEY"));
});
test("header and streaming-body stalls respect the same request deadline", async (t) => {
	for (const startedBody of [false, true]) {
		const url = await endpoint(t, (_req, res) => { if (startedBody) { res.writeHead(200); res.write('{"data":['); } });
		const receipt = await inspect(registered(url), undefined, 80);
		assert.equal(receipt.error?.code, "TIMEOUT"); assert.equal(receipt.outcome, "FAILED");
		assert.ok(receipt.elapsedMs < 1500, String(receipt.elapsedMs));
	}
});
test("bounded bodies and invalid responses fail without retaining untrusted content", async (t) => {
	const cases: { code: string; reply: (res: ServerResponse) => void }[] = [
		{ code: "RESPONSE_TOO_LARGE", reply: (res) => { res.writeHead(200, { "content-length": PREFLIGHT_MAX_BODY_BYTES + 1 }); res.end(); } },
		{ code: "RESPONSE_TOO_LARGE", reply: (res) => { res.writeHead(200); res.end("x".repeat(PREFLIGHT_MAX_BODY_BYTES + 1)); } },
		{ code: "INVALID_MODELS_RESPONSE", reply: (res) => { res.end("PRIVATE_INVALID_BODY"); } },
		{ code: "INVALID_MODELS_RESPONSE", reply: (res) => { advertise(res, [{ id: 12 }]); } },
		{ code: "INVALID_MODELS_RESPONSE", reply: (res) => { res.end(Buffer.concat([Buffer.from('{"data":[{"id":"'), Buffer.from([0xff]), Buffer.from('"}]}')])); } },
		{ code: "HTTP_ERROR", reply: (res) => { res.writeHead(401); res.end("PRIVATE_SERVER_ERROR"); } },
	];
	for (const item of cases) {
		const receipt = await inspect(registered(await endpoint(t, (_req, res) => item.reply(res))));
		assert.equal(receipt.error?.code, item.code); assert.equal(receipt.observation, "INSUFFICIENT");
		assert.ok(!JSON.stringify(receipt).includes("PRIVATE_"));
	}
});
test("missing state and request failures produce safe receipts", async () => {
	const receipt = await preflightSchoolConnection({ participantId: "absent", stateRevision: "base", timeoutMs: 500, credential: () => undefined, resolve: () => { throw new SchoolParticipantError("PARTICIPANT_STATE_NOT_FOUND", "private details"); } });
	assert.equal(receipt.error?.code, "PARTICIPANT_STATE_NOT_FOUND"); assert.equal(receipt.observation, "ABSENT");
	assert.ok(!JSON.stringify(receipt).includes("private details"));
	const failed = await inspect(registered("http://127.0.0.1:1/v1"));
	assert.equal(failed.outcome, "FAILED"); assert.equal(failed.error?.code, "REQUEST_FAILED");
	for (const invalid of [0, -1, 1.1, 60001, Infinity, NaN]) assert.throws(() => preflightTimeout(invalid));
});
function cli(args: string[]) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", "scripts/school-preflight.ts", ...args], { cwd: path.resolve(import.meta.dirname, ".."), env: process.env });
		let stdout = "", stderr = "";
		child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
		child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}
test("CLI retains failed receipts and refuses an occupied output before dispatch", { timeout: 10000 }, async (t) => {
	let calls = 0; const r = registered(await endpoint(t, (_req, res) => { calls++; advertise(res, []); }));
	const output = path.join(scratch, "receipt.json"), args = ["--participant", "learner", "--state", "base", "--school", r.root, "--output", output];
	const result = await cli(args); assert.equal(result.code, 1, result.stderr);
	const retained = readFileSync(output, "utf8"); assert.equal(JSON.parse(retained).error.code, "MODEL_NOT_ADVERTISED"); assert.equal(calls, 1);
	const repeated = await cli(args); assert.equal(repeated.code, 1); assert.equal(calls, 1); assert.equal(readFileSync(output, "utf8"), retained);
	const inside = await cli([...args.slice(0, -1), path.join(r.root, "inside.json")]); assert.equal(inside.code, 1); assert.equal(calls, 1);
	const alias = path.join(scratch, "school-alias"); symlinkSync(r.root, alias, "junction");
	const viaAlias = await cli([...args.slice(0, -1), path.join(alias, "inside-alias.json")]);
	assert.equal(viaAlias.code, 1); assert.match(viaAlias.stderr, /outside the School data root/);
	assert.equal(existsSync(path.join(r.root, "inside-alias.json")), false); assert.equal(calls, 1);
	const missingOutput = path.join(scratch, "absent-state.json");
	const absent = await cli(["--participant", "absent", "--state", "base", "--school", r.root, "--output", missingOutput]);
	assert.equal(absent.code, 1); assert.equal(JSON.parse(readFileSync(missingOutput, "utf8")).error.code, "PARTICIPANT_STATE_NOT_FOUND");
});
