# Continuing participants and named connections

A participant is a continuing identity. A state is one immutable, owner-declared edition of that participant: model selection, connection revision, optional memory snapshot, optional parent state, and declared artifact hashes. An episode selects an exact state and keeps its hashes in its evidence. Registering the next state never edits a previous episode or its grades.

The registry supports model, agent, and human identities. This episode runner executes model calls; registering a human identity does not implement a human-response runner.

## Register a local learner

Create these three JSON files. Definitions reject unknown fields, including credential values. Register the identity and connection before the state.

`learner.json`:

```json
{
  "version": 1,
  "id": "aum-learner",
  "label": "AUM learner",
  "kind": "model"
}
```

`connection.json`:

```json
{
  "version": 1,
  "id": "local-a",
  "revision": "1",
  "label": "Local learner server",
  "kind": "openai-compatible",
  "baseUrl": "http://127.0.0.1:8000/v1",
  "auth": { "mode": "keyless" },
  "contextWindow": 32768,
  "maxOutputTokens": 2048,
  "reasoning": false
}
```

`state.json`:

```json
{
  "version": 1,
  "participantId": "aum-learner",
  "revision": "base",
  "model": { "provider": "custom", "id": "my-model", "thinkingLevel": "off" },
  "edition": "owner-labelled-base",
  "connection": { "id": "local-a", "revision": "1" },
  "artifacts": []
}
```

```sh
npm run school:participant -- register-participant learner.json
npm run school:participant -- register-connection connection.json
npm run school:participant -- register-state state.json
npm run school:participant -- list
```

`--school /absolute/path` selects an isolated School data root. Its registry is stored under `registry/`; classes and episode evidence remain separate. Registration and inspection make no model calls.

Select the state in a version-2 episode participant:

```json
{
  "id": "aum-learner",
  "model": { "provider": "custom", "id": "my-model", "thinkingLevel": "off" },
  "edition": "owner-labelled-base",
  "stateRef": { "revision": "base" }
}
```

The model and edition must exactly match the state. The participant ID must still have the appropriate role in the admitted class revision. A state reference does not grant class membership or provider permission. Existing manifests without `stateRef` remain runnable through the existing configured-provider route and do not acquire a registry identity retrospectively.

## Independent endpoints and credentials

Named endpoints use their own Pi provider collections. Two servers may advertise the same model ID while retaining different connection IDs, state hashes, endpoint URLs and credentials. They do not consult the application's mutable global `custom` endpoint configuration.

For an authenticated endpoint, replace the auth object with:

```json
{ "mode": "environment", "variable": "SCHOOL_CONNECTION_LOCAL_A_1_API_KEY" }
```

Set that variable in the process that runs School. The naming rule is fixed: uppercase connection ID with hyphens changed to underscores, then the numeric connection revision, inside `SCHOOL_CONNECTION_<ID>_<REVISION>_API_KEY`. Connection IDs use lowercase letters, digits and hyphens; revisions are positive decimal integers. A new endpoint revision needs its own credential variable. Arbitrary global variables such as `OPENAI_API_KEY` are rejected as named endpoint bindings.

Credential values never enter definitions, list responses or binding receipts. Keyless endpoints do not read a credential and send Pi's `not-needed` placeholder. The transport checks the exact final `/chat/completions` destination and refuses redirects. It sets zero automatic transport retries, consistent with the episode runner's treatment of uncertain completion.

Remove the dedicated environment variable to make subsequent authenticated calls fail. To revoke an entire connection revision durably:

```sh
npm run school:participant -- revoke-connection local-a 1
```

Revocation is permanent for that revision. Register a new connection revision and participant state to authorize another route. Calls already in flight cannot be recalled. Registry integrity and revocation are checked during binding, during stream setup and immediately before named endpoint HTTP dispatch.

## Existing configured providers

For a provider already connected in School, register this form:

```json
{
  "version": 1,
  "id": "hosted-teacher",
  "revision": "1",
  "label": "Configured teacher account",
  "kind": "configured",
  "provider": "anthropic"
}
```

The state must name that same provider. School uses its actual existing configured engine, account authentication and background-use permission checks. The engine is rechecked immediately before dispatch; a changed route or capability fingerprint refuses the call instead of silently updating the admitted binding. Authentication may be renewed through the existing provider system without persisting secrets in receipts.

The mutable global `custom` provider cannot be named as a configured connection. Give local/custom endpoints an explicit `openai-compatible` connection revision instead. Other existing manifests can continue using the old global route.

## Memory, evidence and artifact declarations

To retain a deliberate memory update, register another state with a new `revision`, a `parent` pointing to the preceding revision of the same participant, and an explicit snapshot:

```json
{
  "parent": { "revision": "base" },
  "memory": {
    "text": "Count all one bits before deciding whether parity is even or odd.",
    "sourceIds": ["episode:parity-study-001"]
  }
}
```

These are fields inside a complete state definition, not a patch to the previous state. Memory text is limited to 16 KiB, with at most 64 source IDs. Source IDs are owner references; the registry does not claim that it fetched or verified the referenced evidence. The memory digest is included in the immutable binding. Ordinary registry lists omit memory text and artifact details; explicit owner state inspection returns the full definition.

Episode evidence remains in the episode store. It is not automatically promoted into memory. The runner selects which pinned memory is visible to a participant and saves the exact call view. Controlled experiment baseline, assisted and cold conditions omit saved memory; a memory condition explicitly admits it. This keeps an exposure decision distinguishable from a new state declaration.

`artifacts` may contain `weights`, `adapter`, `program` or `context` references with a label and lowercase SHA-256 digest. These are owner declarations. A runtime receipt reports `loadedArtifact: "NOT_ATTESTED"`; model names, endpoint URLs and declared file hashes cannot prove what a remote or local server actually loaded. No training, adapter loading or weight inspection is performed by registry registration.

## Owner API and durable behavior

`GET /api/school/participants` returns `{ participants, states, connections }`. To inspect an exact definition use `?kind=participant&id=...`, `?kind=state&id=...&revision=...`, or `?kind=connection&id=...&revision=...`. Only the explicit state view returns its private memory. Responses are uncached and use the application's existing trusted-origin/desktop authorization boundary.

`POST /api/school/participants` accepts one of:

```json
{ "action": "register-participant", "definition": {} }
{ "action": "register-connection", "definition": {} }
{ "action": "register-state", "definition": {} }
{ "action": "revoke-connection", "id": "local-a", "revision": "1" }
```

Replace each empty definition with a complete object of the corresponding type. A registration of an identical normalized definition is idempotent. Reusing an identity or revision for different content returns a conflict. Incomplete, corrupt or symlinked occupied registry paths refuse instead of becoming permission to replace an identity. Per-entry hashes are checked on read; an admitted operation additionally compares its original receipts, so rewriting a file and recomputing its internal hash does not silently alter that operation.

The owner controls local files and the server process; this registry is not protection against a malicious machine administrator. It supplies explicit, reviewable identity and routing within School's existing owner trust boundary.
