"use client";

import { useMemo, useState } from "react";
import { schoolExperimentCallCount, type SchoolClassDefinition } from "@/src/core";
import { classroomError, classroomPost, prepareClassroomEpisode, readClassroomFile, stateChoice, type ClassroomParticipantState, type ClassroomRegistry, type ClassroomRun } from "./classroom-data";
import { fieldClass, primaryButtonClass } from "./import-form";

export function ClassroomEpisodeForm({ definition, unitId, sessionId, registry, onQueued }: {
	definition: SchoolClassDefinition;
	unitId: string;
	sessionId: string;
	registry: ClassroomRegistry;
	onQueued: (run: ClassroomRun) => void;
}) {
	const [raw, setRaw] = useState("");
	const [learnerChoice, setLearnerChoice] = useState("");
	const [teacherChoice, setTeacherChoice] = useState("");
	const [notBefore, setNotBefore] = useState("");
	const [maxCalls, setMaxCalls] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const usable = (state: ClassroomParticipantState) => registry.connections.some((connection) => connection.id === state.connection.id && connection.revision === state.connection.revision && !connection.revoked);
	const preview = useMemo(() => {
		if (!raw.trim()) return { manifest: null, error: "" };
		try {
			const learnerState = registry.states.find((state) => stateChoice(state) === learnerChoice);
			const teacherState = registry.states.find((state) => stateChoice(state) === teacherChoice);
			if ((learnerChoice && !learnerState) || (teacherChoice && !teacherState)) throw new Error("A selected participant state is no longer available. Choose a state again.");
			if ([learnerState, teacherState].some((state) => state && !registry.connections.some((connection) => connection.id === state.connection.id && connection.revision === state.connection.revision && !connection.revoked))) throw new Error("A selected state has an unavailable or revoked connection.");
			return { manifest: prepareClassroomEpisode({ raw, definition, unitId, sessionId, learnerState, teacherState }), error: "" };
		} catch (error) { return { manifest: null, error: classroomError(error) }; }
	}, [raw, definition, unitId, sessionId, registry, learnerChoice, teacherChoice]);
	const selectState = (role: "learner" | "teacher", value: string, onChange: (value: string) => void) => <label className="block text-sm capitalize">{role} state
		<select className={`${fieldClass} mt-1 normal-case`} value={value} onChange={(event) => onChange(event.target.value)} disabled={busy}>
			<option value="">Use the episode&apos;s binding</option>
			{registry.states.filter((state) => definition.roster.some((member) => member.participantId === state.participantId && member.roles.includes(role))).map((state) => <option key={stateChoice(state)} value={stateChoice(state)} disabled={!usable(state)}>
				{state.participantId} · {state.revision} · {state.model.id}{usable(state) ? "" : " (connection unavailable)"}
			</option>)}
		</select>
	</label>;
	return <form className="space-y-4" onSubmit={async (event) => {
		event.preventDefault(); if (!preview.manifest || busy) return;
		setBusy(true); setError(""); setMessage("");
		try {
			const limit = maxCalls.trim() ? Number(maxCalls) : undefined;
			if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("The call budget must be a positive whole number.");
			const schedule = notBefore ? new Date(notBefore).toISOString() : undefined;
			const result = await classroomPost<{ created: boolean; run: ClassroomRun }>("/api/school/runs", { action: "enqueue", manifest: preview.manifest, ...(schedule ? { notBefore: schedule } : {}), ...(limit === undefined ? {} : { maxCalls: limit }) });
			setMessage(result.created ? `Queued ${result.run.operationId}. Choose Run due work when ready to start model calls.` : `${result.run.operationId} is already registered (${result.run.status.toLowerCase()}).`);
			onQueued(result.run);
		} catch (error) { setError(classroomError(error)); } finally { setBusy(false); }
	}}>
		<p className="text-sm text-muted-foreground">Import a class-bound episode, review its model bindings, and queue it. Run due work starts the model calls.</p>
		<label className="block text-sm">Episode JSON file<input type="file" accept=".json,application/json" disabled={busy} className="mt-1 block w-full text-xs file:mr-3 file:rounded file:border file:bg-background file:px-2 file:py-1 file:text-foreground" onChange={async (event) => {
			const file = event.target.files?.[0]; if (!file) return;
			try { setRaw(await readClassroomFile(file, 64 * 1024)); setError(""); setMessage(""); } catch (error) { setError(classroomError(error)); }
			event.target.value = "";
		}} /></label>
		<label className="block text-sm">Episode JSON<textarea className={`${fieldClass} mt-1 font-mono text-xs`} value={raw} onChange={(event) => { setRaw(event.target.value); setMessage(""); }} rows={8} spellCheck={false} disabled={busy} /></label>
		<div className="grid gap-3 sm:grid-cols-2">{selectState("learner", learnerChoice, setLearnerChoice)}{selectState("teacher", teacherChoice, setTeacherChoice)}</div>
		{preview.manifest && <div className="rounded-md border bg-muted/30 p-3 text-sm" aria-label="Episode preview">
			<p className="font-medium break-all">{preview.manifest.operationId}</p>
			{(["learner", "teacher"] as const).map((role) => <p className="mt-1 break-all text-xs text-muted-foreground" key={role}><span className="capitalize">{role}</span>: {preview.manifest![role].id} · {preview.manifest![role].model.provider} / {preview.manifest![role].model.id} · {preview.manifest![role].stateRef ? `state ${preview.manifest![role].stateRef!.revision}` : "unversioned binding"}</p>)}
			<p className="mt-2 text-xs text-muted-foreground">{preview.manifest.teaching.length} teaching examples · {preview.manifest.evaluation.length} diagnostic cases{preview.manifest.experiment ? ` · ${preview.manifest.experiment.transfer.length} transfer cases` : ""} · {schoolExperimentCallCount(preview.manifest.evaluation.length, preview.manifest.experiment)} planned calls · Configured provider execution</p>
		</div>}
		{preview.error && <p role="status" className="text-sm text-amber-600 dark:text-amber-400">{preview.error}</p>}
		<div className="grid gap-3 sm:grid-cols-2">
			<label className="block text-sm">Not before <span className="text-xs text-muted-foreground">(optional, local time)</span><input type="datetime-local" value={notBefore} onChange={(event) => setNotBefore(event.target.value)} className={`${fieldClass} mt-1`} disabled={busy} /></label>
			<label className="block text-sm">Maximum model calls <span className="text-xs text-muted-foreground">(optional)</span><input type="number" min={preview.manifest ? schoolExperimentCallCount(preview.manifest.evaluation.length, preview.manifest.experiment) : 1} max={128} step={1} value={maxCalls} onChange={(event) => setMaxCalls(event.target.value)} placeholder="Use the episode plan" className={`${fieldClass} mt-1`} disabled={busy} /></label>
		</div>
		{error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
		{message && <p role="status" className="text-sm">{message}</p>}
		<button type="submit" className={primaryButtonClass} disabled={busy || !preview.manifest}>{busy ? "Queueing…" : "Queue episode"}</button>
	</form>;
}
