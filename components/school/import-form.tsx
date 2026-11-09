"use client";

import { useState } from "react";
import { classroomError, readClassroomFile } from "./classroom-data";

export const fieldClass = "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
export const buttonClass = "inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
export const primaryButtonClass = `${buttonClass} border-primary bg-primary text-primary-foreground hover:bg-primary/90`;

export function JsonImportForm({ label, maxBytes = 64 * 1024, onImport, description }: {
	label: string;
	maxBytes?: number;
	onImport: (value: unknown) => Promise<string>;
	description: string;
}) {
	const [raw, setRaw] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	return <form className="space-y-3" onSubmit={async (event) => {
		event.preventDefault(); setError(""); setMessage(""); setBusy(true);
		try {
			if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error(`The definition exceeds ${Math.floor(maxBytes / 1024)} KiB.`);
			setMessage(await onImport(JSON.parse(raw)));
			setRaw("");
		} catch (error) { setError(classroomError(error)); } finally { setBusy(false); }
	}}>
		<p className="text-sm text-muted-foreground">{description}</p>
		<label className="block text-sm">JSON file<input type="file" accept=".json,application/json" className="mt-1 block w-full text-xs file:mr-3 file:rounded file:border file:bg-background file:px-2 file:py-1 file:text-foreground" disabled={busy} onChange={async (event) => {
			const file = event.target.files?.[0]; if (!file) return;
			try { setRaw(await readClassroomFile(file, maxBytes)); setError(""); setMessage(""); } catch (error) { setError(classroomError(error)); }
			event.target.value = "";
		}} /></label>
		<label className="block text-sm">{label} JSON<textarea value={raw} onChange={(event) => { setRaw(event.target.value); setMessage(""); }} rows={7} spellCheck={false} className={`${fieldClass} mt-1 font-mono text-xs`} disabled={busy} /></label>
		{error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
		{message && <p role="status" className="text-sm">{message}</p>}
		<button type="submit" className={buttonClass} disabled={busy || !raw.trim()}>{busy ? "Importing…" : `Import ${label.toLowerCase()}`}</button>
	</form>;
}
