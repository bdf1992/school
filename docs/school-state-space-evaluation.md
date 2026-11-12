# State-space workflow evaluation v1

This evaluation is fixed before candidates are run. It qualifies two task families and a resumable, headless workflow under the supplied Foundation v0.2 runtime.

| Task | Public contract | Baseline defect | Required evidence |
| --- | --- | --- | --- |
| Square of sum | Square the vector sum in the invocation algebra | Uses a commutative expansion | Gain under Hamilton and retain commuting-context correctness |
| Ordered difference | Return the product of the first vector with the second minus their product in the reverse order | Cancels the forward product against itself | Gain under Hamilton and preserve zero in the commuting algebra |

Each task pins the active baseline, runtime, both source algebras and ten cases before candidate submission. Five input pairs cover basis order, scalar retention, zero divisors, mixed rationals and zero under both laws. The learner receives a different public probe. Expected values are computed by direct rational table arithmetic, independently of the executable expression evaluator. An accepted candidate must pass every case and strictly improve on the baseline. Owner-authored positive and negative controls are run in the same entry point and never enter the model view. A separate post-adoption probe checks the chosen version after reopening.

The workflow passes when:

- A fresh process resumes a persisted prepared episode using the same class, learner, task address, baseline and public observation. A completed submission replays its receipt without re-execution. A conflicting submission is refused.
- An invalid or regressing proposal cannot advance the slot. The accepted proposal stays inactive until a separate owner adoption. Reopening selects the new binding and the previous invocation still resolves to the old binding.
- A provider attempt claimed before dispatch remains uncertain if interrupted without a terminal receipt. Reusing its identifier cannot send a second request. A new explicit attempt is allowed against the same prepared episode and the earlier uncertainty remains visible.
- Run two independently prepared configured-local episodes per task family, with at most one provider call per attempt. Count all four attempts, including refusals, over-budget replies, malformed replies and failed assessments. The local demonstration requires at least one independently accepted proposal per task. Recovery attempts, if necessary, have separate identities and count in the denominator. Report the four planned attempts separately from recovery.

The evaluation supports finite behavioral claims and records exactly what was exposed. Public task semantics and algebra laws let a learner derive a repair. They do not establish discovery of a hidden specification, training, or generalization beyond the measured cases.

## Reproduce

Use the [bridge setup](school-state-space.md) for Node, Python and Foundation v0.2.0. Run the deterministic controls through the supervised test selection:

```powershell
$env:SCHOOL_FOUNDATION_V020 = $foundation
python scripts/pr_tests.py
```

The controls exercise both repairs, an incorrect candidate, a forged suite override, an out-of-view read, conflicting replay, an interrupted provider claim and a setup refusal. They check both algebras after adoption and verify that replay adds zero Foundation journal events. Reference expressions are used only in the owner-side test.

For a local cohort, use a separate workspace for each planned episode so each starts on the defective baseline. Register the same configured learner state in each workspace with [School's participant CLI](school-participants.md). With the same PowerShell `Space` helper as in the bridge guide, use:

```powershell
Space init
Space learn-prepare episode-1 local-learner square-of-sum
# End this process and continue with the same workspace and episode ID.
$view = Space learn-view episode-1 | ConvertFrom-Json
Space learn-resolve episode-1 $view.snapshot $view.entry
$result = Space learn-local episode-1 attempt-1 qwen-bounded | ConvertFrom-Json
Space learn-status episode-1
# Adopt only if the retained assessment is approved.
Space learn-adopt episode-1 $result.assessment.assessment_ref
Space learn-use episode-1
Space learn-use episode-1 /contexts/commuting
```

Repeat twice per task with new workspace roots and `square-of-sum` or `ordered-difference` at preparation. Replace `qwen-bounded` with the registered state revision. Each attempt receives only the addressed learner view. Owner commands such as `learn-status` and `history` can inspect additional evidence and should not be forwarded to the learner.

A missing reply remains uncertain. Reusing its attempt ID refuses to dispatch again. To recover, explicitly select a fresh attempt ID against the same prepared episode. If a reply was recorded before assessment, rerun `learn-local` with its original attempt ID to finish assessment without another provider call. A valid rejected assessment ends that episode. Start a new episode to assess a different candidate.

For verified Ollama-only connections, School sends the endpoint's `max_tokens`, the selected reasoning effort (or `"none"` when off) and JSON response format. It still checks the reported output ceiling and admits only the declared expression forms. Other loopback engines use the ordinary School transport. [Ollama's supported request fields](https://docs.ollama.com/api/openai-compatibility)

The public probe can include its independently computed target. That target is intentionally visible and uses inputs outside the ten-case assessment. A structural refusal can supply its error message to a later attempt. The raw rejected candidate and private assessment data stay outside the next request.

The workflow is headless and task profiles are shipped with School. It provides addressed task material, one proposed body per assessed episode, and explicit owner adoption. An interactive learner-selected tool loop, model memory updates, general curriculum authoring, and the classroom UI remain separate work.

## Observed evaluation

The Workstation evidence directory is `control/runtime/school-state-space-learning-20261111`. Its `cohort-summary.json` lists every configured attempt and identifies the pinned suite for each episode. The suite digests stayed fixed across the recovery variants. Inspection of each retained request found neither its reference body nor its private suite. The public probe's input pair differed from every private case, including across contexts.

| Cohort | Accepted / attempts | Other outcomes |
| --- | --- | --- |
| Planned | 1 / 4 | Two timeouts without a retained reply and one over-budget reply |
| Explicit recovery and follow-up | 2 / 9 | One over-budget reply, three structural refusals and three failing assessments |
| Total | 3 / 13 | Three of six distinct episodes ended in acceptance |

The interruption control is separate from those 13 provider attempts. It claims an attempt and stops before dispatch. The next process refuses the same identifier and retains the unresolved claim. A separate test also resumes a submission claimed before Foundation assessment.

- `ordered-difference-2` kept its prepared episode and baseline after a 4,319-token reply exceeded its 4,096-token ceiling. After the Ollama request settings changed, a fresh attempt returned a 39-token candidate. It passed 10/10 from an 8/10 baseline and was adopted. Reopening returned `[0, 4, 2, -2]` under Hamilton and `[0, 0, 0, 0]` in the commuting algebra. A replay returned the same assessment.
- `square-low` started after earlier square-of-sum attempts timed out or failed validation or assessment. The successful run used the public target and a newly registered low-reasoning revision. It returned 2,250 reported output tokens, passed 10/10 from 8/10, and was adopted. Reopening returned `[-2/9, 0, 8/3, 8/3]` under Hamilton and `[16/9, -2, 8/3, 8/3]` in the commuting algebra. The prior square episodes and their failures remain recorded. The changed model settings and public target were introduced during recovery, so this is not a controlled comparison of their individual effects.
- `ordered-difference-1` was the single planned success. It independently passed the same ten-case suite and was adopted. All three accepted candidates were submitted unedited.

The model results establish that the workflow can recover and complete on both task families. The observed acceptance rate and the low-reasoning recovery dependence limit any claim of reliable autonomous repair. See [the first milestone audit](school-state-space-milestone-audit.md) for the handoff requirements still outside this evaluation.

The supervised selection passed 291 tests in 22.4 seconds, including both the original bridge and the resumable workflow. Typecheck passed. Lint reported one existing warning. Foundation verified the two recovered workspaces, including their retained history.
