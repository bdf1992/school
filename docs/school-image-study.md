# Check image representations from AUM

This is the first offline School evaluator for Bdo's ImageNet/Open Images study,
authorized in the 2026-11-22 conversation. AUM retains the source material,
annotations and conversion history. School independently computes the numerical
answers from supplied raster bytes and compares them with an already saved
candidate response. It imports no AUM implementation and makes no model calls.

The contribution follows the constructive-artifact boundary in
[School's intent](school-intent.md#learning-to-generate-structures) and
[issue #1](https://github.com/bdf1992/school/issues/1). This checker is separate from
class admission, participant inference, training and adoption. The intended wider
study includes local-model descriptions and cross-representation tasks; those
capabilities need their own actual-run evidence.

## Run the authored control

Use the project's Node 26 runtime. The command uses built-in TypeScript stripping
and Node modules only; it does not need a model server or additional libraries.

```sh
npm run school:image-study -- view examples/school/image-study-packet.json --output /absolute/new-learner-view.json
npm run school:image-study -- check examples/school/image-study-packet.json examples/school/image-study-answers.json --output /absolute/new-assessment.json
```

Output paths must be new, with an existing parent directory. Outputs are opened
exclusively with owner-only permissions where supported. Without `--output`, the
whole result is printed. An invalid input or a wrong admitted answer exits 1.

The example is an **authored 3×2 RGB8 control**, not a downloaded photograph or a
model response. Its ten tasks include the first and last partial-word addresses,
a box's excluded right boundary, binary mask membership, point membership and two
conversion comparisons. The second comparison changes two channels by 1 and 255,
so its expected total absolute error is 256. Changing a correct candidate bit
from 1 to 0 causes a failed case with both values retained.

## AUM packet contract

The input packet has exactly these top-level fields:

```text
schema:       "aum.image-study-evaluation/1"
specimen_id:  nonempty string
raster:       RGB8 raster
regions:      region records
conversions:  { id, raster } records
tasks:        task records
```

An RGB8 raster has `width`, `height`, `layout: "RGB8-row-major"`, `data_base64`
and `sha256`. The channel order is red, green, blue; every channel occupies one
byte; rows have no padding. Data must be canonical base64 of exactly
`width × height × 3` bytes. SHA-256 is lowercase hexadecimal over the decoded
payload. School verifies each raster and mask before assessing any answer.

Every region has an `id`, `label` and `kind`:

| Kind | Additional fields | What membership means |
|---|---|---|
| `box` | `box: [x0, y0, x1, y1]` | The coordinate is inside a nonempty integer rectangle, including the lower edges and excluding the upper edges. |
| `mask` | `data_base64`, `sha256` | The row-major byte at that pixel is 1. The mask has exactly `width × height` bytes, each 0 or 1. |
| `point` | `x`, `y` | The queried coordinate equals the annotated point. |

The meaning of a box is `inside_box`, a mask is `inside_mask`, and a point is
`annotated_point`. These are memberships in the supplied annotation, not an
independent assertion that those pixels depict the named object. In particular,
pixels inside a bounding rectangle can include background.

Tasks have unique IDs and one of these shapes:

| Kind | Task fields | Required answer value |
|---|---|---|
| `pixel-bit` | `x`, `y`, `channel` (0–2), `bit` (0–7, least significant bit is 0) | `{ byte_offset, byte_value, bit_value, word64_index, byte_in_word }` |
| `region-membership` | `region_id`, `x`, `y` | `{ selected, meaning }` |
| `conversion-metrics` | `conversion_id` | `{ exact, changed_channels, max_abs_error, sum_abs_error }` |

Byte and 64-bit-word addresses refer to the **decoded RGB8 array**. A word index
groups consecutive eight-byte blocks, including a possible partial final block;
it does not interpret a potentially unsafe 64-bit JSON number or assert a direct
pixel address in compressed JPEG bytes. Values remain safe integers and booleans.

Conversion comparisons require the same dimensions and RGB8 layout. School
compares every corresponding channel. `exact` means the supplied raster arrays
are equal. It does not mean original compressed files are equal, that the
claimed codec was actually executed, or that an image is perceptually similar.
The AUM conversion receipt and its source evidence establish the performed
operation separately.

Bounds: 16 MiB of packet JSON, 4 MiB per raster, 128 regions, eight conversions,
256 tasks, and 256 KiB of answer JSON. Unknown fields, unsafe/nonintegral numbers,
out-of-bounds coordinates, unsupported kinds/layouts, duplicate IDs, unknown
references, wrong payload lengths or digests, and nonbinary masks are refused.
This is deliberately a per-specimen evaluator.

## Candidate answers and exposure

Save the candidate response as a separate file:

```json
{
  "schema": "school.image-study-answers/1",
  "specimen_id": "authored-rgb8-control",
  "answers": [
    {
      "task_id": "first-bit",
      "value": {
        "byte_offset": 1,
        "byte_value": 128,
        "bit_value": 1,
        "word64_index": 0,
        "byte_in_word": 1
      }
    }
  ]
}
```

That excerpt illustrates one answer; assessment requires exactly one answer for
every declared task. Missing, duplicate or extra answers are invalid coverage,
not silently ignored work. Structurally valid wrong answers produce `FAILED`
with every expected/actual comparison retained.

`view` returns a `school.image-study-view/1` object containing the admitted
rasters, regions, conversions, tasks and declared bit numbering. It contains no
computed answers, grade or evaluator receipt. The supplied region labels are
visible: these are deterministic addressing tasks, not hidden-label semantic
tests. The view is a data projection, not filesystem isolation; a later real
School episode must enforce its participant's access separately and retain the
actual exposure. Do not give a learner this full packet for a task that claims
its labels or conversion target were withheld.

## Evidence and replay

The first connected AUM run ingested three real Open Images photographs and used
the fish specimen for six numerical tasks. This evaluator passed all six saved
deterministic answers, then rejected a candidate with exactly one flipped bit
(five passed, one failed). The source identities, complete comparisons and
reproduction command are retained in
[AUM's image study](https://github.com/bdf1992/aum-foundation/blob/codex/image-representation-study/packages/dataspace/evidence/image-study/README.md).
This is a real-image numerical integration control, not a model learning result.

The current contribution's selected seven test files passed 122 tests through
`node --import tsx --test`, and TypeScript typecheck passed. The standard PR
wrapper's `tsx` launcher was blocked by an IPC-pipe `EPERM` before running tests.
The available runtime was Node 24.22.3; the project's Node 26 release environment
was not qualified in this run.

A successful assessment records:

- The exact packet-file and answer-file SHA-256 values.
- The raster identity and the evaluator's own source fingerprint.
- Every task's independently computed expected value, actual answer and result.
- `model_calls: 0`, `learning: "NOT_ESTABLISHED"`, and
  `annotation_truth: "NOT_CHECKED"`.

Repeated checks of the same inputs and evaluator produce the same report, without
new inference. `INVALID` keeps absent coverage distinct from an admitted wrong
answer. No candidate is adopted or credited to a participant merely by passing.

To connect a local model later, use an admitted School participant/connection,
supply only its permitted view, preserve its raw response before extracting the
declared answer artifact without repairing it, and pass that artifact to this
same evaluator. Description-to-image retrieval, generated images, and semantic
descriptions require separate task-specific checks; these numerical grades must
not be presented as evidence for those capabilities.

The current packet and evaluator do not grade inferred depth, surface normals,
specular or material maps, or the accuracy of reconstructed 3D positions. Future
geometry tasks must declare the coordinate frame, camera and projection
assumptions, and scale and units, then assess the resulting geometry against
independent evidence. A passing pixel, bit or conversion task does not establish
accuracy of those inferred quantities.

## Verification

```sh
node --test tests/school-image-study.test.ts
python scripts/pr_tests.py --base origin/main
```

The focused checks cover a valid packet, an incorrect bit, box/mask/point meaning,
corrupt or malformed material, invalid types and references, missing/duplicate
answers, restricted view shape, replay identities and refusal to overwrite
evidence. The project PR runner requires its normal `tsx` installation. The
direct command also works with the Node 24 type-stripping runtime used for the
initial isolated development checks; this does not replace the supported
Node 26 release qualification.
