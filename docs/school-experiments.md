# Controlled teaching experiments

The experiment kit runs a reproducible task family through School's existing class-bound episode runner. It measures diagnostic assistance, a fresh-context cold repeat, optional saved-memory assistance, and lesson-assisted transfer to new parameters. Every learner reply is saved before grading. The teacher has one lesson turn and never receives the sealed transfer cases or their outcomes.

This is the bounded experiment foundation for issues #7 and #8. It does not train a model, adopt a generated artifact, or establish persistent learning. Its executable controls make measurement failures inspectable before a local-model pilot.

## The task: equal products, different next steps

The task describes a scalar model `f = a*b*x` with loss `(f-target)^2/2`. The learner must calculate the effective coefficient after one simultaneous gradient step. The retention task asks for the current product `a*b`.

Writing `q=a*b` and `s=rate*(q*x-target)*x`, the two updates are:

```text
a_next = a - s*b
b_next = b - s*a
q_next = a_next*b_next
```

Both derivatives use the original factors. Multiplication order in a sequential update would change the answer. The generator computes the equivalent expanded polynomial:

```text
q_next = q - s*(a*a + b*b) + s*s*q
```

The separate checker implements the direct two-factor update. Both use exact `BigInt` rational arithmetic, with reduced fractions and no floating-point tolerance. Known examples and 128 generated seeds are checked in the test suite. `verifyFactorizedCase` checks an authored answer key without consulting the generator; `checkFactorizedAnswer` rejects a well-formed fraction with the wrong meaning. The production grader remains the class's declared `trimmed-exact-v1`, applied only after the manifest keys pass independent verification.

For `x=1`, `target=0`, and `rate=1/10`, both `(a,b)=(2,3)` and `(6,1)` have present coefficient `6`. Their next coefficients are `9/25` and `-351/25`. This gives AUM-related discussion a concrete distinction: equal current function values do not determine an equal next parameter update. The School experiment measures whether a learner can use this rule; it does not claim that the learner's own weights underwent that update.

## Conditions and disclosure

A seed produces three teaching examples, four diagnostic cases, and four fresh transfer cases. Each evaluated group contains three target step questions and one retention product question.

| Order | Condition | Cases | Lesson in context | Registered saved memory |
| --- | --- | --- | --- | --- |
| 1 | `baseline` | Diagnostic | No | No |
| 2 | Teacher lesson | Teaching examples and aggregate baseline counts | Teacher writes it | No |
| 3 | `assisted` (`retry` call phase) | Same diagnostic cases | Yes | No |
| 4 | `cold` | Same diagnostic cases, fresh context | No | No |
| 5, optional | `memory` | Same diagnostic cases, fresh context | No | Explicit pinned snapshot only |
| Final | `transfer` | Fresh parameters from the declared seed | Yes | No |

The ordinary kit uses 17 calls. Enabling memory uses 21. `schoolExperimentCallCount` supplies the queue's call budget. Each call has one fresh participant context, existing output/deadline limits, and no automatically repeated uncertain provider call.

Generated manifests retain a 600,000 ms episode limit and set the per-call limit to `min(30,000, floor(600,000 / plannedCalls))` ms. The ordinary 17-call experiment therefore keeps 30,000 ms per call; the 21-call memory experiment uses 28,571 ms. This keeps the sum of nominal call limits within the episode limit. Per-call setup, storage and other execution overhead still consume the episode's wall-clock budget, so this is not a guarantee that every call can use its entire allowance and the episode will complete.

Diagnostic cases deliberately repeat: assisted improvement alone could be answer-specific. Transfer cases are withheld from teaching and use distinct normalized task inputs. Case identity ignores renamed IDs, exchanged factors, and parameters irrelevant to a product question. It does not establish novelty relative to pretraining, rule out every mathematical equivalence, or establish transfer beyond this task family.

The transfer condition is explicitly **lesson assisted**. The cold condition is an immediate fresh-context repeat; it is not delayed retention, a server restart, or proof about hidden provider state. The optional memory condition tests a supplied external memory snapshot under the same declared model state. The runner neither writes a new memory nor updates weights.

The owner manifest contains answer keys and the full sealed inventory. “Sealed” is a participant-view boundary: learners receive only their current problem, and the teacher receives approved teaching material plus diagnostic aggregate counts. The private manifest should not be pasted into a teacher or learner conversation. The runner never makes a second teacher call after final evaluation begins. The terminal owner report includes condition counts and missing coverage, including when execution failed partway through.

## Run the deterministic controls

Use the repository's supported Node runtime and install dependencies first. Validate the checked-in example:

```sh
npm run school:experiment -- check examples/school/factorized-step.json
```

Run a helpful control through the real episode runner, registering the example class in an isolated School root:

```sh
npm run school:experiment -- run examples/school/factorized-step.json \
  --operation factor-helpful-19 --fixture helpful \
  --class examples/school/factorized-class.json --school /tmp/school-factorized
```

Repeat with the harmful and memorizing controls:

```sh
npm run school:experiment -- run examples/school/factorized-step.json \
  --operation factor-harmful-19 --fixture harmful \
  --class examples/school/factorized-class.json --school /tmp/school-factorized

npm run school:experiment -- run examples/school/factorized-step.json \
  --operation factor-memorizing-19 --fixture memorizing \
  --class examples/school/factorized-class.json --school /tmp/school-factorized
```

The script prints the comparison, experiment report, and saved record path. Repeating the same operation and normalized manifest returns the identical terminal record without executing more calls. A different control or other content requires a new operation ID.

| Scripted control | Baseline target | Assisted target | Assisted retention | Cold target | Transfer target | Transfer retention |
| --- | --- | --- | --- | --- | --- | --- |
| Helpful | 0/3 | 3/3 | 1/1 | 0/3 | 3/3 | 1/1 |
| Harmful | 0/3 | 3/3 | 0/1 | 0/3 | 3/3 | 0/1 |
| Memorizing | 0/3 | 3/3 | 1/1 | 0/3 | 0/3 | 1/1 |

The harmful control must report `REGRESSION` despite improved target scores. The memorizing control shows why `CONTEXTUAL_GAIN` on repeated diagnostics is insufficient evidence of transfer. The helpful control's cold loss shows why contextual assistance is insufficient evidence of persistence.

These values are deliberately scripted control behavior, not LLM measurements. All fixture records carry `SCRIPTED_FIXTURE`. The fixtures derive answers from the supplied problem, never from the evaluator's private key. The harmful teacher adds an explicit wrong instruction to return zero on product questions, which its scripted learner follows only when that lesson is supplied. The memorizing fixture gates target success on having encountered that input in baseline; this models the measurement signature of memorization without pretending to simulate a real learning mechanism.

## Generate another reproducible experiment

```sh
npm run school:experiment -- generate --seed 71 --operation factor-pilot-71 \
  --output /tmp/factor-pilot-71.json
```

Seeds are integers from 1 to 4294967295. The output file must be new; the CLI creates it with owner-only permissions. Omitting `--output` writes the private manifest to stdout. Generation and checking do not load provider configuration or make model requests.

The parser binds teaching, diagnostics, transfer, world instructions, splits and answer keys to the declared generator revision and seed. Changing a key, moving a case across groups, renaming a duplicate, adding unsupported fields, or substituting a different rule refuses before dispatch. To develop another task family, introduce its own versioned generator and independent checker, with corresponding adversarial tests. Editing the sealed cases in an existing generated manifest is not a supported experiment variant.

The generated manifest can be imported into the School console, or submitted to the existing episode/queue entry points. Its `experiment` field is an optional extension to version 2; existing episodes keep their previous semantics. The class remains `learning-dynamics` revision `1`, unit `factorized-step`, unless the owner selects another registered class revision whose unit binds the same world.

## Use local or hosted models

Follow [Continuing participants and named connections](school-participants.md) to register a learner, teacher, named connection and exact state revision. Set each manifest participant to the registered model, edition and `stateRef`. Enroll the selected IDs in the referenced class with learner/teacher roles. Keep the generated task inventory and world instructions intact.

Then run the same manifest without `--fixture`:

```sh
npm run school:experiment -- run /tmp/factor-pilot-71.json \
  --school /absolute/path/to/school-data
```

This dispatches to the selected configured providers and can incur their normal usage. Named local endpoints use the registered connection revision; hosted participants use the existing provider and account-permission path. No new hosted authentication path is introduced by this kit. A changed registered state, revoked connection, or changed resolved runtime route refuses execution rather than silently changing the admitted experiment.

Model names and declared artifact hashes do not attest loaded weights. Runtime receipts keep `loadedArtifact: NOT_ATTESTED`. A credible local pilot should record the actual server/model build and run several seeds chosen before inspecting results. Keep exploratory seeds separate from any final evaluation set; selecting only successful seeds after the fact changes the question being measured.

## Optional saved-memory condition

Generate with `--memory`, then select a registered learner state containing nonempty `memory.text` and explicit `sourceIds`. The state must exist before admission. Missing or blank saved memory refuses the entire experiment before the first model call.

```sh
npm run school:experiment -- generate --seed 71 --operation factor-memory-71 \
  --memory --output /tmp/factor-memory-71.json
```

The same pinned memory snapshot is supplied only to the four `memory` calls. Baseline, lesson, assisted, cold and transfer omit it. Each memory call has no lesson. Memory hashes are saved in binding and exposure receipts; raw memory text is present only where the owner explicitly inspects its state or corresponding call view.

For a deterministic memory fixture, explicitly register a `configured` connection with provider `school-fixture` and a learner state whose model is `scripted-factorized-helpful-v1` with provider `school-fixture`. Select that exact state in the manifest and use `--fixture helpful`. The CLI preserves an explicitly matching scripted state, including its edition. It refuses to repurpose a real participant state as a memory fixture. Other fixture runs replace participant model selections with the chosen scripted model and remove unrelated state references.

Even a perfect memory score remains external-memory assistance. The kit does not infer a weight update, automatic memory formation, delayed retention, or general intelligence from it.

## Evidence and checks

The episode record retains the manifest fingerprint, class revision, participant bindings where supplied, runtime receipts, every requested view and system prompt, bounded raw replies, grades, ordered events, comparison and condition report. Raw replies reach durable storage before grading. A failed or interrupted call has an explicit completion state; unknown completion is never treated as permission to retry automatically.

Evidence validation checks the full declared call-plan prefix and reconstructs each permitted participant view. A cold attempt carrying a lesson, an extra teacher turn after final evaluation, a changed learner system prompt, a completed label with missing final work, or a report unsupported by retained replies is refused. The store also checks saved-memory content against the binding recorded at admission. Recomputing an exposure hash does not make a different condition or memory snapshot valid.

Each experiment call also has an exposure receipt with the sequence, role, condition, case ID and SHA-256 hashes of its canonical prepared view and applicable problem, lesson and memory. The hashes bind what School prepared without copying the private content into the receipt. They exclude object key insertion order but preserve strings and array order. A receipt is written before dispatch and says `delivery: NOT_ATTESTED`; consult the call's admission, reply and completion evidence to distinguish a prepared view from a completed provider call. This ledger cannot know a model's pretraining exposure or prove how a server internally handled a context.

Missing outcomes stay `ABSENT` or `INSUFFICIENT`, with `correct: null` when no reply was graded. They do not become zero scores. Reports keep `weightLearning: NOT_PERFORMED`, `persistence: NOT_ESTABLISHED` and `generalization: NOT_ESTABLISHED`, with an explicit `THIS_GENERATOR_AND_SEED` evidence scope and `LESSON_ASSISTED_FRESH_PARAMETERS` transfer condition.

Focused verification:

```sh
node --import tsx --test tests/school-experiment.test.ts tests/school-experiment-runner.test.ts
```

The tests cover exact arithmetic, wrong but syntactically valid answer artifacts, mutated private keys, duplicate/renamed inputs, stable generation, withholding, real runner phases, raw-before-grade durability, receipt ordering, harmful and memorizing controls, replay, partial final coverage, registered memory isolation, and missing-memory refusal. They disable external fetches and use isolated fixture state. They establish the machinery's behavior; model-dependent capability, latency, context limits and repeatability require the local pilot.

A separate [Python arithmetic witness](evidence/school-workbench-oracle-2026-11-09.json) checked 1,419 keys with `fractions.Fraction`, deriving each gradient through exact symmetric differences of the quadratic loss. It shares no TypeScript arithmetic or update formula. This includes seeds 1–128 and the checked-in seed 19 inventory again; it is a bounded sample, not an exhaustive proof. Reproduce it from the repository root with new output paths:

```sh
node --import tsx docs/evidence/school-oracle-input.mjs /tmp/school-workbench-independent-cases.json
python3 docs/evidence/school-oracle-check.py /tmp/school-workbench-independent-cases.json /tmp/school-workbench-independent-summary.json
```
