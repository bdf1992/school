# School

**A workbench for teaching, learning, and evaluating people, local language models, and agents.**

School starts with a world or subject, names the participants and their roles, and runs lessons whose attempts and outcomes can be inspected. The aim is to understand what a learner can do, help it develop a capability, and establish what changed through independent evidence.

A learner may be a person, a local LLM, Claude, or an OpenAI/ChatGPT agent reached through a supported interface. A teacher prepares observations, examples, explanations, and feedback. An evaluator checks the learner's work. These are roles in an episode, separate from the model provider or application running a participant.

School is a fork of [LearnHarness](https://github.com/amosblomqvist/learnharness), created to adapt its teaching interface and recorded workflows for machine learners and AUM experiments. The inherited human teaching experience remains the operating starting point.

[Remodeling issue #1](https://github.com/bdf1992/school/issues/1) · [Direction and milestones](docs/school.md) · [Shared language](CONTEXT.md) · [Development](docs/development.md)

## World, learner, teacher, evaluator

| Role | Responsibility |
| --- | --- |
| World | Supplies the task's state, rules, available observations and actions, and consequences. |
| Learner | Receives permitted information and produces an attempt, prediction, or proposed change. |
| Teacher | Diagnoses observed gaps and supplies lessons, examples, hints, and feedback. |
| Evaluator | Checks an attempt against a declared criterion and retains the result and its limits. |
| Records | Connect sources, participants, editions, observations, assistance, attempts, decisions, and unfinished work. |

The world may be a document, an exact mathematical task, a program, an interactive environment, or a model's own editable structure. Teacher agreement, a learner's confidence, and an independently checked result remain separate observations.

## What works in this first remodeling step

- **Human lessons and practice:** the inherited prober, teacher, practice, plans, questions, provider connections, and local records.
- **Local inference connections:** the inherited custom OpenAI-compatible endpoint can run teaching-side agents. This does not yet make a configured model the student or train it.
- **Restricted learner view:** a standalone command projects pending questions and practice problems from a saved native session into a small machine-readable view. It copies permitted task fields only, refuses unsupported or ambiguous records, and leaves the source unchanged.
- **Graph inference preservation:** merging proposition identities no longer removes a required or unresolved premise and silently strengthens the remaining argument. This correction does not make model-authored claims independently true.

Automatic machine-learner participation, server-side attempt submission and evaluation, model-training jobs, and the AUM episode bridge are the next milestones. No real neural training or useful weight improvement is claimed by this foundation change.

## Try the learner boundary

Use Node 26, the version used by CI. The projection command uses Node's built-in TypeScript support and does not call a model, start the app, or read credentials.

```sh
node scripts/school-learner-view.ts /absolute/path/to/a-saved-chat.json
```

After installing the app dependencies, the same command is available as:

```sh
npm run school:learner-view -- /absolute/path/to/a-saved-chat.json
```

A saved conversation contains teacher answer keys and precommitted practice solutions. Give a machine learner the restricted view, not the raw record or archival reader output. This is a field-selection boundary: a teacher could still disclose an answer in the question itself, so evaluation material needs separate control.

The command is read-only. It does not submit an attempt, grade a response, or establish a participant's identity. Those behaviors are tracked in [issue #1](https://github.com/bdf1992/school/issues/1).

The first format is narrower than the human UI: it returns pending tasks only and omits lesson prose, prior answers, hints, and extra question details. It accepts native v1 records, including unstamped v1, but refuses reused identities, incomplete turns, missing non-question results, and raw arguments requiring the UI's legacy coercion. An `idle` result means this view has no pending task; it does not mean learning or the lesson is complete.

## What counts as learning

An episode records its starting capability, permitted assistance, attempted intervention, and subsequent evidence. Distinguish:

- improvement while a lesson remains in context;
- use of external memory or retrieved material;
- a changed program or policy;
- a trained adapter or other parameter change;
- a new representation that preserves current behavior but changes future updates.

Changing an artifact is an observed operation. Useful learning requires an appropriate comparison, fresh tasks, retained-capability checks, and honest failures. A lesson plan's visited nodes and extracted propositions do not constitute a mastery score.

## Relationship to AUM

School owns lesson interaction, practice, participant views, and review surfaces. The intended AUM bridge delegates model editions, admitted training operations, evaluation/adoption receipts, and continuing commitments to AUM.

The target loop is **inspect → propose → execute → evaluate → adopt or reject → continue**. A successor should finish work already in progress and make its next consequential choice. The bridge and actual local training qualification remain open work; the first change establishes the vocabulary and information boundary they need.

## Run the inherited application

```sh
npm ci
npm run dev
npm test
npm run typecheck
npm run lint
```

Configure providers before model-driven use. Local servers, provider APIs, installed Claude Code, and supported subscription routes have different capabilities and authorization. Existing connections are teaching-agent infrastructure; a machine-learner adapter must be configured separately when implemented.

See [custom and local models](docs/custom-providers.md), [Claude Code](docs/claude-code.md), and [development](docs/development.md). The current server is intended for trusted local use with one owner per data profile.

## Upstream and license

LearnHarness supplied the original application, teaching workflows, storage, provider integrations, and desktop foundation. Its original contributors retain their attribution. School's initial fork baseline is [`da08cb5`](https://github.com/amosblomqvist/learnharness/commit/da08cb5f7d098598ba963c6689b22054c9f2a5a3).

The [AGPL-3.0-only license](LICENSE) is retained. School support and releases belong to [this repository](https://github.com/bdf1992/school); upstream LearnHarness downloads are upstream builds, not School distributions.

For vulnerability reports, follow [School's private reporting instructions](SECURITY.md).
