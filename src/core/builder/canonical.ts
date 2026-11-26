/**
 * Canonical JSON for the builder programme — the one role: one byte-exact
 * encoding (sorted keys, no whitespace) and its SHA-256, so identities and
 * grades are reproducible by any reader. Imports nothing but node builtins.
 */
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number");
		const text = JSON.stringify(value);
		if (text === undefined) throw new Error("unencodable value");
		return text;
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
