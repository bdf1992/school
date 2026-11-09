/** Explicit CLI owner for the durable School queue. No implicit daemon starts. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { schoolRunSummary } from "../src/core/school-run.ts";
import { SchoolRunStore } from "../src/store/school-runs.ts";
import { SchoolEpisodeStore } from "../src/store/school-episodes.ts";
import { SchoolClassStore } from "../src/store/school-classes.ts";
import { SchoolParticipantStore } from "../src/store/school-participants.ts";
import { acknowledgeSchoolRunUncertainty, cancelSchoolRun, drainSchoolRuns, reconcileSchoolRun, schoolRuns, type SchoolRunOptions } from "../src/server/school-runs.ts";

async function main() {
	const args = process.argv.slice(2), action = args.shift();
	if (!action || action === "--help") {
		console.log("Usage: npm run school:worker -- <list|enqueue|once|watch|cancel|reconcile|recover-worker|acknowledge-uncertainty> [manifest.json or operation-id] [--school <root>] [--not-before <ISO>] [--max-calls <1-128>] [--note <review note>]\nAn explicit once/watch invocation may call the configured providers for due queued work. Watch polls every two seconds until SIGINT/SIGTERM.\nEnqueue only saves work; it makes no inference calls. Cancel records owner intent and requests cooperative cancellation.\nReconcile reads existing evidence only. Unknown provider completion remains unresolved and blocks later queued work.\nRecover-worker only retires a verifiably dead same-host worker lease; it does not replay work.\nAcknowledge-uncertainty requires a review note, permits later work, and leaves the original completion unknown. It never retries the original operation.");
		return;
	}
	if (!["list", "enqueue", "once", "watch", "cancel", "reconcile", "recover-worker", "acknowledge-uncertainty"].includes(action)) throw new Error("Unknown worker action");
	let subject: string | undefined, root: string | undefined, notBefore: string | undefined, maxCalls: number | undefined, note: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (["--school", "--not-before", "--max-calls", "--note"].includes(arg)) {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
			if (arg === "--school") root = value;
			else if (arg === "--not-before") notBefore = value;
			else if (arg === "--note") note = value;
			else maxCalls = Number(value);
		} else if (arg.startsWith("-") || subject) throw new Error(`Unexpected argument: ${arg}`);
		else subject = arg;
	}
	if (["enqueue", "cancel", "reconcile", "acknowledge-uncertainty"].includes(action) !== Boolean(subject)) throw new Error("Enqueue needs a manifest; cancel/reconcile/acknowledge-uncertainty need an operation ID; other commands take no positional argument");
	if ((action === "acknowledge-uncertainty") !== (note !== undefined)) throw new Error("Only acknowledge-uncertainty requires --note");
	if (action !== "enqueue" && notBefore !== undefined) throw new Error("--not-before applies only to enqueue");
	if (!["enqueue", "once", "watch"].includes(action) && maxCalls !== undefined) throw new Error("--max-calls applies only to enqueue or execution");
	const options: SchoolRunOptions = root ? { runStore: new SchoolRunStore(path.resolve(root, "queue")), store: new SchoolEpisodeStore(path.resolve(root, "episodes")), classStore: new SchoolClassStore(path.resolve(root, "classes")), registry: new SchoolParticipantStore(path.resolve(root, "registry")) } : {};
	const queue = options.runStore ?? schoolRuns;
	if (action === "list") console.log(JSON.stringify({ runs: queue.list().map(schoolRunSummary) }, null, 2));
	else if (action === "enqueue") {
		const bytes = readFileSync(path.resolve(subject!));
		if (bytes.byteLength > 64 * 1024) throw new Error("Episode manifest exceeds 64 KiB");
		const result = queue.enqueue({ manifest: JSON.parse(bytes.toString("utf8")), ...(notBefore ? { notBefore } : {}), ...(maxCalls === undefined ? {} : { maxCalls }) });
		console.log(JSON.stringify({ created: result.created, run: schoolRunSummary(result.run) }, null, 2));
	} else if (action === "cancel" || action === "reconcile") console.log(JSON.stringify({ run: schoolRunSummary(action === "cancel" ? cancelSchoolRun(subject!, options) : reconcileSchoolRun(subject!, options)) }, null, 2));
	else if (action === "recover-worker") console.log(JSON.stringify({ recovered: queue.recoverDeadWorker() }));
	else if (action === "acknowledge-uncertainty") console.log(JSON.stringify({ run: schoolRunSummary(acknowledgeSchoolRunUncertainty(subject!, note, options)) }, null, 2));
	else {
		const abort = new AbortController(), cancel = () => abort.abort(new Error("Worker stopped by owner"));
		process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
		try {
			do {
				console.log(JSON.stringify(await drainSchoolRuns({ ...options, signal: abort.signal, ...(maxCalls === undefined ? {} : { maxCalls }) }), null, 2));
				if (action !== "watch" || abort.signal.aborted) break;
				await new Promise<void>((resolve) => {
					const finish = () => { clearTimeout(timer); abort.signal.removeEventListener("abort", finish); resolve(); };
					const timer = setTimeout(finish, 2000);
					abort.signal.addEventListener("abort", finish, { once: true });
					if (abort.signal.aborted) finish();
				});
			} while (!abort.signal.aborted);
		} finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
	}
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
