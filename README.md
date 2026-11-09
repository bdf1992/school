# School

**A school for teaching and evaluating people, local language models, and hosted agents.**

School organizes continuing classes with a roster, curriculum, schedule, peers, and a gradebook. Every new model episode belongs to a named class and curriculum unit. Within that setting, a learner and teacher work in an explicit world while an evaluator records what happened. A local model can learn while Claude or an OpenAI model teaches it; provider choice does not determine the role.

We are remodeling [LearnHarness](https://github.com/amosblomqvist/learnharness) into this workbench while retaining its human teaching and practice application. The initial fork base is `da08cb5f7d098598ba963c6689b22054c9f2a5a3`. Upstream authorship and the AGPL-3.0-only license remain intact.

[Intent and boundaries](docs/school-intent.md) · [Classes](docs/school-classes.md) · [Model episodes](docs/school-episodes.md) · [Remodeling issue](https://github.com/bdf1992/school/issues/1) · [All documentation](docs/README.md)

## The learning loop

| Part | Responsibility |
| --- | --- |
| Class | Bind membership, curriculum, schedule and assessment policy across episodes. |
| World and subject | Define the task, available observations, and what a valid response means. |
| Learner | Attempt the task using its permitted view and declared model/edition. |
| Teacher | Select explanations and examples from permitted teaching material. |
| Evaluator | Check retained responses against a declared criterion. |
| Records | Preserve inputs, assistance, raw replies, judgments, failures, and operation identity. |

The first model episode runs **baseline → lesson → retry → comparison**. The teacher sees teaching examples and aggregate baseline scores. Evaluation answers stay at the evaluator boundary. Learner replies are saved before grading. Target improvement and loss on previously correct cases are reported separately.

This episode measures **contextual assistance**. It does not train weights or adopt a successor model. School owns curriculum and episode interaction; [AUM](https://github.com/bdf1992/aum-foundation) owns the proposed model-training, edition, adoption, and continuing-world-work boundary. An integration with that boundary remains planned.

## Run a class with two learners

Use Node 26, matching CI, and the checked-in lockfile:

```sh
npm ci
npm run school:class -- register examples/school/byte-parity-class.json --school /tmp/school-demo
npm run school:episode -- examples/school/byte-parity.json --fixture --school /tmp/school-demo --operation parity-a
npm run school:episode -- examples/school/byte-parity.json --fixture --school /tmp/school-demo --operation parity-b --learner local-peer
npm run school:class -- grades generative-structures 1 --school /tmp/school-demo
```

The fixture uses scripted participants, makes no provider requests, and labels its results `SCRIPTED_FIXTURE`. The two learners share the class curriculum while retaining separate attempts and grades. Each episode pins the admitted class revision. Repeating an operation returns its original evidence without more calls. Use a suitable absolute School directory on Windows.

For a configured run, set up connections in the app, register a class with the intended participant IDs, assign actual learner and teacher models in the episode manifest, give the operation a new identity, and omit `--fixture`. See [Classes](docs/school-classes.md) and [Model episodes](docs/school-episodes.md) for admission, schedules, APIs and replay. These interfaces currently live in the CLI and API; the existing lesson UI still serves human learners.

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
- Immutable class revisions, roster/role checks, curriculum dependencies, self-paced or dated session admission, private peer work, and an evidence-derived owner gradebook. A schedule does not automatically run a model; peer messaging and a class UI remain planned.
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
