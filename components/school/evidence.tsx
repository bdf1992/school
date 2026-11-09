"use client";

import { useEffect, useState } from "react";
import type { SchoolEpisodeRecord } from "@/src/core";
import { classroomError, classroomRequest, evidenceLabel, readableStatus } from "./classroom-data";
import { buttonClass } from "./import-form";
import { ExperimentConditions } from "./gradebook";

export function ClassroomEvidence({ operationId, onClose }: { operationId: string; onClose: () => void }) {
	const [result, setResult] = useState<{ id: string; record?: SchoolEpisodeRecord; error?: string } | null>(null);
	useEffect(() => {
		const controller = new AbortController(); let current = true;
		void classroomRequest<{ record: SchoolEpisodeRecord }>(`/api/school/episodes?${new URLSearchParams({ operationId })}`, { signal: controller.signal })
			.then(({ record }) => { if (current) setResult({ id: operationId, record }); })
			.catch((error: unknown) => { if (current) setResult({ id: operationId, error: classroomError(error) }); });
		return () => { current = false; controller.abort(); };
	}, [operationId]);
	const selected = result?.id === operationId ? result : null;
	return <section className="rounded-lg border bg-card" aria-labelledby="evidence-heading">
		<div className="flex items-start justify-between gap-3 border-b p-4"><div><h2 id="evidence-heading" className="font-medium">Retained evidence</h2><p className="mt-1 break-all text-xs text-muted-foreground">{operationId} · Owner view</p></div><button type="button" className={buttonClass} onClick={onClose}>Close evidence</button></div>
		{!selected && <p role="status" className="p-4 text-sm text-muted-foreground">Loading episode evidence…</p>}
		{selected?.error && <p role="alert" className="p-4 text-sm text-red-600 dark:text-red-400">{selected.error}</p>}
		{selected?.record && <div className="space-y-4 p-4">
			<div className="text-sm"><p><span className="capitalize">{readableStatus(selected.record.status)}</span> · {evidenceLabel(selected.record.evidence)}</p><p className="mt-1 text-xs text-muted-foreground">The saved replies and evaluator results below support the gradebook. An attempted call without a retained grade remains ungraded.</p>{selected.record.error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{selected.record.error}</p>}</div>
			{selected.record.bindings && <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm">Recorded participant bindings</summary><div className="mt-3 space-y-3 text-xs">{(["learner", "teacher"] as const).map((role) => {
				const binding = selected.record!.bindings?.[role];
				return binding ? <div key={role}><p><span className="capitalize">{role}</span>: {binding.participantId} · state {binding.stateRef.revision}</p><p className="mt-1 text-muted-foreground">Connection {binding.connection.id} · {binding.connection.revision}</p><p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">State receipt {binding.stateSha256}</p></div> : null;
			})}<p className="text-muted-foreground">These receipts pin the declared state and configuration. They do not attest which model weights an endpoint loaded.</p></div></details>}
			{selected.record.experiment && <ExperimentConditions report={selected.record.experiment} />}
			{selected.record.calls.length === 0 && <p className="text-sm text-muted-foreground">No model calls were recorded.</p>}
			<div className="divide-y rounded-md border">{selected.record.calls.map((call) => <details key={call.id} className="p-3">
				<summary className="cursor-pointer text-sm"><span className="capitalize">{call.phase === "retry" ? "Lesson assisted" : readableStatus(call.phase)}</span>{call.caseId ? ` · ${call.caseId}` : ""}<span className="ml-2 text-xs text-muted-foreground">{call.grade ? call.grade.correct ? "Correct" : "Incorrect" : "No grade"} · {readableStatus(call.state)}</span></summary>
				<div className="mt-3 space-y-2 text-xs text-muted-foreground">
					<p>{call.participant.id} · {call.resolvedModel?.provider ?? call.participant.model.provider} / {call.resolvedModel?.id ?? call.participant.model.id}</p>
					<p>Completion: {call.completion ? readableStatus(call.completion) : "not recorded"}</p>
					{call.error && <p className="text-red-600 dark:text-red-400">{call.error}</p>}
					{call.text ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 font-mono text-xs text-foreground">{call.text}</pre> : <p>No accepted text reply retained.</p>}
				</div>
			</details>)}</div>
		</div>}
	</section>;
}
