# School adaptation readiness

**Reviewed 2026-11-21 against School main `a64ab5c277f98b0408f5e1ab69f71e3fda91deaa`.**

School provides teaching episodes, immutable learner-state records and independently checkable tasks. A verified path from those episodes to training, loading and adopting an updated neural learner remains proposed integration work.

The [open-weight adaptation compilation](research/open-weight-adaptation-2026-11.md) and [research index](research/open-weight-adaptation-2026-11.json) describe upstream methods and possible studies. Availability in an upstream library does not establish that School implements or has qualified that method. The index is reference material, with no execution semantics.

## What School already provides

The [current episode interface](school-episodes.md) binds a learner and teacher to a class, curriculum unit and declared world. It retains permitted inputs and raw replies before grading. Its basic sequence compares a baseline with a retry after a teacher's lesson and reports improvement and regression separately.

That sequence measures **contextual assistance**. Its comparison explicitly records `weightLearning: NOT_PERFORMED`, `adoption: NOT_REQUESTED` and `generalization: NOT_ESTABLISHED`. The [controlled experiment workflow](school-experiments.md) additionally distinguishes fresh-context cold attempts, explicitly selected saved memory and lesson-assisted transfer. These conditions describe what a participant received; they must remain visible when interpreting a score.

Other useful foundations are already present:

| Foundation | Existing boundary |
| --- | --- |
| [Classes](school-classes.md) | Immutable revisions bind roster roles, curriculum, world and session admission. |
| [Participant states](school-participants.md) | Exact state and connection revisions preserve lineage, declared artifacts and optional memory snapshots. |
| [Connection preflight](school-preflight.md) | A bounded request checks whether the exact named endpoint advertises the selected model. |
| [Queued work](school-runs.md) | Operation identity, retained outcomes and unresolved completion support inspection without automatic replay of uncertain work. |
| [Parity artifact checks](school-parity.md) | Structural validation and finite behavioral checks retain counterexamples for rejected candidates. |

Participant states can declare hashes for weights, adapters, programs or context. Those declarations do not prove that a server loaded the corresponding artifact. Runtime and preflight receipts retain `loadedArtifact: NOT_ATTESTED`. The ordinary model-episode runner also supplies no tools to its participants; an agent-training environment would require additional implementation.

## What was checked in this review

The [retained School observations](evidence/adaptation-readiness-2026-11-21/README.md) contain the exact invocations, raw results, source identities and integrity manifest.

Existing School tests exercised class admission and storage, experiment arithmetic and exposure controls, parity artifacts and their CLI, and learner-view isolation. **56 tests passed, none failed, and one external-runtime integration test was explicitly skipped.** The skipped test requires an independently supplied Foundation runtime; this review did not qualify that integration.

The repository's independent Python arithmetic witness also passed: **1,419 authored keys matched, and all 1,419 deliberately altered keys were rejected**. Its 129 batches comprise generated seeds 1–128 plus the checked-in seed-19 fixture. That fixture overlaps a generated population, so these are not 129 independent samples of model behavior.

Five provider-dependent test files were attempted but stopped during module loading because `@earendil-works/pi-ai` was unavailable. Their assertions did not execute. This establishes neither a passing provider suite nor a product regression.

The checks used an isolated, partial source snapshot with relevant files verified against the recorded School commit. The host ran Node **24.22.3**, Python **3.12.14** and reused tsx **4.23.12**; School CI specifies Node **26**. There was no complete lockfile installation, full-application typecheck, lint, build or release qualification. No model generation, neural training, adapter loading or learning gain was observed.

## Proposed next boundary

School's public [ownership description](school-intent.md#school-and-aum) assigns curriculum, permitted views and evaluation requests to School, while assigning model-training execution, editions, adoption and continuing-world-work responsibility to AUM. Preparation should preserve that division.

A first proposed handoff would select admitted training material, retain its provenance, evaluate an unchanged parent and an identified candidate under the same cold protocol, and preserve the resulting adoption or rejection decision. Whole episode archives cannot serve as training exports: they contain private evaluation material. Training, model selection and final evaluation need separate populations.

Preference training adds another requirement: chosen and rejected responses must correspond to the same prompt and permitted context. A baseline reply and a lesson-assisted retry are not automatically a valid preference pair. Successful file creation, a changed edition label or an improved lesson-assisted score cannot establish a persistent neural update.

Implementation remains subject to [AGENTS.md](../AGENTS.md) and [CONTRIBUTING.md](../CONTRIBUTING.md). The next reviewable decision is the first bounded handoff and its evidence requirements. The current checks support reuse of School's deterministic measurement foundations; training, verified loading and successor continuation still require their own witnessed qualification.

## Design discussion

The proposed integration is tracked in [School issue #18](https://github.com/bdf1992/school/issues/18). The detailed backend assessment and integration proposal are available in the [private AUM review](https://github.com/bdf1992/aum-foundation/pull/108) to collaborators with access. This public note and its evidence use public School sources only.
