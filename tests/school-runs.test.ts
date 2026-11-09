import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { SchoolRunStore } from "../src/store/school-runs.ts";
import { SchoolEpisodeStore } from "../src/store/school-episodes.ts";
import { SchoolClassStore } from "../src/store/school-classes.ts";
import { SchoolRunError, schoolRunSummary } from "../src/core/school-run.ts";
import { parseSchoolEpisode, type SchoolEpisodeRecord } from "../src/core/school-episode.ts";
import { scriptedParityEngine } from "../examples/school/scripted-parity.ts";
import type { PiEngine } from "../src/agent/models.ts";

const root = mkdtempSync(path.join(tmpdir(), "school-queue-"));
const priorEnv = process.env, priorFetch = globalThis.fetch;
process.env = { ...priorEnv, NODE_ENV: "test", LH_DATA_DIR: root, LH_AUTH_FILE: path.join(root, "auth.json"), LH_IGNORE_ENV_KEYS: "1" };
delete process.env.LH_DESKTOP_API_SECRET; delete process.env.LH_DESKTOP_SERVER;
globalThis.fetch = async () => { throw new Error("No external requests in queue tests"); };
const { acknowledgeSchoolRunUncertainty, cancelSchoolRun, drainSchoolRuns, reconcileSchoolRun, schoolRunGet, schoolRunPost } = await import("../src/server/school-runs.ts");
const { runSchoolEpisode } = await import("../src/server/school-episodes.ts");
after(() => { process.env = priorEnv; globalThis.fetch = priorFetch; rmSync(root, { recursive: true, force: true }); });
const source = JSON.parse(readFileSync(new URL("../examples/school/byte-parity.json", import.meta.url), "utf8"));
const definition = JSON.parse(readFileSync(new URL("../examples/school/byte-parity-class.json", import.meta.url), "utf8"));
let serial = 0;
const input = () => parseSchoolEpisode({ ...structuredClone(source), operationId: `queued-${String(++serial).padStart(5, "0")}` });
function setup() {
	const folder = path.join(root, `suite-${++serial}`), classStore = new SchoolClassStore(path.join(folder, "classes"));
	classStore.create(definition);
	return { runStore: new SchoolRunStore(path.join(folder, "queue")), store: new SchoolEpisodeStore(path.join(folder, "episodes")), classStore, evidence: "SCRIPTED_FIXTURE" as const, engineFor: scriptedParityEngine };
}
const at = "2026-11-09T16:00:00.000Z", now = () => new Date(at);
function enqueue(options: ReturnType<typeof setup>, manifest = input(), extra: Record<string, unknown> = {}) { return options.runStore.enqueue({ manifest, ...extra }, "SCRIPTED_FIXTURE", at).run; }
const errorCode = (expected: string) => (error: unknown) => error instanceof SchoolRunError && error.code === expected;
function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

test("queue identity survives restart; replay cannot change evidence, limits, dates, or manifest", () => {
	const options = setup(), manifest = input(), first = enqueue(options, manifest);
	const restarted = new SchoolRunStore(options.runStore.root);
	assert.equal(restarted.enqueue({ manifest }, "SCRIPTED_FIXTURE", "2027-01-01T00:00:00Z").created, false);
	assert.deepEqual(restarted.read(manifest.operationId), first);
	for (const change of [{ maxCalls: 8 }, { notBefore: "2026-11-10T00:00:00Z" }, { manifest: { ...manifest, world: { ...manifest.world, revision: "different" } } }]) assert.throws(() => restarted.enqueue({ manifest, ...change }, "SCRIPTED_FIXTURE"), errorCode("RUN_COLLISION"));
	assert.throws(() => restarted.enqueue({ manifest }), errorCode("RUN_COLLISION"));
	assert.throws(() => enqueue(options, input(), { maxCalls: 6 }), errorCode("CALL_BUDGET"));
	assert.throws(() => enqueue(options, input(), { notBefore: "2026-11-09T12:00:00" }), /timezone/);
	assert.throws(() => enqueue(options, input(), { notBefore: "2026-02-30T12:00:00Z" }), /calendar/);
	assert.throws(() => enqueue(options, input(), { notBefore: null }), /timestamp/);
	assert.throws(() => enqueue(options, input(), { maxCalls: null }), errorCode("CALL_BUDGET"));
	const summary = JSON.stringify(schoolRunSummary(first));
	assert.ok(!summary.includes('"expected"')); assert.ok(!summary.includes(manifest.evaluation[0]!.question));
});

test("due-work execution uses the real runner, respects a per-drain call budget, and never consumes cancelled or future work", async () => {
	const options = setup(), first = enqueue(options), second = enqueue(options), future = enqueue(options, input(), { notBefore: "2026-11-10T00:00:00Z" }), cancelled = enqueue(options);
	cancelSchoolRun(cancelled.operationId, options);
	let calls = 0;
	const worker = { ...options, now, engineFor: (p: Parameters<typeof scriptedParityEngine>[0], c: Parameters<typeof scriptedParityEngine>[1]) => { calls++; return scriptedParityEngine(p, c); }, maxCalls: 7 };
	assert.equal(calls, 0);
	assert.equal((await drainSchoolRuns(worker)).processed, 1);
	assert.equal(options.runStore.read(first.operationId)?.status, "COMPLETED");
	assert.equal(options.runStore.read(second.operationId)?.status, "QUEUED");
	assert.equal(calls, 7);
	assert.equal((await drainSchoolRuns(worker)).processed, 1);
	assert.equal((await drainSchoolRuns(worker)).processed, 0);
	assert.equal(calls, 14);
	assert.equal(options.runStore.read(future.operationId)?.status, "QUEUED");
	assert.equal(options.runStore.read(cancelled.operationId)?.status, "CANCELLED");
	assert.equal(options.store.read(cancelled.operationId), null);
});

test("exclusive worker and owner cancellation keep another queued run untouched", async () => {
	const options = setup(), first = enqueue(options), second = enqueue(options), entered = gate(), release = gate();
	const running = drainSchoolRuns({ ...options, now, maxRuns: 1, engineFor: async (p, c) => { entered.resolve(); await release.promise; return scriptedParityEngine(p, c); } });
	await entered.promise;
	await assert.rejects(drainSchoolRuns({ ...options, now }), errorCode("WORKER_BUSY"));
	assert.throws(() => options.runStore.recoverDeadWorker(), errorCode("WORKER_ALIVE"));
	cancelSchoolRun(first.operationId, options);
	const done = await running; release.resolve();
	assert.equal(done.runs[0]?.status, "CANCELLED");
	assert.equal(options.store.read(first.operationId)?.calls[0]?.completion, "NO_CALL_ADMITTED");
	assert.equal(options.runStore.read(second.operationId)?.status, "QUEUED");
	assert.equal(options.store.read(second.operationId), null);
});

test("a cancellation marker written through another store instance is observed without overwriting worker state", async () => {
	const options = setup(), run = enqueue(options), entered = gate(), release = gate();
	const running = drainSchoolRuns({ ...options, now, engineFor: async (p, c) => { entered.resolve(); await release.promise; return scriptedParityEngine(p, c); } });
	await entered.promise;
	new SchoolRunStore(options.runStore.root).requestCancel(run.operationId, at);
	const done = await running; release.resolve();
	assert.equal(done.runs[0]?.status, "CANCELLED");
	assert.ok(done.runs[0]?.cancelRequestedAt);
});

test("unknown remote completion survives cancellation and reconciliation and blocks further automatic work", async () => {
	const options = setup(), first = enqueue(options), second = enqueue(options), dispatched = gate();
	const running = drainSchoolRuns({ ...options, now, engineFor: (p, c) => {
		const engine = scriptedParityEngine(p, c);
		engine.streamFn = () => { dispatched.resolve(); return { result: () => new Promise(() => {}) } as ReturnType<PiEngine["streamFn"]>; };
		return engine;
	} });
	await dispatched.promise; cancelSchoolRun(first.operationId, options);
	assert.equal((await running).runs[0]?.status, "UNRESOLVED");
	assert.equal(options.store.read(first.operationId)?.calls[0]?.completion, "UNKNOWN");
	assert.equal(reconcileSchoolRun(first.operationId, options).status, "UNRESOLVED");
	await assert.rejects(drainSchoolRuns({ ...options, now }), errorCode("WORK_UNRESOLVED"));
	assert.equal(options.runStore.read(second.operationId)?.status, "QUEUED");
	assert.equal(options.store.read(second.operationId), null);
	const originalEvidence = options.store.read(first.operationId);
	assert.throws(() => acknowledgeSchoolRunUncertainty(first.operationId, "", options), errorCode("REVIEW_NOTE_REQUIRED"));
	const reviewed = acknowledgeSchoolRunUncertainty(first.operationId, "Reviewed the endpoint separately; retain unknown completion and allow later work.", options);
	assert.equal(reviewed.status, "UNRESOLVED");
	assert.ok(reviewed.uncertaintyAcknowledgement);
	assert.equal((await drainSchoolRuns({ ...options, now })).runs[0]?.operationId, second.operationId);
	assert.deepEqual(options.store.read(first.operationId), originalEvidence, "review does not alter or replay uncertain evidence");
	assert.equal(options.runStore.read(first.operationId)?.status, "UNRESOLVED");
	assert.throws(() => acknowledgeSchoolRunUncertainty(first.operationId, "Different note", options), errorCode("ACKNOWLEDGEMENT_DRIFT"));
});

test("terminal episode evidence reconciles a worker bookkeeping crash with zero new calls", async () => {
	const options = setup(), run = enqueue(options);
	const lease = options.runStore.acquireWorker();
	options.runStore.writeOwned({ ...run, status: "RUNNING" }, lease); options.runStore.releaseWorker(lease);
	const original = (await runSchoolEpisode(run.manifest, options)).record;
	const restored = reconcileSchoolRun(run.operationId, { ...options, engineFor: () => { throw new Error("Reconciliation must never resolve a model"); } });
	assert.equal(restored.status, "COMPLETED"); assert.equal(restored.retainedCalls, 7);
	assert.deepEqual(options.store.read(run.operationId), original);
	assert.equal((await drainSchoolRuns({ ...options, now })).processed, 0);
	assert.equal(reconcileSchoolRun(run.operationId, options).status, "COMPLETED");
});

test("interruption before episode admission is reconciled as no episode, while a partial raw record stays unresolved", async () => {
	const options = setup(), absent = enqueue(options);
	let lease = options.runStore.acquireWorker(); options.runStore.writeOwned({ ...absent, status: "RUNNING" }, lease); options.runStore.releaseWorker(lease);
	assert.equal(reconcileSchoolRun(absent.operationId, options).errorCode, "NO_EPISODE_ADMITTED");
	const second = enqueue(options), captured: SchoolEpisodeRecord[] = [];
	class Observed extends SchoolEpisodeStore { override write(record: SchoolEpisodeRecord) { super.write(record); if (record.events.at(-1)?.kind === "RAW_REPLY_COMMITTED") captured.push(structuredClone(record)); } }
	await runSchoolEpisode(second.manifest, { ...options, store: new Observed(path.join(root, `observed-${++serial}`)) });
	options.store.claim(captured[0]!);
	lease = options.runStore.acquireWorker(); options.runStore.writeOwned({ ...second, status: "RUNNING" }, lease); options.runStore.releaseWorker(lease);
	const before = options.store.read(second.operationId);
	assert.equal(reconcileSchoolRun(second.operationId, options).status, "UNRESOLVED");
	assert.deepEqual(options.store.read(second.operationId), before);
});

test("a verified dead child worker can be retired; stale leases cannot release the new owner", () => {
	const options = setup();
	const modulePath = new URL("../src/store/school-runs.ts", import.meta.url).href;
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import {SchoolRunStore} from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(new SchoolRunStore(${JSON.stringify(options.runStore.root)}).acquireWorker()));`], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 10000 });
	assert.equal(result.status, 0, result.stderr);
	const dead = JSON.parse(result.stdout.trim());
	assert.throws(() => options.runStore.acquireWorker(), errorCode("WORKER_BUSY"));
	assert.equal(options.runStore.recoverDeadWorker(), true);
	const successor = options.runStore.acquireWorker();
	assert.throws(() => options.runStore.releaseWorker(dead), errorCode("WORKER_OWNERSHIP"));
	assert.throws(() => options.runStore.acquireWorker(), errorCode("WORKER_BUSY"));
	options.runStore.releaseWorker(successor);
	assert.equal(options.runStore.recoverDeadWorker(), false);
});

test("malformed persisted state refuses inspection and cannot dispatch", async () => {
	const options = setup(), run = enqueue(options);
	const filename = path.join(options.runStore.root, "runs", run.operationId, "run.json");
	const corrupt = { ...run, createdAt: 42 };
	writeFileSync(filename, JSON.stringify(corrupt));
	assert.throws(() => options.runStore.read(run.operationId), errorCode("RUN_CORRUPT"));
	await assert.rejects(drainSchoolRuns({ ...options, now }), errorCode("RUN_CORRUPT"));
	assert.equal(options.store.read(run.operationId), null);
});

test("fixture work cannot fall through to configured providers or cross evidence modes", async () => {
	const options = setup(); enqueue(options);
	await assert.rejects(drainSchoolRuns({ ...options, now, engineFor: undefined }), errorCode("FIXTURE_ENGINE_REQUIRED"));
	const configured = setup(); configured.runStore.enqueue({ manifest: input() });
	await assert.rejects(drainSchoolRuns({ ...configured, now: () => new Date("2030-01-01") }), errorCode("EVIDENCE_MODE_MISMATCH"));
});

test("queue HTTP is owner-only, lists no private manifest, and rejects fixture or execution overrides", async () => {
	const options = setup(), manifest = input();
	const request = (body: unknown, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/school/runs", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
	assert.equal((await schoolRunPost(request({ action: "enqueue", manifest }, "https://untrusted.example"), options)).status, 403);
	for (const addition of [{ evidence: "SCRIPTED_FIXTURE" }, { engineFor: "fixture" }, { endpoint: "http://localhost:1234" }]) assert.equal((await schoolRunPost(request({ action: "enqueue", manifest, ...addition }), options)).status, 400);
	const admitted = await schoolRunPost(request({ action: "enqueue", manifest }), options);
	assert.equal(admitted.status, 201); assert.equal((await admitted.json()).run.evidence, "CONFIGURED_PROVIDER");
	const listed = schoolRunGet(new Request("http://localhost:3000/api/school/runs"), options);
	assert.equal(listed.headers.get("cache-control"), "no-store"); assert.ok(!(await listed.text()).includes('"expected"'));
	assert.equal(options.store.read(manifest.operationId), null);
	assert.equal(schoolRunGet(new Request("http://localhost:3000/api/school/runs?operationId=a&operationId=b"), options).status, 400);
	assert.equal((await schoolRunPost(request({ action: "drain", maxCalls: 100000 }), options)).status, 400);
});

test("a crashed enqueue or worker start leaves only staging residue, never a visible incomplete run or lock", () => {
	const options = setup(), queue = options.runStore.root;
	// A crash before publication leaves its file under staging only.
	mkdirSync(path.join(queue, "staging", "crashed-enqueue"), { recursive: true });
	writeFileSync(path.join(queue, "staging", "crashed-enqueue", "run.json"), "{\"partial\":");
	mkdirSync(path.join(queue, "runs"), { recursive: true });
	assert.deepEqual(options.runStore.list(), []);
	const run = enqueue(options);
	assert.equal(existsSync(path.join(queue, "runs", run.operationId, "run.json")), true);
	assert.deepEqual(options.runStore.list().map((item) => item.operationId), [run.operationId]);
	assert.equal(options.runStore.enqueue({ manifest: run.manifest }, "SCRIPTED_FIXTURE", at).created, false);
	const lease = options.runStore.acquireWorker();
	assert.equal(existsSync(path.join(queue, "worker", "owner.json")), true, "the lock appears with its owner");
	options.runStore.releaseWorker(lease);
	assert.equal(existsSync(path.join(queue, "worker")), false);
	options.runStore.releaseWorker(options.runStore.acquireWorker());
	assert.equal(readdirSync(path.join(queue, "staging")).filter((name) => name !== "crashed-enqueue").length, 0, "publication and release leave no staging directories");
	// An empty directory claimed outside this protocol is still refused, not filled in.
	const claimed = input();
	mkdirSync(path.join(queue, "runs", claimed.operationId));
	assert.throws(() => options.runStore.enqueue({ manifest: claimed }, "SCRIPTED_FIXTURE", at), errorCode("RUN_CORRUPT"));
});
