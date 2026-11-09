/** Actual loopback HTTP + the production configured custom Pi engine. No model
 * server, paid request, account, external fetch or new provider stack is used. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { SchoolEpisodeStore } from "../src/store/school-episodes.ts";
import { parseSchoolEpisode } from "../src/core/school-episode.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "school-episode-http-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { ...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}), NODE_ENV: "test", HOME: scratch, LH_DATA_DIR: scratch, LH_AUTH_FILE: path.join(scratch, "auth.json"), LH_IGNORE_ENV_KEYS: "1", NO_PROXY: "localhost,127.0.0.1,::1" };
globalThis.fetch = async () => { throw new Error("CLOSED: test endpoint is not ready"); };
const { runSchoolEpisode } = await import("../src/server/school-episodes.ts");
const { schoolClasses } = await import("../src/server/school-state.ts");
schoolClasses.create({ ...JSON.parse(readFileSync(new URL("../examples/school/byte-parity-class.json", import.meta.url), "utf8")), roster: [{ participantId: "local-learner-fixture", roles: ["learner"] }, { participantId: "local-teacher-fixture", roles: ["teacher"] }] });
const { writeSettings } = await import("../src/store/settings.ts");
const { authorizeFixture } = await import("./helpers/custom-provider-auth.ts");
after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; rmSync(scratch, { recursive: true, force: true }); });

test("configured local models traverse the existing OpenAI-compatible HTTP route with isolated prompts", { timeout: 10000 }, async () => {
	const requests: Record<string, unknown>[] = [];
	const transportErrors: string[] = [];
	const fetchErrors: string[] = [];
	const server = createServer(async (request, response) => {
		try {
			assert.equal(request.url, "/v1/chat/completions");
			assert.equal(request.method, "POST");
			assert.equal(request.headers.authorization, "Bearer not-needed");
			let data = "";
			for await (const chunk of request) data += chunk;
			const body = JSON.parse(data);
			requests.push(body);
			assert.equal(body.model, "loopback-parity");
			assert.equal(body.max_completion_tokens, 128);
			assert.ok(!body.tools?.length);
			const user = body.messages.findLast((m: { role: string }) => m.role === "user");
			const view = JSON.parse(typeof user.content === "string" ? user.content : user.content.map((p: { text?: string }) => p.text ?? "").join(""));
			let answer: string;
			if (view.teachingExamples) {
				assert.ok(!JSON.stringify(view).includes("10110001"), "held-out byte stays out of teacher payload");
				answer = "Count 1 bits: an even count means EVEN and an odd count means ODD.";
			} else {
				assert.ok(!JSON.stringify(view).includes('"expected"'));
				const bits = view.problem.observations[0].content as string;
				answer = [...bits].filter((b) => b === "1").length % 2 ? "ODD" : "EVEN";
				if (!view.lesson && bits === "10110001") answer = "ODD"; // Scripted transport defect.
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`data: ${JSON.stringify({ id: `fixture-${requests.length}`, model: "loopback-parity", choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
		} catch (error) { transportErrors.push(String(error)); response.writeHead(500); response.end(String(error)); }
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const origin = `http://127.0.0.1:${address.port}`;
	globalThis.fetch = async (input, init) => {
		try {
			const target = input instanceof Request ? input.url : String(input);
			assert.equal(new URL(target).origin, origin, "all HTTP stays inside the owned fake endpoint");
			return await originalFetch(input, init);
		} catch (error) { fetchErrors.push(`${String(error)}; cause: ${error instanceof Error ? String(error.cause) : "none"}`); throw error; }
	};
	try {
		writeSettings({ version: 1, customProvider: authorizeFixture({ baseUrl: `${origin}/v1`, authMode: "keyless", models: [{ id: "loopback-parity", context: 8192, maxTokens: 512, reasoning: false }] }) });
		const input = parseSchoolEpisode(JSON.parse(readFileSync(new URL("../examples/school/byte-parity.json", import.meta.url), "utf8")));
		input.operationId = "loopback-fixture";
		input.learner = { id: "local-learner-fixture", model: { provider: "custom", id: "loopback-parity", thinkingLevel: "off" } };
		input.teacher = { id: "local-teacher-fixture", model: { provider: "custom", id: "loopback-parity", thinkingLevel: "off" } };
		input.limits.maxOutputTokens = 128;
		const store = new SchoolEpisodeStore(path.join(scratch, "episodes"));
		const result = await runSchoolEpisode(input, { store, evidence: "SCRIPTED_FIXTURE" });
		assert.equal(result.record.status, "COMPLETED", JSON.stringify({ error: result.record.error, nativeError: result.record.calls.at(-1)?.reply?.errorMessage, transportErrors, fetchErrors }));
		assert.equal(requests.length, 7);
		assert.equal(result.record.comparison?.outcome, "CONTEXTUAL_GAIN");
		for (const call of result.record.calls) {
			assert.equal(call.resolvedModel?.provider, "custom");
			assert.equal(call.reply?.provider, "custom");
			assert.equal(call.reply?.model, "loopback-parity");
			assert.equal(call.reply?.usage.input, 20);
		}
		assert.equal((await runSchoolEpisode(input, { store, evidence: "SCRIPTED_FIXTURE" })).replayed, true);
		assert.equal(requests.length, 7, "completed retry performs zero HTTP requests");
	} finally {
		globalThis.fetch = async () => { throw new Error("CLOSED: fake endpoint has stopped"); };
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});
