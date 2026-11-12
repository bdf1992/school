# Headless state-space episodes

The `state-space` class has a `square-of-sum` unit. Its learner sees the SPACE description, entry protocol, continuation schema, contexts, expression grammar and algebra tables as records resolved by snapshot digest and normalized address. The conceptual dictionary remains empty. School retains the learner, class revision, observations, invocation, proposed body and assessment. Foundation stores the operation versions, runs, assessment cases and slot bindings in SQLite.

## Set up and reproduce

Install School's locked Node dependencies with `npm ci`. Use Node 26 and Python 3.12 or newer. Extract the supplied State Database Foundation v0.2.0 archive. Point `$foundation` to the directory containing `state_database.py`, `runtime.py` and `schema.sql`. Keep that trusted directory available when reopening a workspace. School pins the Foundation source hashes at initialization.

Run from School's repository root in PowerShell. Each invocation starts a separate process.

```powershell
$foundation = 'C:/path/to/state-database-foundation'
$school = Join-Path $env:TEMP ('school-space-' + [guid]::NewGuid())
function Space { node --import tsx scripts/school-state-space.ts $args[0] $school $foundation @($args | Select-Object -Skip 1) }

$initialized = Space init | ConvertFrom-Json
Space resolve $initialized.world.snapshot /space
Space resolve $initialized.world.snapshot /protocol/enter
Space resolve $initialized.world.snapshot /schema/continuation

$bad = Space run bad-control local-learner bad | ConvertFrom-Json
Space adopt refused-control local-learner $bad.assessment.assessment_ref $bad.expectedBinding
# This command exits 1. The candidate regressed and the slot still points to the baseline.

$good = Space run good-control local-learner good | ConvertFrom-Json
Space adopt repair local-learner $good.assessment.assessment_ref $good.expectedBinding
Space continue fresh-invocation local-learner
Space history $good.invocation.run_ref
```

The baseline passes 8 of 10 cases and the constant-zero control passes 2. The repaired body passes 10. After reopening, the stable slot returns `["-2/9","0","8/3","8/3"]` on the fresh invocation. The retained baseline probe still returns `["-5","0","0","4"]`. Use `inspect` to see the current binding and `history` with an invocation, run, operation, binding or assessment reference to inspect its original record. Retrying an already claimed School operation ID fails. Use its JSONL receipt and `inspect` to recover the observed state before choosing a new ID.

For your own input, use `invoke <operation-id> local-learner <input.json>`. The JSON contains a `context` address (`/contexts/root` or `/contexts/commuting`) and `x` and `y` arrays of four coordinates each. Encode nonintegral rationals as strings. Submit a Foundation expression with `run <operation-id> local-learner body <body.json>`. That command assesses the body. An owner can explicitly adopt a passing assessment with `adopt`, passing the exact baseline binding returned by the run. A stale binding is refused.

## Run the configured local model

Use a fresh workspace so the slot starts from the defective version. Register `local-learner` and an exact state revision with School's existing [participant CLI](school-participants.md), using the same workspace as `--school`. The state must select a named loopback OpenAI-compatible connection. For Ollama local-only mode, use the same keyless endpoint as School's Providers setting and select an installed local alias with an explicit `num_ctx` profile. See [local context setup](local-context.md).

```powershell
Space init
Space run model-attempt local-learner local qwen-bounded
```

Replace `qwen-bounded` with the registered state revision. The model gets addressed source records and a public invocation distinct from the assessment cases. School records the exact system prompt, view, selected runtime and reply before parsing. A single request has a 90-second deadline and an output ceiling of 4,096 tokens or the connection's lower limit. School refuses reported output beyond that limit. The model supplies one data-only expression body. Foundation assesses it against the immutable slot suite with expected values computed directly from the source algebra tables. A passing proposal still requires a separate owner adoption command.

Episode receipts are under `state-space-episodes/` in the selected workspace. Authored controls and model runs have different evidence labels. `history` reopens existing records without generating a reply. These ten fixed cases give finite evidence. Classroom UI, queue scheduling, teacher calls and neural training are outside this headless implementation.

## Integration check

```powershell
$env:SCHOOL_FOUNDATION_V020 = $foundation
python scripts/pr_tests.py
```

The supervised School tests exercise the CLI with real SQLite and Foundation when the archive path is supplied. The external-runtime test reports a skip when that path is absent. It does not call a model.

For prepared episodes that a fresh process can resume, two task families, and the configured-model cohort, see the [learning workflow evaluation](school-state-space-evaluation.md).
