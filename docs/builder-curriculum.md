# Builder curriculum: constructing resident agents

**Standing: programme plan, not implemented.** These are School's work packets SCH 01-04 from the builder-agent allocation
([source text](https://github.com/bdf1992/Worldspine/blob/dev/spec/builds/dataspaces-builder-source.md)): the allocation Bdo uploaded on 2026-11-26 (written November 25, 2026, as a proposal), taken up as the working programme plan, plus the first specimen's task material.
Integration entry (ownership, loops, shared exchanges, gates G0-G4):
[Worldspine `spec/builds/dataspaces-builder.md`](https://github.com/bdf1992/Worldspine/blob/dev/spec/builds/dataspaces-builder.md).

School owns the new reusable builder curriculum and its assessment: what the builder must learn, what each
participant may see, and whether the result met the task. Existing Dyno experiments keep their own ownership and
evidence. AUM owns what an agent definition means and any model update ([intent and boundaries](school-intent.md)).

## SCH 01 Construction curriculum and participant exposure

**Deliver:** versioned tasks with public behaviour specifications, prerequisite progression, allowed tools, budgets,
split groups, and separately retained learner, teacher, resident and evaluator views. **Inputs:** AUM 01, DS 02/03,
later native capabilities. **Consumers:** the builder and teacher, each through its permitted projection.

**Acceptance:** equivalent objects and alternate encodings cannot cross training/evaluation splits merely because
IDs differ. Hidden assessment states and expected answers never enter teaching views. Observations carry enough
information for the required decisions, or the task permits an explicit uncertainty response.

## SCH 02 Interactive builder episodes

**Deliver:** a new episode profile: brief, construct, diagnostic execution, feedback, bounded repair, frozen
submission and sealed assessment, with the returned artifact bound to a resident instance. **Inputs:** AUM
definition identity, DS 02, Dyno contender references.

**Acceptance:** every attempt and teacher intervention is retained. Diagnostic repairs stop before final
assessment. The submitted resident executes independently of the builder session. Verification reproduces the
retained grade without another model call; interrupted calls stay distinguishable from completed attempts.

**Start from:** the camera adapter's source pinning and replay ([README, Dataspace camera episodes](../README.md#dataspace-camera-episodes)),
with a new task profile; the camera integration is not itself a construction loop. Starts once DS 02 is callable.

## SCH 03 Independent behaviour grades and comparisons

**Deliver:** the versioned reference checker and assessment policy for construction success, resident behaviour,
preservation, observer effects, hysteresis, predictions and retention. **Inputs:** public task laws, retained
inputs and outputs, world transition evidence. **Consumers:** AUM for adoption, Dyno for comparisons.

**Acceptance:** authored correct, byte-corrupting, observer-confusing and history-forgetting agents yield their
intended distinct results. Expectations are computed independently of the candidate and of its execution
implementation. A runtime's receipt alone never establishes task success. Transfer coverage and regressions stay
explicit.

**Predictions.** A one-step prediction is graded against the observed transition only if it was committed before
the chosen action. Unchosen alternatives are assessed only when the task supplies separately executed reference
branches. An imagined future is retained as a hypothesis with its action and starting frontier, never as a future
fact.

**Rule:** the checker computes expectations from the public law in School's own code, importing nothing from
`packages/dataspace` or from any candidate. It can be packaged for another repository; its semantic owner stays
School, and its independence comes from the computation and evidence, not the repository.

## SCH 04 Training eligibility and untouched assessment

**Deliver:** a field-level export policy and qualified learning-data manifest, plus the parent/candidate comparison
protocol. **Inputs:** builder traces and diagnostics, Dyno E9 or other experiments, AUM's training objective.

**Acceptance:** exported fields have reconstructible provenance and are permitted for that split and objective.
Sealed evaluation fields never enter training. Base, assisted base, saved-memory base and trained/reloaded candidate
stay distinct conditions. Cases used to choose a candidate are separate from the untouched final assessment.
Failed attempts are kept as evidence and their training use is decided explicitly. A reopened resident memory is
not evidence that builder weights learned.

**Known case:** Dyno E9's reply log holds sealed-derived fields ([dyno `docs/BUILDER-MEASUREMENT.md`, DYN 02](https://github.com/bdf1992/dyno/blob/main/docs/BUILDER-MEASUREMENT.md#dyn-02-bounded-campaigns-and-faithful-evidence-export));
its export to training goes through this whitelist.

## The first specimen (v0)

Bdo's allocation fixes the shape: one immutable eight-byte object, explicit mutable resident state, two lossless
representations and named lossy readings, two receiver calibrations, a latch, one typed action, a paired-history
hysteresis check and, later, a prediction committed before the action. The values below are School's proposed v0
task material, chosen so that each authored control fails for exactly one reason. They are revised here, by
version, never silently.

**Subject.** Bytes `41 55 4D 00 7F 80 FE FF` (hex), protected: no resident action may change them. Byte view: the
eight bytes in stored order, index 0-7. Bit view: 64 bits, byte 0 first, most significant bit first within each
byte. Both are lossless. Named lossy readings: `high_nibbles` (eight values 0-15; discards the low nibbles) and
`popcount` (one value 0-64). Structured views carry bytes as integers 0-255 or as a hex string, never as one 64-bit
number.

**World.** Each turn the world emits a signal `s` in 0-255. Receiver condition `c` in 0-3 is addressed world state,
changed only by the world operations `shade` (+1) and `unshade` (-1), clamped. A resident is bound to one receiver:

- calibration A: reading = max(0, s - 32c)
- calibration B: reading = max(0, (255 - s) - 32c)

The reading may be `missing` on a turn; missing is not zero.

**Latch.** In the resident's own explicit memory, initially off: on when reading >= 192, off when reading <= 63,
otherwise unchanged. A missing reading leaves it unchanged.

**Action.** Each turn the resident proposes one typed action `signal(lamp: on|off, byte: 0-255)`. `lamp` is the
latch after this turn's reading. `byte` is the subject byte at index (turn mod 8), read through an exact view. The
world admits the action and records the lamp; the subject stays unchanged.

**Public G0 fixtures (receiver A unless stated, c = 0).** These are published to qualify the checker and the
execution path; they are not a sealed split, and teaching and sealed cases are generated later under SCH 01.

| Case | Signals | Condition ops | Expected lamps |
|---|---|---|---|
| H1 hysteresis high | 220, 128 | none | on, on |
| H2 hysteresis low | 20, 128 | none | off, off |
| C1 condition | 220 | `shade`, `shade` before turn 0 (c = 2, reading 156) | off |
| M1 missing | 220, missing | none | on, on |
| B1 calibration B | 20, 128 | none (readings 235, 127) | on, on |
| R1 readout | 128 eight times | none | off eight times |

H1 and H2 end at the same present signal with different latch states. Every case checks the `byte` value of each
turn it runs (R1 covers all eight indices) and that the subject is byte-identical afterwards.

**Authored controls (no model):**

| Control | Defect | Fails on |
|---|---|---|
| correct | none | nothing |
| byte-corrupting | reports `byte` from `high_nibbles` (value x 16) | every turn whose byte has a non-zero low nibble (indices 0, 1, 2, 4, 6, 7) |
| observer-confusing | applies calibration A whatever receiver it is bound to, ignores `c` | B1, C1 |
| history-forgetting | lamp = reading >= 128 each turn, off when missing, no memory | H2, C1, M1, B1, R1 (each alone); it passes H1 |

Case identity is the SHA-256 of a canonical encoding (law version, receiver, the signal list with `missing` as
`null`, the condition ops in order; canonical JSON with sorted keys), not of an ID, so a renamed copy cannot cross
splits. Two cases are equivalent when the resident view receives the same thing in both (the same signals, receiver and
condition sequence under the same law version), however the case is named or serialized.

**Views.** Builder (learner): public law, interface, budgets, teaching cases with their expected lamps.
Teacher: the learner view plus the learner's attempts and diagnostics. Resident, per turn: the raw signal `s` (or
`missing`), the id of its bound receiver, the current condition `c`, the turn number, its own memory, and read-only
access to the subject through the exact `bytes` and `bits` views and the lossy `high_nibbles` and `popcount`
readings. The resident applies the public calibration law itself; choosing the right receiver and view is part of
the task. Evaluator: everything, including sealed expectations, which no other view receives.

## Where School sits in G0

G0 needs SCH 01 (the v0 task record and views above) and SCH 03 (the checker and the four controls' intended
verdicts). School is G0's task/checker acceptance owner. SCH 02 waits for DS 02; SCH 04 for G3.

## G0 implementation notes

**v0.1** (School, G0 build; code under `src/core/builder/`, CLI `npm run school:builder-check -- <run.json>`,
fixtures `tests/fixtures/builder/*.json`). Nothing in v0 is changed; these are the internal choices the spec left open.

- **Case encoding accepted.** `{receiver: "A"|"B", signals: (0-255 | null | "missing")[], conditionOps | condition_ops:
  ("shade"|"unshade" | {turn, op})[]}`. A plain string op means turn 0. Ops are applied before their turn's reading, in
  list order, and are normalized by a stable sort on turn; an op turn outside the signal list is refused.
- **Identity.** SHA-256 hex of the canonical JSON (sorted keys, no whitespace, UTF-8) of
  `{"condition_ops":[{"op":..,"turn":..}..],"law_version":"builder-v0","receiver":..,"signals":[..null..]}`;
  e.g. `{"condition_ops":[],"law_version":"builder-v0","receiver":"A","signals":[220,null]}` for M1.
- **Splits.** `SplitRegistry` refuses a case whose identity is in another split; re-adding within one split is idempotent.
  `checkDisjoint` lists collisions by identity.
- **Views.** Sealed cases are omitted entirely (not just their expectations) from builder and teacher views; budgets are
  supplied by the task, never defaulted. Resident view keys: signal, receiver, condition, turn, memory, subject.
- **Run record `school.builder-run/0`** (School owns it):
  `{format, law_version: "builder-v0", candidate, runs: [{case, outcome: completed|refused|limit_exhausted|unresolved,
  turns: [{turn, action: {type: "signal", lamp: 0|1, byte}, admitted, recorded_lamp}], subject_after_hex}]}`.
- **Grade `school.builder-grade/0`.** Per run: `{case_id, name?, pass, reasons, failing_turns}`; summary `failing_cases`
  (names, else ids) and `reason_kinds`, sorted; `coverage {ran, missing}` over H1..R1. Reasons: a lamp not recorded as
  proposed counts as `action_not_admitted`; a non-completed outcome is `not_completed`; unreadable turns, cases or fields
  are `malformed`. `qualified` requires no record error, all six fixtures run, and no failing run of any case (an extra
  failing run also disqualifies). Duplicated fixture runs are each graded.
