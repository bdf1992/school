# Classroom console

Open **Classroom** in the sidebar, or visit `/school`. The existing Teaching, Practice and graph home remain available. This route is the owner's workbench for class definitions, participant bindings, queued episodes and retained evidence.

## A first run

1. Expand **Import a class revision** and import a class JSON file. [`examples/school/byte-parity-class.json`](../examples/school/byte-parity-class.json) is a small self-paced example. Registration is immutable: identical contents can be imported again, while different contents require a new revision.
2. Select the class revision and curriculum unit. For a scheduled class, select the specific session when preparing an episode. **All sessions** is a gradebook viewing option.
3. If using the participant registry, expand **Participant registry**. Import a participant definition and a named connection before importing its state revision. State definitions bind a participant to a model, connection and optional saved memory. Connection definitions reference credentials by name; the UI does not request secret values.
4. Expand **Prepare a model episode** and import a version 2 episode JSON file. The episode must already name the selected class revision, unit and world. The console reports a mismatch instead of rewriting task identity. Choose a saved learner or teacher state if the imported binding should change. The preview shows the resulting participant, model and state revision.
5. Review the planned calls. Optionally supply a call budget and **Not before** time. The date field uses the browser's local time and sends a timezone-bearing timestamp to the server. Click **Queue episode** to retain the request.
6. Click **Run due work** when ready to start model calls. This runs a bounded pass across **all classes**. A future date makes work eligible later; it does not start a background timer in the browser. Refresh to see the current work status and gradebook.
7. Select an episode in the gradebook, or click **Evidence** in the work queue, to inspect the retained calls. Each call distinguishes an accepted text reply, an evaluator grade and completion information.

The sample episode [`examples/school/byte-parity.json`](../examples/school/byte-parity.json) uses placeholder model names. Select registered states with usable connections or supply real configured bindings before executing it. The browser always queues configured-provider work. Scripted fixtures enter through the offline test/CLI paths and remain visibly labelled **Scripted fixture** when inspected.

## Reading the results

The gradebook is scoped to one immutable class revision and selected unit, with an optional scheduled-session filter. It shows individual episodes for each enrolled learner; it does not average different models or revisions together.

Every phase shows **correct / graded / expected** separately, for target and retention cases. `No grade · 0 graded / 3 expected` means evidence is missing. `0 correct · 1 graded / 3 expected` means one answer was graded and was wrong. A learner with no episodes receives no grade.

Baseline and lesson-assisted results remain separate. For experiment episodes, the following conditions also appear when the protocol supplies them:

| Condition | What the console labels |
| --- | --- |
| Cold | Fresh context on diagnostic cases, without the teacher lesson |
| Saved memory | Fresh context with the explicitly bound saved memory |
| Transfer | Fresh parameters within the task family, with the teacher lesson |

The UI labels lesson-assisted transfer as such. It makes no weight-update, persistence or generalization claim; experiment evidence is limited to the specified generator and seed. Scripted fixture results establish the behavior of the workflow; their labels do not identify a live model qualification run.

## Work status and recovery

The work queue shows the operation, class, participants, planned call budget, execution source, due time and current status. Refresh is read-only. Opening the page, loading a class, inspecting evidence and importing a class do not start a model episode.

**Cancel** is available for queued and running work, including while the console is waiting for a due-work pass to finish. A running cancellation request is shown separately until the server records a terminal result. Completion can remain **unresolved** when the retained evidence cannot establish what happened; the console never turns that condition into a successful run or silently retries it.

**Check evidence** asks the server to reconcile retained terminal evidence. It does not invoke the model. **Recover stopped worker**, under Worker recovery, is an explicit recovery action: the server must verify that the previous local worker has exited. Recovery does not infer episode success, and interrupted episodes still need reconciliation.

When completion remains unknown after inspection, the owner can enter a review note and choose **Allow later work after review**. This records an explicit acknowledgment so later queued episodes may proceed. The original run stays **unresolved**, its missing grades stay missing, and none of its calls are retried. This action itself makes no model call. The work list continues to show that later work was permitted while completion remained unknown.

## Access and transport

This is an owner surface under the application's existing trusted-origin and desktop-access policy, not a new multi-user login system. Browser requests use relative same-origin URLs, preserving desktop-injected authentication. The UI imports only the browser-safe core barrel; it never imports stores, filesystem code or provider credentials.

The participant list omits saved memory text, and the normal gradebook omits prompts, answer keys and peer replies. Inspecting retained evidence is an explicit owner action. There is no participant-facing route exposing this gradebook or another learner's work.

## Checks

`tests/school-classroom-ui.test.tsx` exercises the behaviors that matter for this UI: no mutation on opening or refreshing, explicit due-work launch, cancellation during an active pass, explicit reviewed-uncertainty acknowledgment, class/world mismatch rejection, exact state binding, missing grades versus wrong answers, fixture provenance, condition labels, session filtering and stale-response fencing. The fixtures use a stubbed same-origin transport; they do not make live model calls.

Run the focused checks with the repository's required Node version:

```sh
node --import tsx --test tests/school-classroom-ui.test.tsx
```

Live Ollama, LM Studio, Claude and other configured-provider behavior still needs endpoint qualification on the host where those models and credentials are available.
