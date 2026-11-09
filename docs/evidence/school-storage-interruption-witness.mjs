/**
 * Reproduce four storage interruption boundaries against current source and the
 * pre-fix implementation. Requires Git history containing 863f9fd, installed
 * dependencies, and a POSIX platform with SIGKILL.
 *
 * Run from the repository:
 *   node --import tsx docs/evidence/school-storage-interruption-witness.mjs
 *   node --import tsx docs/evidence/school-storage-interruption-witness.mjs --output /tmp/school-storage-interruption.json
 * Optional: --repo /absolute/path/to/school
 *
 * Only fresh temporary source copies and synthetic data roots are modified.
 * Temporary files are removed after the run; --output exclusively creates a new
 * JSON file. The same JSON is printed to stdout. No providers are dispatched.
 * This verifies deterministic process interruption, not power-loss durability.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
	readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { arch, platform, release, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const revertedFiles = [
	"src/store/school-runs.ts",
	"src/store/school-participants.ts",
	"src/core/school-experiment.ts",
].sort();
const baselineRef = "863f9fd";
const options = { repo: fileURLToPath(new URL("../../", import.meta.url)), output: undefined };
for (let index = 2; index < process.argv.length; index++) {
	const argument = process.argv[index];
	if (argument === "--help") {
		console.log("Usage: node --import tsx docs/evidence/school-storage-interruption-witness.mjs [--repo PATH] [--output NEW_JSON_FILE]");
		process.exit(0);
	}
	if (!["--repo", "--output"].includes(argument) || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) {
		throw new Error(`Unknown option or missing value: ${argument}`);
	}
	options[argument.slice(2)] = path.resolve(process.argv[++index]);
}
assert.notEqual(platform(), "win32", "This witness requires POSIX SIGKILL semantics");
if (options.output && existsSync(options.output)) throw new Error(`Output already exists: ${options.output}`);

const repository = realpathSync(options.repo);
function git(...args) {
	return execFileSync("git", args, { cwd: repository, maxBuffer: 32 * 1024 * 1024 });
}
assert.equal(realpathSync(git("rev-parse", "--show-toplevel").toString().trim()), repository, "--repo must name the repository root");
const currentHead = git("rev-parse", "HEAD").toString().trim();
const preFixSourceCommit = git("rev-parse", "--verify", `${baselineRef}^{commit}`).toString().trim();
const workingTreeStatus = git("status", "--porcelain=v1").toString();
const trackedPaths = git("ls-files", "-z").toString().split("\0").filter(Boolean).sort();
const requireFromRepository = createRequire(path.join(repository, "package.json"));
const tsxLoader = pathToFileURL(requireFromRepository.resolve("tsx")).href;
const { register } = await import(pathToFileURL(requireFromRepository.resolve("tsx/esm/api")).href);
const dependencies = realpathSync(path.join(repository, "node_modules"));
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "school-storage-interruption-"));
const current = path.join(temporaryRoot, "current");
const preFix = path.join(temporaryRoot, "pre-fix");
const outcomes = [];
let unregister;
let report;

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function inspect(action) {
	try { return { ok: true, result: action() }; }
	catch (error) { return { ok: false, code: error.code, message: error.message }; }
}
function sourceInventory(directory) {
	return trackedPaths.flatMap((relative) => {
		const absolute = path.join(directory, relative);
		let info;
		try { info = lstatSync(absolute); }
		catch (error) { if (error.code === "ENOENT") return []; throw error; }
		assert.ok(info.isFile() || info.isSymbolicLink(), `Unsupported tracked entry: ${relative}`);
		return [{ path: relative, type: info.isSymbolicLink() ? "symlink" : "file", sha256: sha256(info.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute)) }];
	});
}
function dataInventory(directory) {
	const files = [], directories = [];
	function visit(relative) {
		for (const name of readdirSync(path.join(directory, relative)).sort()) {
			const child = path.join(relative, name), absolute = path.join(directory, child);
			const info = lstatSync(absolute);
			if (info.isDirectory()) { directories.push(child); visit(child); }
			else {
				assert.ok(info.isFile(), `Unexpected synthetic data entry: ${child}`);
				const bytes = readFileSync(absolute);
				files.push({ path: child, bytes: bytes.length, sha256: sha256(bytes), validJson: inspect(() => JSON.parse(bytes.toString("utf8"))).ok });
			}
		}
	}
	visit("");
	return { files, directories };
}

try {
	// Copy tracked working-tree bytes, including tracked edits, without copying
	// the original Git metadata, application data, or installed dependencies.
	const originalSources = sourceInventory(repository);
	mkdirSync(current);
	for (const entry of originalSources) {
		const destination = path.join(current, entry.path);
		mkdirSync(path.dirname(destination), { recursive: true });
		cpSync(path.join(repository, entry.path), destination, { verbatimSymlinks: true });
	}
	const currentSources = sourceInventory(current);
	assert.deepEqual(currentSources, originalSources, "Source changed while taking the snapshot");
	cpSync(current, preFix, { recursive: true, verbatimSymlinks: true });
	for (const relative of revertedFiles) writeFileSync(path.join(preFix, relative), git("show", `${preFixSourceCommit}:${relative}`));
	const preFixSources = sourceInventory(preFix);
	assert.deepEqual(preFixSources.map((entry) => entry.path), currentSources.map((entry) => entry.path));
	const differingPaths = currentSources.filter((entry, index) => entry.sha256 !== preFixSources[index].sha256 || entry.type !== preFixSources[index].type).map((entry) => entry.path).sort();
	assert.deepEqual(differingPaths, revertedFiles, "The comparison must differ in exactly the three intended implementation files");
	for (const directory of [current, preFix]) symlinkSync(dependencies, path.join(directory, "node_modules"), "dir");
	unregister = register({ tsconfig: path.join(current, "tsconfig.json") });
	const manifestPath = "examples/school/byte-parity.json";
	const manifest = JSON.parse(readFileSync(path.join(current, manifestPath), "utf8"));
	manifest.operationId = "process-crash-witness";
	const definition = { version: 1, id: "learner", label: "learner", kind: "model" };
	mkdirSync(path.join(temporaryRoot, "data"));

	for (const [variant, source] of [["current", current], ["pre_fix", preFix]]) {
		const { SchoolRunStore } = await import(pathToFileURL(path.join(source, "src/store/school-runs.ts")).href);
		const { SchoolParticipantStore } = await import(pathToFileURL(path.join(source, "src/store/school-participants.ts")).href);
		for (const operation of ["enqueue", "acquire_worker", "register", "release_worker"]) {
			const directory = mkdtempSync(path.join(temporaryRoot, "data", `${variant}-${operation}-`));
			const child = `
				import fs from "node:fs";
				import path from "node:path";
				import { syncBuiltinESMExports } from "node:module";
				import { pathToFileURL } from "node:url";
				const source = ${JSON.stringify(source)}, directory = ${JSON.stringify(directory)}, operation = ${JSON.stringify(operation)};
				const manifest = ${JSON.stringify(manifest)}, definition = ${JSON.stringify(definition)};
				const realOpen = fs.openSync, realWrite = fs.writeFileSync, realRemove = fs.rmSync, realUnlink = fs.unlinkSync;
				const descriptors = new Map();
				const isSynthetic = (filename) => typeof filename === "string" && filename.startsWith(directory + path.sep);
				fs.openSync = function(file, ...rest) {
					const fd = realOpen(file, ...rest);
					descriptors.set(fd, String(file));
					return fd;
				};
				fs.writeFileSync = function(file, data, ...rest) {
					const filename = typeof file === "number" ? descriptors.get(file) : String(file);
					const name = filename ? path.basename(filename) : "";
					const selected = isSynthetic(filename) && (operation === "enqueue" ? name.startsWith("run.json")
						: operation === "acquire_worker" ? name === "owner.json"
						: operation === "register" ? name.startsWith("definition") : false);
					if (selected) {
						const bytes = Buffer.from(data), partial = bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2)));
						realWrite(file, partial, ...rest);
						fs.writeSync(1, JSON.stringify({ cut: "after_partial_write_before_publication", file: path.relative(directory, filename), fullBytes: bytes.length, writtenBytes: partial.length }) + "\\n");
						process.kill(process.pid, "SIGKILL");
						throw new Error("SIGKILL unexpectedly returned");
					}
					return realWrite(file, data, ...rest);
				};
				fs.rmSync = function(target, ...rest) {
					if (operation === "release_worker" && isSynthetic(String(target)) && (path.basename(String(target)) === "worker" || path.basename(String(target)).startsWith("released-"))) {
						realUnlink(path.join(String(target), "owner.json"));
						fs.writeSync(1, JSON.stringify({ cut: "during_worker_recursive_removal_after_owner_unlink", target: path.relative(directory, String(target)) }) + "\\n");
						process.kill(process.pid, "SIGKILL");
						throw new Error("SIGKILL unexpectedly returned");
					}
					return realRemove(target, ...rest);
				};
				syncBuiltinESMExports();
				const { SchoolRunStore } = await import(pathToFileURL(path.join(source, "src/store/school-runs.ts")).href);
				const { SchoolParticipantStore } = await import(pathToFileURL(path.join(source, "src/store/school-participants.ts")).href);
				if (operation === "enqueue") new SchoolRunStore(directory).enqueue({ manifest }, "SCRIPTED_FIXTURE", "2026-11-09T16:00:00.000Z");
				else if (operation === "acquire_worker") new SchoolRunStore(directory).acquireWorker();
				else if (operation === "register") new SchoolParticipantStore(directory).createParticipant(definition);
				else { const store = new SchoolRunStore(directory); store.releaseWorker(store.acquireWorker()); }
				throw new Error("The injected process interruption was not reached");
			`;
			const result = spawnSync(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", child], {
				cwd: source, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
				env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"), LH_IGNORE_ENV_KEYS: "1" },
			});
			assert.equal(result.error, undefined, `${variant}/${operation}: child failed or timed out: ${result.error}`);
			assert.equal(result.signal, "SIGKILL", `${variant}/${operation}: ${result.stderr}`);
			assert.equal(result.status, null);
			const trace = JSON.parse(result.stdout.trim());
			const { files: filesAfterCrash, directories: directoriesAfterCrash } = dataInventory(directory);
			if (operation !== "release_worker") {
				assert.equal(filesAfterCrash.length, 1);
				assert.equal(filesAfterCrash[0].path, trace.file);
				assert.equal(filesAfterCrash[0].bytes, trace.writtenBytes);
				assert.equal(filesAfterCrash[0].validJson, false);
				assert.ok(trace.writtenBytes > 0 && trace.writtenBytes < trace.fullBytes);
			} else assert.deepEqual(filesAfterCrash, []);
			const publishedPath = operation === "enqueue" ? path.join("runs", manifest.operationId)
				: operation === "register" ? path.join("participants", definition.id) : "worker";
			const publishedDirectoryExists = existsSync(path.join(directory, publishedPath));
			assert.equal(publishedDirectoryExists, variant === "pre_fix");
			const observations = {};
			if (operation === "enqueue") {
				const store = new SchoolRunStore(directory);
				observations.list = inspect(() => store.list());
				observations.read = inspect(() => store.read(manifest.operationId));
				observations.retry = inspect(() => store.enqueue({ manifest }, "SCRIPTED_FIXTURE", "2026-11-09T16:00:00.000Z").created);
				if (variant === "current") {
					assert.deepEqual(observations.list, { ok: true, result: [] });
					assert.deepEqual(observations.read, { ok: true, result: null });
					assert.deepEqual(observations.retry, { ok: true, result: true });
				} else for (const check of Object.values(observations)) assert.equal(check.code, "RUN_CORRUPT");
			} else if (operation === "register") {
				const store = new SchoolParticipantStore(directory);
				observations.list = inspect(() => store.list());
				observations.read = inspect(() => store.inspectParticipant(definition.id));
				observations.retry = inspect(() => store.createParticipant(definition).created);
				if (variant === "current") {
					assert.deepEqual(observations.list, { ok: true, result: { participants: [], states: [], connections: [] } });
					assert.deepEqual(observations.read, { ok: true, result: null });
					assert.deepEqual(observations.retry, { ok: true, result: true });
				} else for (const check of Object.values(observations)) assert.equal(check.code, "INCOMPLETE_OR_CORRUPT_REGISTRY");
			} else {
				const store = new SchoolRunStore(directory);
				observations.recovery = inspect(() => store.recoverDeadWorker());
				observations.acquire = inspect(() => { const lease = store.acquireWorker(); store.releaseWorker(lease); return "acquired_and_released"; });
				if (variant === "current") {
					assert.deepEqual(observations.recovery, { ok: true, result: false });
					assert.deepEqual(observations.acquire, { ok: true, result: "acquired_and_released" });
				} else {
					assert.equal(observations.recovery.code, "WORKER_INCOMPLETE");
					assert.equal(observations.acquire.code, "WORKER_BUSY");
				}
			}
			outcomes.push({ variant, operation, childExit: { status: result.status, signal: result.signal }, trace, publishedPath, publishedDirectoryExists, filesAfterCrash, directoriesAfterCrash, observations, expectedBehaviorObserved: true });
		}
	}
	assert.equal(outcomes.length, 8);
	report = {
		status: "PASSED", checkedAt: new Date().toISOString(), node: process.version,
		testedPlatform: { platform: platform(), release: release(), arch: arch() },
		currentHead, preFixSourceCommit, processKillWitnesses: outcomes.length,
		provenance: {
			scriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), workingTreeStatus,
			trackedSnapshotFiles: currentSources.length, currentTrackedSnapshotSha256: sha256(JSON.stringify(currentSources)),
			preFixTrackedSnapshotSha256: sha256(JSON.stringify(preFixSources)), differingPaths,
			sources: revertedFiles.map((relative) => ({ path: relative, currentSha256: sha256(readFileSync(path.join(current, relative))), preFixSha256: sha256(readFileSync(path.join(preFix, relative))) })),
			fixture: { path: manifestPath, sha256: sha256(readFileSync(path.join(current, manifestPath))) },
			packageLockSha256: sha256(readFileSync(path.join(current, "package-lock.json"))),
			tsxVersion: JSON.parse(readFileSync(requireFromRepository.resolve("tsx/package.json"), "utf8")).version,
		},
		outcomes,
		limits: [
			"Deterministic SIGKILL process interruptions after real partial writes or a real owner-file unlink; not power-loss or filesystem-recovery tests.",
			"All store operations use fresh synthetic local roots. No model, credential, or external endpoint is used.",
			"These eight witnesses are separate from the checked-in regression tests, which inject exceptions before selected write/open calls.",
			"The pre-fix comparison changes only the three listed implementation files; every other tracked file retains its current working-tree bytes.",
		],
	};
} finally {
	if (unregister) await unregister();
	rmSync(temporaryRoot, { recursive: true, force: true });
}
report.temporaryFilesRemoved = true;
const json = JSON.stringify(report, null, 2) + "\n";
if (options.output) writeFileSync(options.output, json, { flag: "wx", mode: 0o600 });
process.stdout.write(json);
