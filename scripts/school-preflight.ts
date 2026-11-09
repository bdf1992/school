import { closeSync, existsSync, fsyncSync, ftruncateSync, openSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import { preflightSchoolConnection, preflightTimeout } from "../src/agent/school-preflight.ts";
import { schoolRegistryIdentifier, SchoolParticipantError } from "../src/core/school-participants.ts";
import { SchoolParticipantStore } from "../src/store/school-participants.ts";
import { pinSchoolParticipant } from "../src/server/school-participants.ts";

const HELP = `Usage: npm run school:preflight -- --participant <id> --state <revision> --school <root> --output <new-receipt.json> [--timeout-ms <1..60000>]
Reads an existing named OpenAI-compatible connection and sends one bounded GET /models.
No inference, registration, hosted-provider fallback, or automatic retry occurs.
The default deadline is 5000 ms; the response body is limited to 1 MiB.
The output must be new, outside the School data root, with an existing parent directory.
Exit 0 means the exact model was advertised, not that generation or loaded weights were qualified.`;

function writeReceipt(descriptor: number, value: unknown): void {
	const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
	for (let offset = 0; offset < bytes.byteLength;) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
	ftruncateSync(descriptor, bytes.byteLength);
	fsyncSync(descriptor);
}
async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") { console.log(HELP); return; }
	const options = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index]!, value = args[index + 1];
		if (!["--participant", "--state", "--school", "--output", "--timeout-ms"].includes(key) || options.has(key) || !value || value.startsWith("--")) throw new Error(HELP);
		options.set(key, value);
	}
	if (["--participant", "--state", "--school", "--output"].some((key) => !options.has(key))) throw new Error(HELP);
	const participantId = schoolRegistryIdentifier(options.get("--participant")), stateRevision = schoolRegistryIdentifier(options.get("--state"));
	const timeoutText = options.get("--timeout-ms") ?? "5000";
	if (!/^[1-9]\d*$/.test(timeoutText)) throw new Error("timeout-ms must be a positive decimal integer");
	const timeoutMs = preflightTimeout(Number(timeoutText));
	const schoolRoot = path.resolve(options.get("--school")!), output = path.resolve(options.get("--output")!);
	const realSchool = existsSync(schoolRoot) ? realpathSync(schoolRoot) : schoolRoot;
	const relative = path.relative(realSchool, path.join(realpathSync(path.dirname(output)), path.basename(output)));
	if (!relative || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) throw new Error("The preflight receipt must be outside the School data root");
	const descriptor = openSync(output, "wx", 0o600);
	try {
		writeReceipt(descriptor, { version: 1, kind: "school-connection-preflight", outcome: "PENDING", participant: { id: participantId, stateRevision }, loadedArtifact: "NOT_ATTESTED", inference: "NOT_PERFORMED" });
		const registry = new SchoolParticipantStore(path.join(schoolRoot, "registry"));
		const receipt = await preflightSchoolConnection({ participantId, stateRevision, timeoutMs, credential: (name) => process.env[name], resolve: () => {
			const state = registry.inspectState(participantId, stateRevision);
			if (!state) throw new SchoolParticipantError("PARTICIPANT_STATE_NOT_FOUND", "Register the exact participant state before preflight", 404);
			const binding = pinSchoolParticipant({ id: participantId, model: state.definition.model, edition: state.definition.edition, stateRef: { revision: stateRevision } }, registry)!;
			return { ...binding, assertCurrent: () => registry.assertBinding(binding) };
		} });
		writeReceipt(descriptor, receipt);
		console.log(JSON.stringify(receipt, null, 2));
		process.exitCode = receipt.outcome === "PASSED" ? 0 : 1;
	} finally { closeSync(descriptor); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Preflight failed"); process.exitCode = 1; });
