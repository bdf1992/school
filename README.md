# School

**A harness for teaching and evaluating humans, local language models, and hosted agents.**

School organizes a learning episode around a world, a subject, a learner, a teacher, an evaluator, and inspectable records. A local model can be the learner while Claude or an OpenAI model teaches it. Roles are assigned explicitly; the choice of provider does not determine who teaches or who learns.

We are remodeling [LearnHarness](https://github.com/amosblomqvist/learnharness) into this workbench while retaining its human teaching and practice application. The initial fork base is `da08cb5f7d098598ba963c6689b22054c9f2a5a3`. Upstream authorship and the AGPL-3.0-only license remain intact.

[Intent and boundaries](docs/school-intent.md) · [Model episodes](docs/school-episodes.md) · [Remodeling issue](https://github.com/bdf1992/school/issues/1) · [All documentation](docs/README.md)

## The learning loop

| Part | Responsibility |
| --- | --- |
| World and subject | Define the task, available observations, and what a valid response means. |
| Learner | Attempt the task using its permitted view and declared model/edition. |
| Teacher | Select explanations and examples from permitted teaching material. |
| Evaluator | Check retained responses against a declared criterion. |
| Records | Preserve inputs, assistance, raw replies, judgments, failures, and operation identity. |

The first model episode runs **baseline → lesson → retry → comparison**. The teacher sees teaching examples and aggregate baseline scores. Evaluation answers stay at the evaluator boundary. Learner replies are saved before grading. Target improvement and loss on previously correct cases are reported separately.

This episode measures **contextual assistance**. It does not train weights or adopt a successor model. School owns curriculum and episode interaction; [AUM](https://github.com/bdf1992/aum-foundation) owns the proposed model-training, edition, adoption, and continuing-world-work boundary. An integration with that boundary remains planned.

## Run the first episode

Use Node 26, matching CI, and the checked-in lockfile:

```sh
npm ci
npm run school:episode -- examples/school/byte-parity.json --fixture --output /tmp/school-episodes
```

The fixture uses a scripted learner and teacher, makes no provider requests, and labels its result `SCRIPTED_FIXTURE`. It exercises the same episode orchestration, answer boundary, grading, and durable records used by configured participants. It demonstrates the harness, not a real model's ability. Use a suitable absolute output path on Windows.

For a configured run, set up the connections in the app, copy the manifest, assign your actual learner and teacher model IDs, give the operation a new identity, and omit `--fixture`. See [Model episodes](docs/school-episodes.md) for the manifest, API, record locations, and retry behavior. The episode interface currently lives in the CLI and API; the existing lesson UI still serves human learners.

## Inspect a saved session for a learner

```sh
node --import tsx scripts/school-learner-view.ts /absolute/path/to/chat.json
```

This read-only command projects supported pending questions/problems from an explicitly supplied native session record. It constructs a restricted view and refuses unsupported or ambiguous records. It does not call a model, submit an answer, or expose the full archive. The manifest-based episode runner above is a separate interface; connecting the two is a subsequent milestone.

## Open the teaching application

```sh
npm run dev            # http://localhost:3000
npm run desktop:dev    # development desktop host
```

Choose **Teach** to probe your starting point, plan a lesson, and work through explanations and checks. Choose **Practice** for varied problems. Sessions retain answers, plans, usage, and source material. The knowledge graph carries propositions and reasoning chains across sessions; graph presence is not evidence of learner mastery.

Available connections include provider API keys, supported desktop/web subscription connections, an installed [Claude Code CLI](docs/claude-code.md), and one [custom OpenAI-compatible endpoint](docs/custom-providers.md) with multiple model IDs. A local inference server must already exist; School does not install, train, or download its models. Subscription, API, and CLI routes keep their existing admission and billing semantics.

Model-driven work sends the permitted context to the selected provider. Chats, graphs, settings, and episode records are local files. Local storage does not imply offline inference. Keys and subscription credentials must remain private.

## Current scope

- Human teaching/practice, persistent sessions, graph extraction, and provider connections inherited from LearnHarness.
- Explicit learner/teacher manifests, bounded model-call orchestration, independent exact-answer evaluation, and inspectable episode records.
- Separate School desktop identity and default update feed. Existing `LH_*` environment variables and data formats remain compatible.
- No qualified School installer or live local-model training result is supplied by this foundation change. Native installation, signing, update delivery, role-selection UI, multiple local endpoints, and the AUM training bridge are tracked in [the remodeling issue](https://github.com/bdf1992/school/issues/1).

## Development and support

```sh
npm run typecheck
npm run lint
npm test               # fixtures and fake providers; no paid inference required
```

See [Development](docs/development.md), [Architecture](docs/architecture.md), [Getting started](docs/getting-started.md), and [Desktop builds and releases](docs/desktop-release.md).

Use [School issues](https://github.com/bdf1992/school/issues) for this fork. Report vulnerabilities through the process in [SECURITY.md](SECURITY.md). Upstream maintainers and services are not School's support channel.

## License and attribution

[AGPL-3.0-only](LICENSE). School builds on LearnHarness by Amos Blomqvist and its contributors. Historical designs, teaching-method notes, and inherited artwork retain their attribution; their inclusion does not establish measured learning outcomes or a School release qualification.
