# Queued School work

The queue retains an explicit request before running it. A request binds the episode manifest, execution mode, due time and call budget to an operation ID. Queueing, listing, cancelling queued work and inspecting evidence make no inference calls. An owner explicitly starts execution through the classroom's **Run due work** button or the worker CLI.

## Enqueue and execute

Register the class and any participant state/connection revisions first. Use actual configured models in the episode manifest; the shipped examples contain placeholders.

```sh
npm run school:worker -- enqueue my-episode.json --school /absolute/school-root
npm run school:worker -- list --school /absolute/school-root
npm run school:worker -- once --school /absolute/school-root
```

`--school` uses `classes/`, `registry/`, `episodes/` and `queue/` within that root. Without it, the application and CLI share the active School data root. `once` can call providers for due work and returns after a bounded pass.

For delayed work, enqueue with `--not-before 2026-11-10T08:00:00Z`, choosing an appropriate future time. Timestamps require an explicit timezone and a valid calendar date. A scheduled class's selected session must still be open when the episode starts; a due time does not override admission. Work that fails class or state admission retains a failed queue entry without creating invented model answers.

An explicitly running watcher can consume later work:

```sh
npm run school:worker -- watch --school /absolute/school-root
```

It polls every two seconds and stops on SIGINT or SIGTERM. It does not install a system service or survive process termination by itself. The durable requests remain available to another explicitly started worker. Opening the classroom does not launch this watcher.

## Limits and ownership

One queue worker lease owns a School queue at a time, across local processes. A worker runs episodes sequentially. Each pass admits at most 16 runs and 128 planned model-generation calls; `--max-calls` can reduce the pass budget. It chooses due requests by creation time, then operation ID for ties. If the next due request does not fit the remaining pass budget, the pass stops.

Every run also has an immutable `maxCalls`, defaulting to the exact planned count. It must cover the plan and cannot exceed 128. The basic loop plans `2 × evaluation cases + 1` calls. The default factorized experiment plans 17; adding its saved-memory condition plans 21. These are generation admissions, not a money estimate or a universal billed-token cap. Existing per-call and episode deadlines still apply.

This is local sequential admission for this queue. Direct `school:episode` or `school:experiment run` invocations remain separate entry points. The queue is not a fleet-wide provider rate limiter and does not coordinate every inherited human chat or another data root. Use queued execution when work needs these ownership and budget rules.

HTTP accepts configured-provider requests only. Internal fixture injection is test/CLI machinery, never an HTTP request field. A worker cannot fall back from a queued fixture to configured providers or change the stored evidence mode.

## States and cancellation

| State | Meaning |
| --- | --- |
| `QUEUED` | Retained and awaiting a due-work pass. |
| `RUNNING` | A worker admitted the run; episode evidence records individual call progress. |
| `COMPLETED` | Matching terminal episode evidence reports completion with no unknown call. |
| `FAILED` | Known terminal failure or refusal; it is retained rather than automatically retried. |
| `CANCELLED` | Owner cancellation stopped work with no unknown provider completion. |
| `UNRESOLVED` | Retained evidence cannot establish the outcome of admitted work. |

```sh
npm run school:worker -- cancel operation-id --school /absolute/school-root
```

Cancellation uses a separate atomically published marker. A worker update cannot erase the request. The in-process worker receives an abort immediately; another process observes the marker while polling. A cancellation cannot undo a provider call already dispatched. If that call has no terminal reply, the queue retains `UNRESOLVED`, and the episode keeps `completion: "UNKNOWN"`.

Reusing an operation with the same request returns its existing queue entry. A different manifest, due time, execution mode or budget under the same operation ID is a conflict. An omitted due time on an identical repeated enqueue reuses the original time. Terminal work is never automatically requeued.

## Recover and reconcile

A worker lease has a random token, process ID and host name. Elapsed time cannot steal it. After a worker process has exited:

```sh
npm run school:worker -- recover-worker --school /absolute/school-root
npm run school:worker -- reconcile operation-id --school /absolute/school-root
```

Recovery only retires a lease whose owning process is verified absent on the same host. A live, foreign-host or incomplete owner record refuses recovery. The retired owner record remains on disk. Recovery never changes a run into a success or repeats a call.

Reconciliation reads the matching episode record. A known completed or failed episode can finish queue bookkeeping without resolving a provider. No episode directory means the runner never admitted an episode; the queue records `NO_EPISODE_ADMITTED`. A partial raw record, corrupt record or unknown provider outcome remains unresolved. Reconciliation does not regrade a partial episode or dispatch the rest of its plan.

Unreviewed unresolved work blocks further queue execution. After inspecting the record and the relevant endpoint, the owner may explicitly allow later work:

```sh
npm run school:worker -- acknowledge-uncertainty operation-id --note "Reviewed endpoint and retained evidence; allow later work with original completion still unknown." --school /absolute/school-root
```

This saves an immutable review note and timestamp. The original run remains `UNRESOLVED`; its evidence and original calls are untouched. Acknowledgment makes later queued work eligible for the next explicit worker pass. It does not retry the original run, prove remote completion, or guarantee exactly-once billing. The classroom exposes the same action as **Allow later work after review**.

## Owner API

`GET /api/school/runs` lists summaries without prompts, hidden keys, replies, memory or review-note text. `GET ?operationId=...` returns the full owner request and queue record. The existing episode endpoint returns raw retained evidence. All responses use `Cache-Control: no-store` and the existing trusted-origin/desktop boundary.

`POST /api/school/runs` accepts:

```json
{ "action": "enqueue", "manifest": {}, "notBefore": "2026-11-10T08:00:00Z", "maxCalls": 17 }
{ "action": "drain" }
{ "action": "cancel", "operationId": "example" }
{ "action": "recover-worker" }
{ "action": "reconcile", "operationId": "example" }
{ "action": "acknowledge-uncertainty", "operationId": "example", "note": "Owner review explanation" }
```

Replace the empty manifest with a complete class-bound episode. `notBefore` and `maxCalls` are optional on enqueue. Drain has no client-supplied provider, evidence-mode or budget override. Browser disconnection does not cancel a queued worker; use the explicit cancel action.

`tests/school-runs.test.ts` exercises actual filesystem claims and the production episode runner: due-time and budget behavior, independent cancellation, competing workers, a verified exited child worker, stale lease refusal, terminal reconciliation without calls, unresolved completion, owner acknowledgment without replay, fixture isolation and HTTP access boundaries.
