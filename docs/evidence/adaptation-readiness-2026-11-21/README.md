# School adaptation-readiness observations — 2026-11-21

These observations accompany the [public School readiness note](../../school-adaptation-readiness.md). They cover existing School source at `a64ab5c277f98b0408f5e1ab69f71e3fda91deaa`; they are not training or adoption receipts.

| Check | Observed result | Retained evidence |
| --- | --- | --- |
| Existing deterministic tests | 57 enumerated; 56 passed; 0 failed; 1 skipped | [Invocation](core-baseline.json), [raw TAP](core-baseline.tap) |
| Independent exact arithmetic | 1,419 matching keys; 1,419 deliberate mutations rejected; 0 failures | [Result](independent-oracle.json), [commands](oracle-commands.json), [stdout](oracle-2.log) |
| Provider-dependent suites | Five files blocked while loading missing `@earendil-works/pi-ai`; assertions did not run | [Invocation](provider-baseline-dependencies.json), [raw TAP](provider-baseline-dependencies.tap) |
| Earlier provider attempt | Missing partial-snapshot source and dependencies, retained before restoration | [Invocation](provider-baseline-blocked.json), [raw TAP](provider-baseline-blocked.tap) |
| External Foundation integration | Skipped because `SCHOOL_FOUNDATION_V020` was absent | [Core TAP](core-baseline.tap) |

The [summary](readiness-summary.json) retains the environment and limits. The [restored files](restored-files.json) and [tested-source hashes](tested-source-hashes.json) identify the exact relevant source. The [integrity manifest](manifest.json) records all 12 raw-file sizes and SHA-256 hashes; it excludes itself and this explanatory index.

## Reproduction and limits

The original snapshot was partial. Relevant unchanged files were restored from the pinned School commit and their Git blob identities verified. Tests reused tsx 4.23.12 with Node 24.22.3 and Python 3.12.14; School CI specifies Node 26. There was no clean lockfile installation, full-app typecheck, lint, build or release qualification.

From a complete checkout at the pinned commit with its dependencies installed:

```sh
NODE_ENV=test node --import tsx --test --test-reporter=tap \
  tests/school-classes.test.ts \
  tests/school-experiment.test.ts \
  tests/school-parity.test.ts \
  tests/school-learner-view.test.ts \
  tests/school-state-space.test.ts

node --import tsx docs/evidence/school-oracle-input.mjs NEW_INPUT.json
python3 docs/evidence/school-oracle-check.py NEW_INPUT.json NEW_RESULT.json
```

Original absolute commands remain in the receipts. The 463,193-byte generated arithmetic input is reproducible from pinned source and has its hash in the manifest; it is not duplicated here. Its 129 batches are generated seeds 1–128 plus the checked-in seed-19 fixture, which overlaps one generated population. They are not 129 independent samples of model capability.

No model generation, neural training, adapter loading, adoption or learning gain was observed. These checks support reuse of deterministic measurement machinery within the stated bounds.
