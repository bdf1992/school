import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("the fixture CLI preserves unrelated legacy graph files and replays its exact operation", { timeout: 10000 }, () => {
	const scratch = mkdtempSync(path.join(tmpdir(), "school-episode-cli-"));
	try {
		const graph = path.join(scratch, "graph");
		mkdirSync(graph);
		for (const file of ["edges.jsonl", "events.jsonl"]) writeFileSync(path.join(graph, file), `sentinel ${file}\n`);
		const args = ["--import", "tsx", "scripts/school-episode.ts", "--fixture", "--operation", "isolated-cli", "--output", path.join(scratch, "evidence")];
		const env: NodeJS.ProcessEnv = { NODE_ENV: "test", HOME: scratch, LH_DATA_DIR: scratch, LH_AUTH_FILE: path.join(scratch, "auth.json"), LH_IGNORE_ENV_KEYS: "1" };
		const first = spawnSync(process.execPath, args, { cwd: path.resolve(import.meta.dirname, ".."), env, encoding: "utf8", timeout: 5000 });
		assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
		assert.equal(JSON.parse(first.stdout).evidence, "SCRIPTED_FIXTURE");
		assert.equal(JSON.parse(first.stdout).replayed, false);
		const again = spawnSync(process.execPath, args, { cwd: path.resolve(import.meta.dirname, ".."), env, encoding: "utf8", timeout: 5000 });
		assert.equal(again.status, 0, `${again.stderr}\n${again.stdout}`);
		assert.equal(JSON.parse(again.stdout).replayed, true);
		for (const file of ["edges.jsonl", "events.jsonl"]) assert.equal(readFileSync(path.join(graph, file), "utf8"), `sentinel ${file}\n`);
	} finally { rmSync(scratch, { recursive: true, force: true }); }
});
