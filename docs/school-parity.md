# Check a parity-machine artifact

The parity checker is the first data-only constructive proof for [issue #8](https://github.com/bdf1992/school/issues/8). It accepts a finite-state machine, validates its structure, and executes that machine on every eight-bit input. An independent oracle counts one bits. The report retains all outcomes and the first counterexample.

This interface checks a supplied artifact. It does not call a learner, establish who generated the artifact, update a world, or connect an artifact to a class, participant state, or AUM successor. The broader issue remains open.

## Artifact contract

Supply a UTF-8 JSON file of at most 64 KiB with this versioned shape:

```json
{
  "version": 1,
  "kind": "parity-machine",
  "alphabet": ["0", "1"],
  "initial": "even",
  "states": [
    { "id": "even", "output": "EVEN", "transitions": { "0": "even", "1": "odd" } },
    { "id": "odd", "output": "ODD", "transitions": { "0": "odd", "1": "even" } }
  ]
}
```

There must be 1–64 states with unique IDs. IDs begin with a letter and contain at most 64 letters, digits, underscores or hyphens. Every state has an `EVEN` or `ODD` output and exactly two transitions, one for each symbol. The initial state and all transition targets must exist. Unknown and missing fields are rejected. Unreachable states are permitted; state names themselves have no meaning.

The machine starts at `initial`, consumes the input from left to right, and reports the final state's output. Empty input reports the initial state's output. The artifact is data: no JavaScript, generated program, file access, tool call or arbitrary expression is executed.

## Run the proof

Use the supported Node runtime and installed project dependencies:

```sh
npm run school:parity -- check examples/school/parity-machine.json --output /absolute/new-parity-report.json
```

The output path must be new and its parent directory must exist. The CLI opens it exclusively with owner-only file permissions where supported; it never overwrites an existing report. Omitting `--output` prints the entire report to stdout.

The supplied correct machine should pass **256/256 byte inputs and 16/16 additional strings**. Byte inputs are exactly eight bits, including leading zeroes, in numeric order from `00000000` to `11111111`. The supplemental inputs are part of evaluator `parity-count-v1` and are copied into each report: the empty string, `0`, `1`, `00`, `01`, `10`, `11`, `000`, `101`, `111`, nine zeroes, a one followed by eight zeroes, nine ones, eight repetitions of `10`, 31 ones and 32 ones. These are finite observations; passing them does not establish equivalence for every possible string.

Run the one-edge mutation as a negative control:

```sh
npm run school:parity -- check examples/school/parity-machine-mutated.json --output /absolute/new-mutated-report.json
```

**This command is expected to exit 1.** The mutated transition is `even --1--> even`, where the correct example uses `even --1--> odd`. The artifact still passes structural validation. It fails **128 of the 256 byte cases**, with first counterexample `00000001`: the oracle expects `ODD`, while the machine returns `EVEN`. The report retains the failed supplemental cases as well.

## Read the evidence

The report separates three outcomes:

| Status | Meaning |
| --- | --- |
| `INVALID` | UTF-8, JSON, size, or structural admission failed. Evaluation is absent, not a zero score. |
| `FAILED` | The structure was admitted and every declared case ran, but behavior disagreed with the oracle. |
| `PASSED` | The structure was admitted and every declared case agreed with the oracle. |

Encoding, JSON and structural checks each report `VALID`, `INVALID` or `NOT_CHECKED`. Admitted artifacts retain their normalized definition, raw-file SHA-256, and a separate SHA-256 over the normalized definition. Key order and insignificant whitespace do not affect the normalized digest; state-array order remains part of that identity. These hashes bind content, not semantic equivalence or authorship. For oversized files the checker reads at most 65,537 bytes, marks the read incomplete, and does not claim a full-file digest.

Each case includes the exact input, expected and actual labels, final machine state and correctness. The report records `modelGeneration: NOT_ESTABLISHED` and `equivalenceForAllStrings: NOT_ESTABLISHED`. It makes no learning, generalization or weight-update claim.

The examples are deterministic controls. To evaluate an actual learner, save its raw reply separately, extract the declared JSON artifact without repairing it, and run the same checker. Retain malformed outputs and failing machines as outcomes. Do not show the correct control to a learner while claiming that the construction was unaided.

## Verification boundary and next proof

Focused tests cover every byte, an independent XOR-folding check of the count oracle, a structurally valid wrong edge, labels and total transitions, explicit bounds, immutable normalized definitions, raw hashes, invalid encoding/JSON, failure exit status, and refusal to overwrite evidence:

```sh
node --import tsx --test tests/school-parity.test.ts
```

A separate Python witness imports no School implementation. It interprets the
retained machines independently, derives expected parity with integer bit counts,
and checks every reported case, content identity, total and counterexample:

```sh
python docs/evidence/school-parity-check.py examples/school/parity-machine.json /absolute/new-parity-report.json examples/school/parity-machine-mutated.json /absolute/new-mutated-report.json /absolute/new-independent-summary.json
```

The final summary path must be new. The retained [proof record](evidence/school-qwen-proofs-2026-11-09.json)
describes the exact verification scope and distinguishes authored controls from model output.

The next issue #8 work is the admitted observation/action case with one withheld bit, actor-specific views and transition receipts. Teacher-selected diagnostics, separately attributable learner trials, and AUM successor continuation also remain outside this checker. This artifact boundary supplies the evaluator those later trials can use.
