import { closeSync, fsyncSync, ftruncateSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CONTEXTS, OllamaContextError, contextCandidates, localOllamaUrl, probeOllamaContexts } from "../src/agent/ollama-context.ts";

const HELP = `Usage: npm run school:context -- --model <installed-model> [--prepare | --run] [--contexts 16384,32768,65536] [--endpoint http://127.0.0.1:11434] [--output <new-report.json>] [--timeout-ms 300000]
Default: inspect the installed local GGUF; no model is loaded and no profile is created.
--prepare creates named context profiles from existing weights; no generation.
--run prepares and sequentially tests profiles using synthetic beginning/middle/end checks.
Only literal loopback Ollama endpoints and positively identified local GGUF models are admitted.
No cloud/API fallback, model download, global setting change, or School setting write occurs.
--prepare and --run require a new output filename. Its parent directory must already exist.
Results report the actual prompt span, allocation, speed and memory snapshots separately.
The default request deadline is five minutes; 1000–1800000 ms is allowed.`;

function writeReport(descriptor: number, value: unknown): void {
	const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
	for (let offset = 0; offset < bytes.byteLength;) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
	ftruncateSync(descriptor, bytes.byteLength); fsyncSync(descriptor);
}
async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (!args.length || args.includes("--help")) { console.log(HELP); return; }
	const options = new Map<string, string>(), modes: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const key = args[index]!;
		if (key === "--prepare" || key === "--run") { modes.push(key); continue; }
		const value = args[++index];
		if (!["--model", "--contexts", "--endpoint", "--output", "--timeout-ms"].includes(key) || options.has(key) || !value || value.startsWith("--")) throw new Error(HELP);
		options.set(key, value);
	}
	if (!options.has("--model") || modes.length > 1 || modes.length && !options.has("--output")) throw new Error(HELP);
	const contextText = options.get("--contexts");
	if (contextText && !/^\d+(?:,\d+)*$/.test(contextText)) throw new Error("contexts must be comma-separated decimal integers");
	const contexts = contextCandidates(contextText ? contextText.split(",").map(Number) : DEFAULT_CONTEXTS);
	const timeoutText = options.get("--timeout-ms") ?? "300000";
	if (!/^[1-9]\d*$/.test(timeoutText)) throw new Error("timeout-ms must be a positive decimal integer");
	const endpoint = localOllamaUrl(options.get("--endpoint") ?? "http://127.0.0.1:11434");
	const output = options.get("--output"), descriptor = output ? openSync(path.resolve(output), "wx", 0o600) : undefined;
	try {
		if (descriptor !== undefined) writeReport(descriptor, { version: 1, kind: "school-local-context", outcome: "PENDING", settingsChanged: false });
		const report = await probeOllamaContexts({
			model: options.get("--model")!, endpoint, contexts, timeoutMs: Number(timeoutText), mode: modes[0] === "--run" ? "run" : modes[0] === "--prepare" ? "prepare" : "inspect",
			onProgress: (current, message) => { if (descriptor !== undefined) writeReport(descriptor, current); console.error(message); },
		});
		if (descriptor !== undefined) writeReport(descriptor, report);
		console.log(JSON.stringify(report, null, 2));
		process.exitCode = report.outcome === "PASSED" ? 0 : 1;
	} catch (error) {
		if (descriptor !== undefined) writeReport(descriptor, { version: 1, kind: "school-local-context", outcome: "FAILED", settingsChanged: false, error: { code: error instanceof OllamaContextError ? error.code : "CLI_FAILED", message: error instanceof OllamaContextError ? error.message : "The local context command did not complete." } });
		throw error;
	} finally { if (descriptor !== undefined) closeSync(descriptor); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Local context experiment failed"); process.exitCode = 1; });
