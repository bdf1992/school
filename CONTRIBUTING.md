# Contributing to School

Bug reports, focused fixes, documentation, reviews, and testing are welcome. School adapts the LearnHarness foundation for teaching and evaluating people, local language models, and agents. The [remodeling issue](https://github.com/bdf1992/school/issues/1), [direction](docs/school.md), and [glossary](CONTEXT.md) describe this fork's purpose.

## Project direction

Discuss meaningful changes to the project’s vision, teaching methodology, agent behavior, core architecture, or major workflows with maintainers **before implementation**. New features, integrations, and storage-format changes also need discussion first.

A fix restores intended behavior; changing what the intended behavior should be is a design proposal. If that behavior is unclear, discuss it first. A fix that requires major architectural or storage changes still needs agreement on the approach.

Plugins are the intended home for optional capabilities that do not belong in core. The plugin infrastructure is still under development, so discuss the use case rather than assuming a stable extension point exists.

## Before starting

Check School's [issues](https://github.com/bdf1992/school/issues) and [PRs](https://github.com/bdf1992/school/pulls) for related work. **In progress** means someone is already working on the problem; coordinate before starting a parallel implementation. A tracking item is not, by itself, agreement to implement a proposal.

- [School issues](https://github.com/bdf1992/school/issues): concrete bugs, implementation work, and design proposals. Explain the problem, proposed behavior, and relevant alternatives.
- [School pull requests](https://github.com/bdf1992/school/pulls): implementations and their review.

Use School's repository for fork-specific support. Upstream LearnHarness remains a separately maintained project; preserve its authorship and distinguish upstream behavior from changes introduced here.

## Pull requests

**Keep each PR focused on one coherent problem.** Include the tests and documentation needed for that change, but leave unrelated fixes, refactors, dependency updates, and formatting changes for separate PRs. Follow the existing architecture and conventions.

Use **clear, precise, concise language**. Explain:

- The problem, with a link to the relevant issue or discussion if one exists.
- What changed and why it addresses the problem.
- How you verified it, including important limitations and anything untested.

Avoid unnecessary jargon, lengthy boilerplate, and unsupported claims. Distinguish observed behavior from hypotheses.

We judge contributions by their results, not the tools used to produce them. AI-assisted and manually written contributions follow the same standards; disclosure of AI assistance is not required. You are responsible for the accuracy of the description, implementation, tests, and documentation.

### Verification

Run relevant checks and add regression coverage where useful. Briefly describe what you actually tested and any important limitations—for example, whether you used a real provider or mocked responses.

See the [development guide](docs/development.md) for setup and check commands, and the [architecture reference](docs/architecture.md) for runtime boundaries.

## Bug reports

Include the app version and relevant environment, what you did, what you expected, and what happened. Add the provider/model when relevant and a minimal example, screenshot, or redacted error if possible. Note whether the problem repeats and any workaround you found. You do not need to know the root cause.

Do not publish credentials, tokens, private learning records, or private course materials—or use them as test fixtures. Prefer synthetic or shareable examples.

## Review and credit

Maintainers decide project direction and what is accepted. Review may lead to revisions, narrower scope, further discussion, or a decision not to proceed. Passing tests does not, by itself, establish that a proposed behavior belongs in the product.

Where suitable, we build on contributors’ implementations and work through revisions with their authors. We may integrate a contribution with finishing changes while preserving authorship and appropriate credit; adopting part of a PR is not acceptance of the whole proposal.

A PR does not guarantee acceptance or inclusion in a particular release. Integration and publication are separate; consult School's [tracking issues](https://github.com/bdf1992/school/issues) and [releases](https://github.com/bdf1992/school/releases) for current status.

School retains LearnHarness's [AGPL-3.0-only license](LICENSE) and original contributor credit.

