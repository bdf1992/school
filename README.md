# School

**A school for teaching and evaluating people, local language models, and hosted agents.**

School organizes continuing classes with a roster, curriculum, schedule, peers, and a gradebook. Every new model episode belongs to a named class and curriculum unit. Within that setting, a learner and teacher work in an explicit world while an evaluator records what happened. A local model can learn while Claude or an OpenAI model teaches it; provider choice does not determine the role.

We are remodeling [LearnHarness](https://github.com/amosblomqvist/learnharness) into this workbench while retaining its human teaching and practice application. The initial fork base is `da08cb5f7d098598ba963c6689b22054c9f2a5a3`. Upstream authorship and the AGPL-3.0-only license remain intact.

[Intent and boundaries](docs/school-intent.md) · [Classroom](docs/school-classroom.md) · [Participants and connections](docs/school-participants.md) · [Experiments](docs/school-experiments.md) · [Queued work](docs/school-runs.md) · [All documentation](docs/README.md)

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

An optional generated experiment adds **cold**, explicitly selected **saved-memory**, and **lesson-assisted transfer** conditions. Its factorized scalar task checks authored answer keys with an independent exact-arithmetic oracle. Each condition records its own supplied context and coverage; missing answers remain missing. Continuing participants select immutable state and connection revisions, so a later memory snapshot cannot rewrite an earlier episode.

## Open the classroom

Run `npm run dev` and choose **Classroom** in the sidebar, or open `/school`. Import a class revision, register participants and named connections, and prepare a model episode from a manifest. **Queue episode** saves work; **Run due work** explicitly starts a bounded pass. The console shows each learner's grades, assistance conditions, state receipts and retained evidence. Opening or refreshing the page makes no model calls.

Run the independently checked experiment without a model server:

```sh
npm run school:experiment -- check examples/school/factorized-step.json
npm run school:experiment -- run examples/school/factorized-step.json --fixture helpful --class examples/school/factorized-class.json --school /tmp/school-experiment --operation factor-helpful
npm run school:experiment -- run examples/school/factorized-step.json --fixture harmful --school /tmp/school-experiment --operation factor-harmful
npm run school:experiment -- run examples/school/factorized-step.json --fixture memorizing --school /tmp/school-experiment --operation factor-memorizing
```

Each default experiment retains 17 scripted calls. The controls demonstrate contextual gain, harmful regression, and a memorizer failing on fresh parameters. They qualify the experiment machinery; actual local/hosted model qualification remains a separate run. See [Experiments](docs/school-experiments.md) for generating new seeds and the additional saved-memory condition.

## Check a local route and a constructed artifact

After registering a [participant, named connection and state](docs/school-participants.md), check that the exact endpoint advertises the selected model before starting inference:

```sh
npm run school:preflight -- --participant local-learner --state base --school /absolute/school-root --output /absolute/new-preflight.json
```

The [preflight](docs/school-preflight.md) makes a bounded model-list request and saves a receipt. It performs no generation and does not verify loaded weights, reasoning settings, answer quality or inference latency. Use a new output path for every observation. A successful preflight is followed by one explicitly started [queued episode](docs/school-runs.md), with the learner and teacher each bound to their intended state.

The [parity artifact checker](docs/school-parity.md) accepts a finite-state machine as JSON, validates its structure, and tests its behavior on all 256 bytes and a declared set of additional bit strings:

```sh
npm run school:parity -- check examples/school/parity-machine.json --output /absolute/new-parity-pass.json
npm run school:parity -- check examples/school/parity-machine-mutated.json --output /absolute/new-parity-fail.json
```

The second command deliberately exits unsuccessfully and retains the failing inputs. Both examples are authored controls. A model's saved artifact can be checked through the same command; a passing byte score does not prove correctness for every possible string. This is a standalone artifact evaluation, separate from class grades and world-action admission.

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

For a configured run, set up existing providers or [named connections](docs/school-participants.md), register a class with the intended participant IDs, assign actual learner and teacher models in the episode manifest, give the operation a new identity, and omit `--fixture`. Use the classroom, CLI or API. See [Classes](docs/school-classes.md) and [Model episodes](docs/school-episodes.md) for admission, schedules and replay.

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

Available connections include provider API keys, supported desktop/web subscription connections and an installed [Claude Code CLI](docs/claude-code.md). The inherited human flow has one [custom OpenAI-compatible endpoint](docs/custom-providers.md); registered School participants can use multiple independent [named endpoints](docs/school-participants.md), including servers advertising the same model ID. A local inference server must already exist; School does not install, train, or download its models. Subscription, API, and CLI routes keep their existing admission and billing semantics.

Model-driven work sends the permitted context to the selected provider. Chats, graphs, settings, and episode records are local files. Local storage does not imply offline inference. Keys and subscription credentials must remain private.

## Current scope

- Human teaching/practice, persistent sessions, graph extraction, and provider connections inherited from LearnHarness.
- Explicit learner/teacher manifests, bounded model-call orchestration, independent exact-answer evaluation, and inspectable episode records.
- Immutable class revisions, roster/role checks, curriculum dependencies, self-paced or dated session admission, private peer work, and an evidence-derived owner classroom and gradebook.
- Continuing participant/state records, explicit saved memory, named endpoint revisions, dedicated credentials and dispatch-time drift checks. Declared artifact hashes remain owner declarations; loaded model weights are not attested.
- A durable queue with bounded sequential work, explicit due times, cancellation, dead-worker recovery and evidence reconciliation. An explicitly started CLI worker can watch for due work; opening the UI does not start one.
- Generated factorized tasks with independently checked keys, sealed transfer inputs, exposure receipts and separate baseline, assisted, cold, saved-memory and transfer reports.
- A bounded named-connection preflight and an independent finite-state parity artifact checker with retained behavioral counterexamples.
- Separate School desktop identity and default update feed. Existing `LH_*` environment variables and data formats remain compatible.
- Actual local/hosted model qualification, broader task artifacts, peer interaction, fleet resource limits, automatic learning-memory updates, the AUM training bridge and native release qualification remain in [the remodeling issue](https://github.com/bdf1992/school/issues/1).

## Development and support

```sh
npm run typecheck
npm run lint
npm test               # fixtures and fake providers; no paid inference required
```

Pull requests run `python scripts/pr_tests.py`: only the tests the change touches, stopped at 60 s.
Releases run `python scripts/release.py vX.Y.Z`: the whole suite on this PC, then the version tag.

See [Development](docs/development.md), [Architecture](docs/architecture.md), [Getting started](docs/getting-started.md), and [Desktop builds and releases](docs/desktop-release.md).

Use [School issues](https://github.com/bdf1992/school/issues) for this fork. Report vulnerabilities through the process in [SECURITY.md](SECURITY.md). Upstream maintainers and services are not School's support channel.

## License and attribution

[AGPL-3.0-only](LICENSE). School builds on LearnHarness by Amos Blomqvist and its contributors. Historical designs, teaching-method notes, and inherited artwork retain their attribution; their inclusion does not establish measured learning outcomes or a School release qualification.
