import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { PATHS } from "../config.ts";
import { MAX_SCHOOL_REGISTRY_BYTES } from "../src/core/school-participants.ts";
import { SchoolParticipantStore } from "../src/store/school-participants.ts";

const HELP = `Usage: npm run school:participant -- <command> [--school <directory>]
Commands:
  register-participant <definition.json>  Register a continuing identity.
  register-connection <definition.json>   Register an immutable named connection.
  register-state <definition.json>        Register an immutable participant state.
  revoke-connection <id> <revision>        Permanently revoke a connection revision.
  list                                    List registry entries without private memory.
  show-participant <id>                    Inspect a continuing identity.
  show-state <id> <revision>               Inspect a state, including private memory.
  show-connection <id> <revision>          Inspect a named connection and revocation.
--school selects a root containing registry/; the default is the configured School data root.
This CLI makes no model calls and never accepts credential values. Named credentials live in dedicated environment variables.
`;

function main(): void {
	const args = process.argv.slice(2), positional: string[] = [];
	let directory: string | undefined;
	if (args.length === 1 && args[0] === "--help") { console.log(HELP); return; }
	for (let index = 0; index < args.length; index++) {
		const value = args[index]!;
		if (value === "--school") {
			if (directory !== undefined || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error("--school requires one directory");
			directory = path.resolve(args[++index]!);
		} else if (value.startsWith("-")) throw new Error(`Unexpected option: ${value}`);
		else positional.push(value);
	}
	const registry = new SchoolParticipantStore(path.join(directory ?? path.join(PATHS.data, "school"), "registry"));
	const [command, ...values] = positional;
	let result: unknown;
	if (["register-participant", "register-state", "register-connection"].includes(command ?? "") && values.length === 1) {
		const filename = path.resolve(values[0]!);
		if (statSync(filename).size > MAX_SCHOOL_REGISTRY_BYTES) throw new Error("Definition exceeds 64 KiB");
		const bytes = readFileSync(filename);
		if (bytes.byteLength > MAX_SCHOOL_REGISTRY_BYTES) throw new Error("Definition exceeds 64 KiB");
		const definition = JSON.parse(bytes.toString("utf8"));
		result = command === "register-participant" ? registry.createParticipant(definition) : command === "register-state" ? registry.createState(definition) : registry.createConnection(definition);
	} else if (command === "list" && values.length === 0) result = registry.list();
	else if (command === "show-participant" && values.length === 1) result = registry.inspectParticipant(values[0]!);
	else if (command === "show-state" && values.length === 2) result = registry.inspectState(values[0]!, values[1]!);
	else if (command === "show-connection" && values.length === 2) result = registry.inspectConnection(values[0]!, values[1]!);
	else if (command === "revoke-connection" && values.length === 2) result = registry.revokeConnection(values[0]!, values[1]!);
	else throw new Error(HELP.trim());
	if (!result) throw new Error("Registry entry not found");
	console.log(JSON.stringify(result, null, 2));
}

try { main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
