"use client";

import { useState } from "react";
import { classroomError, classroomPost, evidenceLabel, readableStatus, type ClassroomRun } from "./classroom-data";
import { buttonClass, fieldClass, primaryButtonClass } from "./import-form";

export function ClassroomWorkQueue({ runs, onRefresh, onInspect }: { runs: ClassroomRun[]; onRefresh: () => void; onInspect: (operationId: string) => void }) {
	const [draining, setDraining] = useState(false);
	const [recovering, setRecovering] = useState(false);
	const [pending, setPending] = useState<string[]>([]);
	const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const act = async (action: "drain" | "cancel" | "reconcile" | "recover-worker" | "acknowledge-uncertainty", operationId?: string, note?: string) => {
		if ((action === "drain" && draining) || (action === "recover-worker" && recovering) || (operationId && pending.includes(operationId))) return;
		if (action === "acknowledge-uncertainty" && !note?.trim()) return;
		if (action === "drain") setDraining(true);
		if (action === "recover-worker") setRecovering(true);
		if (operationId) setPending((previous) => [...previous, operationId]);
		setError(""); setMessage("");
		try {
			const result = await classroomPost<{ run?: ClassroomRun; recovered?: boolean }>("/api/school/runs", { action, ...(operationId ? { operationId } : {}), ...(action === "acknowledge-uncertainty" ? { note: note!.trim() } : {}) });
			setMessage(action === "drain" ? "Due work finished its bounded pass. Inspect the updated work status and retained evidence." : action === "recover-worker" ? result.recovered ? "Stopped worker recovered. Check interrupted episodes before running more work." : "No stopped worker needed recovery." : action === "acknowledge-uncertainty" ? `Review recorded for ${operationId}. Completion remains unknown; later queued work is permitted. This operation will not be retried.` : `${operationId}: ${result.run ? readableStatus(result.run.status) : "request recorded"}${result.run?.cancelRequestedAt && result.run.status === "RUNNING" ? " · cancellation requested" : ""}.`);
		} catch (error) { setError(classroomError(error)); } finally {
			if (action === "drain") setDraining(false);
			if (action === "recover-worker") setRecovering(false);
			if (operationId) setPending((previous) => previous.filter((id) => id !== operationId));
			onRefresh();
		}
	};
	return <section className="rounded-lg border bg-card" aria-labelledby="work-heading">
		<div className="flex flex-wrap items-start justify-between gap-4 border-b p-4">
			<div><h2 id="work-heading" className="font-medium">Work queue</h2><p className="mt-1 text-xs text-muted-foreground">All classes. Run due work starts a bounded pass of due episodes using their saved bindings.</p></div>
			<button type="button" className={primaryButtonClass} disabled={draining || recovering || !runs.some((run) => run.status === "QUEUED")} onClick={() => void act("drain")}>{draining ? "Running due work…" : "Run due work"}</button>
		</div>
		{(error || message) && <p role={error ? "alert" : "status"} className={`px-4 pt-4 text-sm ${error ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>{error || message}</p>}
		{draining && <p role="status" className="px-4 pt-4 text-xs text-muted-foreground">A pass is running. Refresh to inspect live status, or cancel an individual episode below.</p>}
		{!runs.length ? <p className="p-4 text-sm text-muted-foreground">No queued work. Import an episode to prepare a run.</p> : <div className="max-h-96 overflow-auto"><table className="w-full text-left text-sm">
			<caption className="sr-only">Durable work status across all class revisions</caption>
			<thead className="text-xs text-muted-foreground"><tr><th scope="col" className="px-4 py-3 font-normal">Episode / class</th><th scope="col" className="px-4 py-3 font-normal">Status</th><th scope="col" className="px-4 py-3 font-normal">Plan / evidence</th><th scope="col" className="px-4 py-3 font-normal">Actions</th></tr></thead>
			<tbody>{runs.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).map((run) => <tr className="border-t" key={run.operationId}>
				<th scope="row" className="px-4 py-3 align-top font-normal"><p className="break-all font-medium">{run.operationId}</p><p className="mt-1 text-xs text-muted-foreground">{run.class.classId} · {run.class.revision} · {run.class.unitId}</p><p className="text-xs text-muted-foreground">{run.learnerId} ← {run.teacherId}</p></th>
				<td className="px-4 py-3 align-top"><p className="capitalize">{readableStatus(run.status)}</p>{run.cancelRequestedAt && run.status === "RUNNING" && <p className="mt-1 text-xs text-muted-foreground">Cancellation requested</p>}{run.errorCode && <p className="mt-1 max-w-60 break-words text-xs text-red-600 dark:text-red-400">{run.errorCode}</p>}{run.status === "UNRESOLVED" && <p className="mt-1 max-w-60 text-xs text-muted-foreground">{run.uncertaintyAcknowledgedAt ? "Reviewed; later work permitted. Completion remains unknown." : "Completion is unknown. Inspect retained evidence before reviewing this uncertainty."}</p>}</td>
				<td className="px-4 py-3 align-top text-xs text-muted-foreground"><p>{run.plannedCalls} planned calls{run.maxCalls !== undefined ? ` · ${run.maxCalls} allowed` : ""}</p>{run.retainedCalls !== undefined && <p className="mt-1">{run.retainedCalls} terminal replies recorded</p>}<p className="mt-1">{evidenceLabel(run.evidence)}</p>{run.status === "QUEUED" && <p className="mt-1">Due {new Date(run.notBefore).toLocaleString()}</p>}</td>
				<td className="px-4 py-3 align-top"><div className="flex flex-wrap gap-2">
					{["COMPLETED", "FAILED", "UNRESOLVED", "RUNNING"].includes(run.status) && <button type="button" className={buttonClass} onClick={() => onInspect(run.operationId)}>Evidence</button>}
					{["QUEUED", "RUNNING"].includes(run.status) && <button type="button" className={buttonClass} disabled={pending.includes(run.operationId)} onClick={() => void act("cancel", run.operationId)}>Cancel</button>}
					{["UNRESOLVED", "RUNNING"].includes(run.status) && <button type="button" className={buttonClass} disabled={pending.includes(run.operationId)} onClick={() => void act("reconcile", run.operationId)}>Check evidence</button>}
				</div>{run.status === "UNRESOLVED" && !run.uncertaintyAcknowledgedAt && <form className="mt-3 min-w-64 max-w-sm space-y-2" onSubmit={(event) => { event.preventDefault(); void act("acknowledge-uncertainty", run.operationId, reviewNotes[run.operationId]); }}>
					<p className="text-xs leading-5 text-muted-foreground">Completion stays unknown. This permits later queued work and never retries the original calls.</p>
					<label className="block text-xs">Review note<textarea required maxLength={1024} rows={3} className={`${fieldClass} mt-1 text-xs`} value={reviewNotes[run.operationId] ?? ""} onChange={(event) => setReviewNotes((previous) => ({ ...previous, [run.operationId]: event.target.value }))} disabled={pending.includes(run.operationId)} /></label>
					<button type="submit" className={buttonClass} disabled={pending.includes(run.operationId) || !reviewNotes[run.operationId]?.trim()}>Allow later work after review</button>
				</form>}</td>
			</tr>)}</tbody>
		</table></div>}
		<details className="border-t p-4"><summary className="cursor-pointer text-xs text-muted-foreground">Worker recovery</summary><p className="my-3 max-w-2xl text-xs leading-5 text-muted-foreground">Use after a worker has stopped unexpectedly. Recovery verifies that the previous worker has exited; interrupted episodes still need their retained evidence checked.</p><button type="button" className={buttonClass} disabled={draining || recovering} onClick={() => void act("recover-worker")}>{recovering ? "Checking worker…" : "Recover stopped worker"}</button></details>
	</section>;
}
