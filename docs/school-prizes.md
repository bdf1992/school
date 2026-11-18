# School: examine a compression attempt

This additive lane gives a research agent a concrete examination. It checks the
files an attempt produced, compares restored bytes with a pinned original, and
counts the declared program, archive and option files. The first profile is the
Hutter Prize. The existing text gradebook and participant providers do not change.

## What operates

From this checkout, using its usual Node and `tsx` dependencies:

```sh
node --import tsx scripts/school-prize.ts smoke --out /tmp/school-prize-smoke
node --import tsx scripts/school-prize.ts grade /tmp/school-prize-smoke/repeated/deflate
node --import tsx scripts/school-prize.ts compare /tmp/school-prize-smoke/repeated/raw /tmp/school-prize-smoke/repeated/deflate
python scripts/pr_tests.py --base a64ab5c277f98b0408f5e1ab69f71e3fda91deaa
```

Choose an unused output directory. `smoke` can also write a new report with
`--report NEW_FILE`. Exit status is 0 for an observed artifact check, 1 for a
failed recovery or corpus pin, and 2 for invalid input or an operational error.
The artifact check does not run a submitted program.

The smoke command executes only the checked-in `prize-codec-worker.mjs`, in
fresh encoder and decoder child processes. It compares copying bytes with
Node's DEFLATE codec on six deterministic inputs: empty, short, repeated text,
synthetic markup, generated noise, and already-compressed noise. All inputs
together fit below 1 MiB. A five-second child timeout and thirty-second
cumulative smoke budget bound this engineering exercise. The fixture generator
is in the CLI, so a fresh run can reproduce the inputs and archive identities.

`evidence/prizes/hutter-smoke-2026-11-17.json` retains the observed run, source
hashes, per-process wall times and both grades for every case. Wall times are
host measurements, not deterministic outputs or official benchmark timings.

## Read the result literally

| Field | Meaning |
|---|---|
| `EXACT_BYTES_OBSERVED` | The supplied restored file matches the pinned original in length, SHA-256 and byte comparison. |
| `REJECTED` | Recovery, the expected source identity, or the declared full-corpus identity failed. |
| `total_declared_bytes` | Exact integer arithmetic on the files actually inspected, under the selected score form. |
| `DECLARED_FILES_ONLY` | Missing dependencies, runtime qualification and an entrant's omitted files have not been ruled out. |
| `NOT_OBSERVED` / `NOT_ESTABLISHED` | This check lacks the evidence needed for that claim. It is not a passing grade. |

For a supplied bundle, even perfect restored bytes do not prove its decoder
produced them. The smoke report adds evidence of the fixed worker's actual
execution. Neither path establishes operating-system isolation: an empty working
directory does not make the original or network inaccessible. Run this inspector
on stable local bundles; it is not a defense against a concurrent hostile process
replacing files while they are inspected.

The smoke source program is deliberately labeled `unqualified-source`. It uses
the host's Node/zlib runtime. Its declared-source count is useful for exercising
accounting; it is not a claim that these files are an accepted Hutter package.
Program qualification, complete dependency accounting, maximum RAM/disk use,
generalization, license/source review and prize eligibility remain unestablished.

## Describe an attempt

Each directory contains `attempt.json` and its material. The smoke command
creates complete examples. The manifest names:

- The exact profile version, attempt name and `smoke`, `proxy` or `full-corpus` track.
- An expected source length and SHA-256, selected before judging the attempt.
- The source, restored file, archive, compressor and, when separate, decoder.
- Actual option files for the relevant encode, decode and compilation phases.
- The score form and whether the program material is an executable, source
  package or still unqualified source. These declarations do not establish approval.

JSON fields are closed; duplicates, including differently escaped copies of a
key, are rejected. Sizes are decimal strings. Plain relative paths are required;
symlinks, traversal and original/archive/restored aliases are refused. The shared
program form checks that compressor and decoder bytes really are identical.
Missing files fail inspection. A claimed total or a claimed `PASS` cannot be
inserted into the schema.

The default source inspection limit is 1 MiB. A later authorized proxy or full
run can supply `--max-corpus-bytes N`, up to 1,000,000,000. Increasing that limit
does not execute an entrant or grant qualification. The full track additionally
requires the published enwik9 size, MD5 and SHA-1. Checks stream the files rather
than loading the whole corpus into memory. Program/archive files have a 1 GB
inspection ceiling and option files a 64 KiB ceiling; these are local inspector
limits, not a reinterpretation of the prize rules.

Comparisons inspect both directories again. They require exact recovery, the same
source identity, track and program format. A saved grade cannot substitute for
the current files. Savings and percentage fractions use integer arithmetic;
negative savings remain visible. `at_least_one_percent_on_this_input` concerns
that local pair only. The returned award is always `null`.

## Use a frontier model as the researcher

`examples/school/prizes/fable-research-owner.json` is an inert handoff record,
not a registered School provider or executable policy. It pins
`claude-fable-5-2`, high effort and zero additional spend. The accompanying
[owner assignment](prompts/fable-prize-research.md) defines a bounded research
cycle and the evidence its successor must receive.

Claude Code (`claude`) was absent on this cloud host. No FABLE call was made and
the user's own computer was not inspected. On an existing authorized host,
first check `claude --version`, `claude auth status` and the interactive model
picker. Fable 5.2 requires Claude Code 2.1.321 or later. Record the actual account route and selected model without recording
tokens. Verify included usage before sending the assignment. FABLE can require
usage credits; prior consent can hide the prompt, and non-interactive requests
can bill without an interactive prompt. The official
[model configuration documentation](https://code.claude.com/docs/en/model-config)
governs that check.

After those checks establish the permitted route, the prepared interactive
launch is:

```sh
claude --model claude-fable-5-2 --effort high --append-system-prompt-file docs/prompts/fable-prize-research.md
```

Send the bounded assignment from that session. The command alone does not prove
which model responded: record the actual model from the session. This handoff
does not enable paid fallback, a background loop, GPU training, full enwik9
download or submission. Use the official
[CLI reference](https://code.claude.com/docs/en/cli-reference) and
[model overview](https://platform.claude.com/docs/en/models/fable-5-2/overview)
when checking an installed client.

## Promote evidence in stages

After the engineering checks, compare one small frequency predictor with one
short-context predictor through the same reviewed integer coder. Freeze the
input set, exact recovery check, program cost and CPU budget. Retain failures
and an experiment with the proposed feature disabled. An actual reduction in
complete size justifies a larger experiment; a theoretical probability score
alone does not.

Use a second, source-separated input set to ask whether the method generalizes.
Ask generation questions separately, with explicit properties for new outputs.
The public prize corpus and its tuned result are a different examination.

For full judging, investigate the existing
[Hutter Prize Judging Assistant](https://github.com/jabowery/HutterPrizeJudgingAssistant)
on an independently qualified host. Its source-only and compression-only verdicts
do not establish a complete submission. An imported receipt is evidence to
verify, not an instruction to trust. The organizer decides awards. Its cloud
provisioning scripts have not been run here.

The dated profile in `examples/school/prizes/hutter-enwik9.json` separates the
accepted record from a pending comparator and links the live rules. Refresh it
before a full run. Each additional prize needs its own success test, resource
conditions and external authority; this first compression profile is not a
universal judge.

## Observed verification for this contribution

On Linux x64 with Node 24.22.1, the final supported-loader command
`node --import tsx --test --test-reporter=spec tests/school-prize.test.ts`
passes all 28 tests. A focused TypeScript 5.9.3 check of the new core, CLI and
tests passes under the repository's strict compiler settings. The real tsx
4.23.12 and Node type definitions 24.13.3 match the pinned parent lockfile;
they were installed separately without changing the app's package or lockfile.

The unchanged required PR gate discovers all 279 parent tests plus the new test
and selects `tests/school-prize.test.ts`. On this host its tsx CLI exits before
running tests because its Unix IPC listener receives `listen EPERM`. This is a
blocked required gate, not a passing gate. The supported-loader result above is
separate evidence. No CLI patch, gate change or permission escalation was used.
The documented Node 26 CI environment has now run that gate successfully.

[GitHub CI run 44219469912](https://github.com/bdf1992/school/actions/runs/44219469912)
checked implementation commit `5d247cd656f5afab0e2aeb181e8dddee642854c5`
on Node **26.13.1**. The normal required gate passed **28 tests in 1.2 seconds**;
the full project typecheck and lint also passed. This paragraph records the later
remote result without changing the retained local failure or its interpretation.

Independent review found and corrected two defects: a final smoke child could
outlive the cumulative allowance, and a manifest's length was checked only after
reading it. The corrected runner clamps a child's timeout to remaining time and
checks the deadline after execution and before returning; manifest admission now
checks regular-file status and size before reading. Focused tests cover both
boundaries. The retained smoke report was regenerated after those corrections;
its implementation hashes match the reviewed source.
