# Remodeling LearnHarness into School

This staged plan originated in [foundation PR #3](https://github.com/bdf1992/school/pull/3). Its restricted session projection is retained. The continuation also adds a separate manifest-based episode runner; see [current intent](school-intent.md) and [Model episodes](school-episodes.md) for the implemented interface and limits.

Updated 2026-11-09. Direction: Bdo requested a fork for local LLMs, Claude, and OpenAI/ChatGPT agents, with immediate remodeling. [Tracking issue #1](https://github.com/bdf1992/school/issues/1) owns delivery.

## Purpose

School should let us supply a world or subject, select participants, run a teaching and learning episode, inspect the evidence, and continue from the result. Humans and machine learners should use the same explicit relationships while receiving information appropriate to their roles.

LearnHarness provides a substantial human teaching application. Its existing model settings select tutors and supporting agents. School adds the learner as an explicit participant rather than interpreting a tutor-provider change as machine learning.

The [glossary](../CONTEXT.md) defines the roles. The original [teaching methodology](teaching-methodology.md) records upstream pedagogical intent; its goal of a lesson feeling obvious is not School's criterion for a verified machine capability.

## Current foundation

The initial foundation contribution established School's purpose, fork identity, a read-only restricted learner projection, and a graph merge correction. Existing human lessons remain the working application.

The projection takes an explicitly supplied native session record and returns permitted fields from pending questions/problems. It does not provide arbitrary transcript access, credentials, answer keys, private reasoning, evaluation answers, or an automatic model call. Unsupported and ambiguous records refuse instead of silently widening access.

The graph correction rejects a chain whose premise cannot be resolved or becomes identical to its conclusion. It never manufactures a stronger inference by dropping that premise. Source propositions remain retained. This is a narrow semantic correction; graph extraction and identity judgments still require qualification.

## Preserve the useful parts

- Prober → teacher handoff, explicit lesson plans, and a separate practice role.
- Recorded question identities, attempts, assistance, and precommitted solutions.
- Local records and read-only archival tools.
- Background computation separated from delivery of its result.
- Existing provider, CLI, desktop, and local-inference infrastructure.
- Original authorship, license, data, and source history.

Provider identity is separate from participant role. Claude or an OpenAI model can teach, learn, or judge under an appropriate adapter. Available API/CLI/subscription capabilities must be checked rather than inferred from a product name.

## Information boundaries

These are the target role boundaries for the complete workbench. The archived-session projection exposes only pending task fields. The separate manifest-based episode runner now supplies its own learner/teacher/evaluator views; richer session context and an adapter connecting these two interfaces remain future work.

| View | Permitted material | Excluded material |
| --- | --- | --- |
| Learner | Posed task, allowed observations, permitted prior work, authorized hints | Hidden answer keys, unrevealed solutions, withheld evaluation, unrelated private state |
| Teacher | Learner attempts, declared goals, supplied material, qualified feedback | Independent holdout answers unless their disclosure is explicitly part of the experiment |
| Evaluator | Task criteria, oracle or rubric, retained attempt, declared assistance | Authority to rewrite the learner's attempt or invent an executed effect |
| Review/archive | Attributed original records and separate results | Automatic authority to expose all contents to other roles |

Absence of an observation is not an incorrect answer. Insufficient evidence is not certainty. Contradictory evidence is retained as a conflict. Self-reported confidence, teacher interpretation, answer-key matching, and independent verification have separate standing.

## Delivery sequence

### 1. Foundation — this contribution

Establish purpose and shared terms; give the fork its own identity; add a runnable restricted learner view and regression coverage; correct the confirmed inference-strengthening defect. The command must preserve the original record and reject cases it cannot interpret safely.

### 2. One real machine-learner lesson

Add a learner adapter independent of the tutor's model selection. Start with the existing local OpenAI-compatible serving route and support hosted/CLI agent participation through explicit contracts.

Submit raw attempts to a server-owned evaluation boundary. The learner must never self-author its accepted grade. Keep immutable episode, task, participant/edition, attempt, assistance, criterion, budget, and stop identities.

The first acceptance run is probe → teach → practice → independently evaluate using an actual configured learner. Interrupt it after a retained attempt and resume the same pending work without duplication or invented answers.

### 3. Capability and source evidence

Keep two connected bodies of records:

1. Material and claims: original propositions, candidate identity links, premises, sources, and curriculum relationships.
2. Learner evidence: tasks, attempts, assistance, evaluations, retained failures, model editions, and measured changes.

Graph membership is not mastery. Plan position is not a grade. Make graph simplification a reviewable projection and preserve the assertions it derives from.

Separate diagnostic/training material from withheld and retention tasks. Compare the parent before teaching, the parent with lesson context, and any candidate under cold evaluation. Declare whether an intervention changed context, retrieval, code, parameters, or representation.

### 4. AUM episode bridge

Expose a narrow interface for inspect → propose → execute → evaluate → adopt/reject → continue.

School owns its lesson/session presentation. AUM owns model editions, admitted training/adoption operations, and authoritative receipts. The two systems exchange records; they must not concurrently write the same authoritative store.

Retain exact prompts and tool definitions, participant/teacher editions, data, training recipe, evaluator and policy. Bind retries to operation identity and payload. Reject changed payloads under a retained identity.

Qualify the actual GPU training and serving paths before claiming a weight-learning episode. Retain the learner's chosen update separately from the teacher's assistance and the optimizer's numerical work. After adoption, the successor continues the pending lesson and makes its next consequential choice.

### 5. A teaching workbench for us

Add selectable human/model/agent learner roles, episode inspection, parent/candidate comparisons, source and capability views, and clear adoption/continuation status. Let the observed first loop determine the interface changes.

## First subject: same function, different learning

Use factorized adapter calculations with an exact independent checker. The teacher probes equivalence of effective products, rescaling, and the next optimization step, then teaches from observed misses.

Practice on fresh factors, scales, targets, and rates. A frozen-model lesson first measures context effects. A later qualified adapter update uses the same task family with withheld and retention cases.

A successful claim states which behavior improved, which previous behavior was retained or lost, what assistance was available, and which learner edition continued. A failed or refused candidate remains a useful recorded result.

## Review findings carried forward

The reviewed upstream baseline is `da08cb5f7d098598ba963c6689b22054c9f2a5a3`.

- Native archival records contain answers and solutions before the learner responds; the read-only skill is an archive interface, not a learner observation boundary.
- Teacher/answer-key agreement is not independent truth checking.
- Graph extraction consumes teacher prose and imports, excluding learner attempts and grades. Its identity auditor does not establish the truth of an assertion.
- The merger could remove an unresolved or conclusion-equivalent premise. This contribution corrects that weakening of the premise set.
- Background result delivery has useful durable receipts, but the existing file-backed runtime is single-owner. Its job deduplication, turn expiry, and Windows write fallback do not establish AUM's stronger training/adoption semantics.
- Exact model/prompt/optimizer provenance needs an episode manifest beyond a saved chat.

The existing tests establish their exercised contracts. Neither the portable reader suite nor a fixture-backed boundary test establishes live model quality, successful GPU training, or general learning.

## Fork discipline

Keep the downstream diff focused and preserve upstream history and AGPL attribution. School support, product identity and release/update destinations belong to this fork. Existing authentication and provider protocol identifiers remain compatible; changing those requires a separate tested migration.

School has no inherited entitlement to upstream signing, release credentials, or distribution. A build or update route must identify what is actually available. Do not migrate or reuse a person's upstream data silently.
