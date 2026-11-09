# Inspect a local model connection before a pilot

`school:preflight` reads an existing participant state and asks its exact named
OpenAI-compatible endpoint for `GET /models`. It makes **no generation calls**,
registers nothing, and does not consult global custom-provider or hosted-account
settings. Use it before the first supervised School episode.

Register the identity, connection and state using [the participant guide](school-participants.md).
Then provide the exact participant ID, state revision, School root and a new
receipt filename outside that data root. The output's parent directory must exist:

```sh
npm run school:preflight -- --participant local-learner --state base \
  --school /absolute/school-root --output /absolute/evidence/qwen-preflight-01.json
```

On Windows the same flags accept Windows paths. This command neither installs nor
starts Qwen. The registered model ID must match the server's advertisement exactly;
there is no case-folding, guessed model name, or fallback. `baseUrl` is the API base
ending, for example, in `/v1`; the request appends `/models`.

## What the receipt establishes

Exit 0 and `outcome: "PASSED"` mean that a valid, bounded advertisement contained
the exact registered model ID and the immutable binding remained valid through
the response. This does not establish generation compatibility, available GPU
memory, actual context limits, sampling settings, server reasoning mode, loaded
weights, or learning. The receipt always retains `loadedArtifact: "NOT_ATTESTED"`
and `inference: "NOT_PERFORMED"`.

The receipt includes the host name, OS platform, architecture, Node version,
participant/state/connection hashes, declared endpoint capabilities, selected
model ID, request timing, HTTP status, byte count, and advertisement counts.
`request.attempted` records calling the HTTP transport; it does not prove that
the server received the request. A response status records an observed response.
These are observed host facts, owner declarations, and server advertisement facts
respectively; they are not interchangeable.

`observation` concerns the model advertisement:

- `ABSENT`: no usable advertisement response was observed, including admission or
  connection failures before a response.
- `INSUFFICIENT`: a response was observed but could not support the required
  conclusion, including malformed/oversized data or a revoked binding.
- `SUFFICIENT`: a valid advertisement was read under the unchanged binding. It
  can still produce `FAILED` because the exact selected model is absent.

Missing or revoked states, unavailable dedicated credentials, and configured
hosted connections return `REFUSED`. Known HTTP, advertisement and transport
failures return `FAILED`. Both exit nonzero and retain a failure receipt.

## Bounds, credentials and interruption

There is one request, no retry, a **5,000 ms** default deadline covering headers
and body, and a **1 MiB** response-body limit. `--timeout-ms` accepts integers
from 1 through 60,000. Redirects are refused without visiting their destination.
Keyless endpoints receive `Bearer not-needed`, as School's named generation route
does. Authenticated endpoints read only their dedicated
`SCHOOL_CONNECTION_<ID>_<REVISION>_API_KEY` variable. No credential values,
memory text, other advertised model IDs, raw response bodies, redirect locations,
or untrusted exception text enter the receipt.

The command exclusively creates an owner-only output file and writes a `PENDING`
receipt before resolving the state or sending HTTP. An existing file refuses
before dispatch. Ordinary completed success and failure receipts are file-synced.
If the process is interrupted, an incomplete or `PENDING` file remains evidence
of unfinished work; it is not a success. Reusing its filename does not retry.
Inspect it and choose a new receipt filename for an explicit later preflight.
This bounded write protocol does not claim power-loss durability or atomic final
replacement. Windows filesystem behavior still needs target-host qualification.

Once preflight passes, run one [class-bound queued episode](school-runs.md) and
check actual learner and teacher replies. The ordinary factorized experiment
requests 512 output tokens per call, allows 30 seconds per call and uses 17 calls.
School's `thinkingLevel: "off"` does not necessarily disable server reasoning;
record the actual server settings before interpreting truncation as a task failure.

## Verification

```sh
node --import tsx --test tests/school-preflight.test.ts
```

The tests use owned loopback HTTP servers. They check exact model selection,
credential scope, redirect refusal, revocation during a request, missing state,
body/deadline bounds, safe error receipts, and output-conflict refusal before
dispatch. These are protocol checks, not a Qwen qualification.
