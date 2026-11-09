# School's intent

School is a workbench for arranging, running, and inspecting teaching and learning episodes across humans, local models, and hosted agents. It should make clear what a learner could observe, what it attempted, how the teacher helped, what an evaluator checked, and what actually changed.

The implementation roadmap is [issue #1](https://github.com/bdf1992/school/issues/1). This document states the intended direction and distinguishes it from the [current episode interface](school-episodes.md).

## Vocabulary and authority

| Term | Meaning and authority |
| --- | --- |
| World | The task environment and its declared revision. World truth can exceed the observations supplied to a participant. The first implementation uses finite authored cases. |
| Subject | The distinction, method, structure, or capability being taught. It is independent of the provider. |
| Learner | The human or model whose response is being measured. A model participant has an explicit provider/model reference and may declare an edition. A declared edition is not an attestation of loaded weights. |
| Teacher | The participant choosing explanations, examples, and practice. Teaching authority does not confer grading or adoption authority. |
| Evaluator | A named procedure that checks a committed response against a declared criterion. The first evaluator is `trimmed-exact-v1`; it checks string equality, not semantic truth. |
| Lesson | Attributable assistance offered to the learner. It can affect the next response through context without changing the learner's weights. |
| Attempt | A learner response preserved before the evaluator attaches a judgment. Failed and interrupted calls remain evidence of an attempted operation. |
| Evidence | The allowed view, raw response, assistance, evaluator, outcome, and execution mode needed to assess a claim. A fixture is identified as a fixture. |
| Edition | A reference to a particular learner configuration or artifact. Verified artifact identity, training lineage, and adoption belong to the future AUM bridge. |
| Episode | An operation binding a manifest, participant roles, task cases, limits, calls, and comparison into an inspectable record. |

School must preserve distinctions among missing information, insufficient information, sufficient information, incorrect answers, refused operations, and execution failures. The first manifest permits explicit observation statuses; these statuses are author declarations. Their truth is not automatically verified.

## What we are retaining

LearnHarness provides an existing human learning application: probing, dependency planning, teaching, varied practice, persistent sessions, provider routing, background work, graph extraction, and portable readers. These are useful foundations. The remodel keeps that flow while adding a separate model-learner episode boundary.

The graph stores attributed propositions and jointly-entailing chains. A node's existence, a visited lesson step, learner confidence, or teacher agreement does not establish capability. Simplifying the graph must preserve the consequences of the admitted rules. The graph is also not a substitute for the full episode archive: simplification can discard redundant structure and its attached provenance.

The inherited [teaching theory](teaching-methodology.md) remains an attributed design source. School can test its prescriptions; it does not present them as experimentally established outcomes.

## The first operational boundary

An authored manifest separates teaching examples from evaluation cases. The learner receives only the current problem, permitted observations, world instructions, and, on retry, the teacher's lesson. The teacher receives teaching examples and aggregate baseline counts. Neither participant receives evaluation answer fields from the manifest.

The server saves each raw reply before grading it. The exact checker compares the extracted text with the authored expected answer. A comparison can report a target gain, no measured gain, or a regression on a previously correct case. This measures assistance on the declared cases; it does not establish generalization or prove the answer key is correct.

Operation identity binds the normalized manifest and execution mode. A completed identical request can return its record without inference. A changed request under the same identity is refused. An interrupted operation is inspectable; it is not automatically replayed when provider completion may be unknown. These are persistence and replay rules, not an exactly-once billing guarantee.

## School and AUM

| School owns | AUM should own |
| --- | --- |
| Curriculum, examples, lesson interaction, permitted participant views | Model artifact identities, editions, optimizer/training execution |
| Recorded attempts and declared evaluation requests | Independent adoption and retention policy, training/adoption receipts |
| Presentation of comparisons and unfinished lesson obligations | Preservation of continuing world work through a model transition |

The bridge should exchange explicit manifests and receipts. It must distinguish context changes, saved knowledge, program changes, policies, adapters, and weights. A grade supplies a judgment; a gradient requires a differentiable objective and an optimizer. A future accepted successor should continue the pending task and make the next consequential choice before the episode is called complete.

The intended first qualified AUM experiment concerns factorized adapters: two representations can implement the same present function yet take different future learning steps. That experiment needs a real configured learner, a held-out evaluator, retention tasks, an actual update path, and a harmful candidate that is rejected. The small byte-parity fixture only establishes the School execution boundary.

## Learning to generate structures

A subject may concern bits or bytes, tokens, state transitions, projections, grammars, graphs, or spaces. School's role is to make a claimed generative capability testable. Each task needs an output contract, allowed inputs/actions, and a checker appropriate to the generated object.

For example, a grammar-producing learner could emit a grammar, generate accepted strings, and face withheld valid and invalid examples. A state-machine learner could generate transitions and face reachability or invariant checks. A projection task must declare what information the projection preserves and loses. Merely serializing an object does not demonstrate that the learner understands or can use its structure.

Graphs can record dependencies and alternative interpretations. Tensors can evaluate a declared factorization with typed axes and specified algebra. Relative frames require explicit transformations before torsor language adds operational value. These are possible task mechanisms, not blanket claims about the current School runtime. The first evaluator handles exact textual answers only.

## Next evidence gates

1. Qualify the current CLI/API with actual local and hosted participants, including failure, cancellation, and cost records.
2. Add role selection and episode comparison to the UI without exposing answer keys through archived human-session transcripts.
3. Add a cold/no-lesson condition, independent case generation, and task-specific evaluators before claiming retention or transfer.
4. Connect AUM's edition and training receipts, then demonstrate update, independent evaluation, adopt/reject, and task continuation.
5. Qualify School's own native installers, provider authentication ownership, and update delivery.
