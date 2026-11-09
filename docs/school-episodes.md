# Model episodes

School's first machine-learner interface runs a finite, authored task through a baseline, one teacher lesson, a learner retry, and exact-answer comparison. It is available as a CLI and API. The existing human Teach/Practice UI does not yet launch these episodes.

## Run without a model

```sh
npm run school:episode -- examples/school/byte-parity.json --fixture --output /tmp/school-episodes
```

Use an absolute output path appropriate to your OS. `--fixture` uses scripted responses and explicitly substitutes scripted participant identities. It makes no model requests and records `SCRIPTED_FIXTURE`. The example intentionally includes a baseline mistake, then corrects it when a lesson is present. Its expected result is target **1/2 → 2/2**, retention **1/1 → 1/1**, across seven calls. This checks harness behavior; it is not an experiment showing model learning.

Run the same command again to retrieve the terminal record without repeating calls. To start another operation, supply `--operation byte-parity-002`. Every new nonfixture operation may incur provider usage.

## Configure actual participants

1. Run School and configure the required connections under **Settings → Providers**. A [custom endpoint](custom-providers.md) can host the local learner. School currently supports one such endpoint with multiple model IDs.
2. Copy [`examples/school/byte-parity.json`](../examples/school/byte-parity.json) and replace both model ID placeholders. Keep `provider: "custom"` for that local endpoint. Use the exact configured provider/model identifiers for the teacher; the example selects the Anthropic API, while `openai` or an enabled `claude-code` connection are other routes. Inspect the app's available model catalog instead of guessing an ID.
3. Give the operation a distinct identity. Optionally supply each participant's `edition` label; it is a declaration, not proof of which weights were loaded.
4. Run the copied manifest without `--fixture` using the same `LH_DATA_DIR` and `LH_AUTH_FILE` profile as the configured application.

```sh
npm run school:episode -- /absolute/path/to/my-episode.json --operation local-parity-001
```

CLI and web/dev default to this checkout's `data/` and `auth.json`. Packaged desktop uses its separate `School` application profile; `desktop:dev` uses the external Next server's profile for model connections. `--output` relocates episode records only, not provider settings or credentials. The plain Node CLI reads exported environment variables and saved auth; it does not automatically load Next's `.env.local` file.

For subscription participants, use the API inside an already configured running application, or stop the web/dev server before using its credential profile from the CLI. Subscription refresh serialization is process-local, so each credential directory needs one owner. An external CLI must not share an active packaged desktop's credential files.

Strong/Cheap/Vision are existing application slots. An episode uses its own explicit learner and teacher references. It never falls back from a missing participant to a tier, another provider, or a fixture. Automatic subscription follow-up calls require the existing background-use permission. Subscription, API, and CLI routes retain their different authentication and billing behavior. Claude Code must already be installed and qualified through its [existing adapter](claude-code.md).

A completed configured run is labeled `CONFIGURED_PROVIDER`. This label identifies routing, not proof of a neural model, correct provider metadata, authentic edition, or independent research replication. A local endpoint could itself be a fixture. Keep the actual environment and artifact identity with any claimed live qualification.

## Manifest and information boundary

The version-1 manifest contains:

| Field | Contract |
| --- | --- |
| `operationId` | 1–80 letters, digits, hyphens, or underscores, beginning with a letter or digit. |
| `world` | Explicit `id`, `revision`, `subject`, and participant-visible `instructions`. |
| `learner`, `teacher` | Participant `id`, model `provider`/`id`, optional thinking level and declared edition. |
| `teaching` | 1–8 examples with question, observations, and an answer available to the teacher. |
| `evaluation` | 2–16 cases with private `expected` values and `target` or `retention` split; both splits required. |
| `limits` | Requested output budget and independently enforced local deadlines. |

Each observation declares `ABSENT`, `INSUFFICIENT`, or `SUFFICIENT`. An absent observation cannot carry content. Other statuses require content. These are assertions by the task author, not a verified measure of informational sufficiency. Case identities are unique across teaching and evaluation. Exact duplicates of teaching problems in the evaluation set are refused; this is not semantic deduplication or a contamination detector.

The learner sees only the world description, current question and observations, plus the lesson during retry. The teacher sees teaching examples and aggregate target/retention baseline counts. The evaluator alone receives the evaluation answer fields. Authored instructions, observations, and lessons can themselves contain answers; the projection prevents structural answer-field leakage, not arbitrary semantic leakage in those texts.

No archived human-session transcript is passed to these participants. Such transcripts can contain hidden quiz answers and problem solutions. Neither participant receives School tools through this new adapter; it submits one model generation per call with an empty tool list.

## Evaluation and records

The server retains the raw assistant message and extracted answer text before writing a grade. `trimmed-exact-v1` compares trimmed answer text against the authored expected string. Case, punctuation, and internal whitespace still matter. A tool call, empty output, truncated output, or provider error fails the episode rather than producing a successful grade.

The comparison records target and retention totals, both scores, and every previously correct case that became incorrect. Any such regression yields `REGRESSION`. Otherwise an increased target score yields `CONTEXTUAL_GAIN`; the remaining outcome is `NO_MEASURED_GAIN`. Every result explicitly states:

```json
{
  "weightLearning": "NOT_PERFORMED",
  "adoption": "NOT_REQUESTED",
  "generalization": "NOT_ESTABLISHED"
}
```

The same evaluation cases are used before and after the lesson, with fresh participant contexts. They are withheld from the teacher except for aggregate scores. There is no cold/no-lesson follow-up, model update, or separate generalization trial yet. A retention split here means checking previously correct responses under assistance, not demonstrated long-term memory.

Records live at `<LH_DATA_DIR>/school/episodes/<operationId>/record.json`, or beneath the CLI's `--output` root. They include the full manifest, evaluation answers, allowed views, raw replies, returned usage metadata, grades, errors, and ordered checkpoint events. Treat these as private evaluator records, not learner-facing API responses. They are unsigned local files; the manifest digest binds operation payloads but does not make the entire archive tamper-proof.

## Limits and interruption

Defaults are 512 requested output tokens, 30 seconds per call, and 180 seconds per episode. Allowed maxima are 4096 requested tokens, 120 seconds per call, and 600 seconds per episode. A maximum of 16 evaluation cases gives at most 33 calls. Manifests are limited to 64 KiB; retained reply serialization and lesson text have separate size checks.

`maxOutputTokens` is a **requested output budget**, not a universal token or billing cap. Some subscription and CLI bridges omit it; providers may clamp values or add reasoning budgets. Independent local timers request cancellation and stop waiting. They cannot prove that a remote provider stopped or did not bill.

A call's `ADMITTED` checkpoint means School durably recorded local admission before invoking its stream. It does not prove that the provider accepted or executed the request. `UNKNOWN` completion after interruption is preserved explicitly.

The store claims an operation directory atomically and replaces record files through temporary-file rename. Reusing an identical terminal operation returns its saved record, including failures. Reusing its ID for a changed manifest or execution mode is refused. A `RUNNING`, incomplete, or corrupt record is not automatically resumed. Inspect it and the provider before deciding whether to use a new ID. These rules prevent blind replay, but do not provide exactly-once remote execution, a distributed transaction, or a power-loss durability guarantee.

## HTTP interface

`POST /api/school/episodes` accepts the JSON manifest and waits for the bounded operation. In web/dev it requires `Content-Type: application/json` and an `Origin` matching the trusted request origin. Packaged desktop uses its existing authenticated transport. This is the app's trusted local environment, not a new multi-user service.

```sh
curl -X POST http://localhost:3000/api/school/episodes \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:3000' \
  --data-binary @my-episode.json

curl 'http://localhost:3000/api/school/episodes?operationId=local-parity-001'
```

A successful or replayed terminal operation returns `{ "replayed": ..., "record": ... }`. A recorded execution failure returns HTTP 502 with the record. Validation and operation collisions return specific 4xx responses. `GET` retrieves the full private record for the given operation ID. HTTP JSON cannot inject an engine or request fixture mode. For a browser disconnect, inspect the record before retrying; request cancellation and remote completion are separate facts.

See [School's intent](school-intent.md) and [issue #1](https://github.com/bdf1992/school/issues/1) for the role UI, actual local/hosted qualification, additional evaluators, and AUM training bridge.
