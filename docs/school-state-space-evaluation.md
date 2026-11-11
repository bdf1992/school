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
