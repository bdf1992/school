import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { piModels } from "../src/agent/models.ts";
import { refreshChatGPTModels, chatGPTModels, chatGPTStatus, chatGPTConnected, chatGPTBackgroundAllowed, chatGPTScope, chatGPTScopeCurrent, chatGPTLease, chatGPTAbortController } from "../src/agent/chatgpt-bridge.ts";
const send = Object.getOwnPropertyDescriptor(process, "send"), connected = Object.getOwnPropertyDescriptor(process, "connected");
const desktopMarker = process.env.LH_DESKTOP_SERVER, desktopSecret = process.env.LH_DESKTOP_API_SECRET;
const pending: any[] = [];
const model = piModels().getModels("openai").find((m) => m.api === "openai-responses")!;
const ipc = (m: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", m);
const status = (account: string, background = true) => ({ available: true, pending: false, allowBackgroundUse: background, activeId: account, accounts: [{ id: account, connected: true, background: !background, planEnabled: true }], error: null });
const value = (name: string, revision: number, account = "A", authorityRevision = 1) => ({ epoch: account === "A" ? 1 : 2, authorityRevision, revision, status: status(account), accountId: account, models: [{ id: model.id, name }] });
function reply(request: any, v: unknown) { ipc({ channel: "lh:chatgpt", id: request.id, op: request.op, ok: true, value: v }); }
before(() => {
 process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
 Object.defineProperty(process, "connected", { configurable: true, value: true });
 Object.defineProperty(process, "send", { configurable: true, value: (m: unknown, cb?: () => void) => { pending.push(m); cb?.(); return true; } });
});
after(() => {
 if (desktopMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = desktopMarker;
 if (desktopSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = desktopSecret;
 if (send) Object.defineProperty(process, "send", send); else delete process.send;
 if (connected) Object.defineProperty(process, "connected", connected); else delete (process as { connected?: boolean }).connected;
});
test("overlapping catalog requests only install the newest generation", async () => {
 const old = refreshChatGPTModels([model as never]), latest = refreshChatGPTModels([model as never]);
 reply(pending[1], value("newest", 2)); await latest;
 reply(pending[0], value("stale", 1)); await old;
 assert.equal(chatGPTModels()[0]?.name, "newest");
});
test("consent-only status does not discard current-authority catalog or overwrite newer consent from an old status embedded in models", async () => {
 const refresh = refreshChatGPTModels([model as never]); const request = pending.at(-1);
 ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 1, authorityRevision: 1, revision: 3 }, status: status("A", false), invalidate: "background" });
 reply(request, value("same authority", 2)); await refresh;
 assert.equal(chatGPTModels()[0]?.name, "same authority"); assert.equal(chatGPTStatus().allowBackgroundUse, false);
 const scope = chatGPTScope(model.id); assert(chatGPTScopeCurrent(scope));
 const foreground = chatGPTAbortController(false), background = chatGPTAbortController(true);
 ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 1, authorityRevision: 1, revision: 4 }, status: status("A", false), invalidate: "background" });
 ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 1, authorityRevision: 1, revision: 5 }, status: status("A", true), invalidate: "none" });
 assert(!foreground.controller.signal.aborted); assert(background.controller.signal.aborted); assert(chatGPTScopeCurrent(scope));
 foreground.release(); background.release();
});
test("account/full and catalog authority changes reject outstanding old leases without silently switching identity", async () => {
 const scope = chatGPTScope(model.id); const lease = chatGPTLease(scope, false); const request = pending.at(-1);
 ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 2, authorityRevision: 2, revision: 6 }, status: status("B"), invalidate: "all" });
 assert.equal(chatGPTModels().length, 0); assert(!chatGPTScopeCurrent(scope));
 reply(request, { epoch: 1, authorityRevision: 1, revision: 5, accountId: "A", accessToken: "dummy-old" });
 await assert.rejects(lease, /stale/);
 const refresh = refreshChatGPTModels([model as never]); reply(pending.at(-1), value("B", 7, "B", 2)); await refresh;
 const newScope = chatGPTScope(model.id); assert.equal(newScope.accountId, "B");
 ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 2, authorityRevision: 3, revision: 8 }, status: status("B"), invalidate: "none" });
 assert.equal(chatGPTModels().length, 0); await assert.rejects(chatGPTLease(newScope, false));
});

test("an older cold refresh waits for the newer catalog before its caller can inspect readiness", async () => {
 ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 2, authorityRevision: 4, revision: 10 }, status: { ...status("B"), available: false }, invalidate: "all" });
 let firstReturned = false;
 const first = refreshChatGPTModels([model as never]).then(() => { firstReturned = true; return chatGPTConnected(); });
 const firstRequest = pending.at(-1);
 const second = refreshChatGPTModels([model as never]);
 const secondRequest = pending.at(-1);
 try {
  reply(firstRequest, value("older", 11, "B", 4));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstReturned, false, "a superseded response is not completed readiness");
  assert.equal(chatGPTConnected(), false);
 } finally {
  reply(secondRequest, value("ready", 12, "B", 4));
  await Promise.all([first, second]);
 }
 assert.equal(await first, true);
 assert.equal(chatGPTModels()[0]?.name, "ready");
});

test("a superseded caller also waits for a third refresh, whose failure leaves no catalog", async () => {
 const first = refreshChatGPTModels([model as never]), firstRequest = pending.at(-1);
 const second = refreshChatGPTModels([model as never]), secondRequest = pending.at(-1);
 let firstReturned = false;
 const observed = first.then(() => { firstReturned = true; });
 reply(firstRequest, value("first", 13, "B", 4));
 await new Promise((resolve) => setImmediate(resolve));
 const third = refreshChatGPTModels([model as never]), thirdRequest = pending.at(-1);
 try {
  reply(secondRequest, value("second", 14, "B", 4));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstReturned, false, "readiness follows the current refresh, including later overlap");
 } finally {
  ipc({ channel: "lh:chatgpt", id: thirdRequest.id, op: thirdRequest.op, ok: false, error: "Synthetic catalog failure" });
  await Promise.all([observed, second, third]);
 }
 assert.equal(chatGPTModels().length, 0, "an old successful response must not undo the latest failure");
});

test("overlapping refreshes preserve the newest supported-model filter and current background refusal", async () => {
 const first = refreshChatGPTModels([model as never]), firstRequest = pending.at(-1);
 const second = refreshChatGPTModels([]), secondRequest = pending.at(-1);
 ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 2, authorityRevision: 4, revision: 17 }, status: status("B", false), invalidate: "background" });
 reply(firstRequest, value("old filter", 15, "B", 4));
 reply(secondRequest, value("new filter", 16, "B", 4));
 await Promise.all([first, second]);
 assert.equal(chatGPTModels().length, 0, "different supported catalogs must not be coalesced using the first caller's filter");
 assert.equal(chatGPTStatus().allowBackgroundUse, false);
 assert.equal(chatGPTBackgroundAllowed(), false);
});

test("full invalidation while refreshes are pending cannot restore a superseded account catalog", async () => {
 const first = refreshChatGPTModels([model as never]), firstRequest = pending.at(-1);
 const second = refreshChatGPTModels([model as never]), secondRequest = pending.at(-1);
 ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 3, authorityRevision: 5, revision: 20 }, status: status("C", false), invalidate: "all" });
 reply(firstRequest, value("old account first", 18, "B", 4));
 reply(secondRequest, value("old account second", 19, "B", 4));
 await Promise.all([first, second]);
 assert.equal(chatGPTStatus().activeId, "C");
 assert.equal(chatGPTModels().length, 0);
 assert.equal(chatGPTBackgroundAllowed(), false);
});

test("desktop disconnect settles every overlapping refresh without retaining readiness", async () => {
 const first = refreshChatGPTModels([model as never]);
 const second = refreshChatGPTModels([model as never]);
 Object.defineProperty(process, "connected", { configurable: true, value: false });
 try {
  process.emit("disconnect");
  await Promise.all([first, second]);
  assert.equal(chatGPTConnected(), false);
  assert.equal(chatGPTModels().length, 0);
 } finally {
  Object.defineProperty(process, "connected", { configurable: true, value: true });
 }
});
