# Context, caching, and costs

Click the context/cost row beneath the composer to open **Session stats**. The context measurement, cache-hit rate, and dollar estimate answer different questions; none is a provider invoice or a guarantee about the next request.

## Conversation meter

The numerator is the latest qualifying completed conversation response's native Pi **input + output + cache read + cache write** tokens. Reasoning is already included in output. Partial updates, errors, aborts, invalid counts, and all-zero usage do not replace the last measurement. Summarizer usage never supplies this meter.

The denominator follows the selected model's catalog limit. Custom models use their pinned/reported/fallback budget. Claude Code instead uses a valid CLI-reported effective budget for this session's matching model, which may be lower because of CLI auto-compaction. Missing limits remain unknown, not invented.

Changing models keeps the numerator but does not borrow another model's CLI budget. Successful compaction invalidates earlier measurements: `? / maximum` remains until a new qualifying response; CLI budget metadata is invalidated too.

### Observed cache-hit rate

Expanded Session stats shows **Cache hit rate** only after positive cache reads are recorded and inputs are valid. It is a session-wide, prompt-token-weighted ratio, not an average of per-call percentages:

```text
sum(cache read) / sum(fresh input + cache read + cache write)
```

Output is excluded; one-hour writes are a subset of writes and are not counted twice. Missing cache counts mean no recorded reuse, not proven misses. This describes observed usage, not cache warmth, future hits, savings, or retention duration. See [`sessionCacheHitRate`](../src/core/prices.ts).

## Prompt-cache retention

Under **Settings → Agent → Models → Show advanced settings**, each Strong/Cheap/Vision slot has a **Cache** dropdown. Hiding advanced settings does not reset it.

| Choice | Request behavior |
| --- | --- |
| Pi default | Leave `cacheRetention` unset, preserving Pi behavior, including `PI_CACHE_RETENTION=long` where honored. |
| Don’t request caching | Pass Pi's `none` preference; providers may still cache automatically. |
| Short retention | Pass Pi's `short` preference. |
| Long retention | Pass Pi's `long` preference; cache writes may cost more. |

These are **provider-dependent preferences**, not fixed-duration or cache-hit promises. Some adapters ignore them, subscription transports may omit them, and custom endpoints may reject unsupported parameters. LearnHarness does not retry with a different preference.

Sessions inherit Strong's retention preference while keeping their own model choices. Background roles inherit their assigned slot's preference, even with a model override; summarization uses the conversation preference. Changes apply at the next model request, including an existing loop, without altering an in-flight call or issuing warm-up calls. Explicit choices override Pi's retention environment preference; Pi default removes the explicit choice.

For supported Anthropic routes, Short/Long map to five minutes/one hour, with cache writes costing 1.25×/2× ordinary input; reads use discounted cache-read pricing. Longer retention can help across pauses but cost more for a single call or short job. Other providers differ. Consult [Anthropic caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching) for current mappings/prices.

## Spending

The server uses Pi AI's catalog and public `calculateCost`; the browser receives derived estimates, not a separate rate table. Catalog updates can reprice history without mutating saved usage.

| Route | Meaning |
| --- | --- |
| API providers | Dollar estimates when catalog model and required usage detail are available. |
| Built-in subscription connections | Labelled plan usage through explicit logical provider IDs, not API dollars. |
| [Claude Code](claude-code.md) | CLI tokens retained; dollar costs unpriced. CLI result-line dollar totals are not imported; routing/billing belongs to the CLI. |
| [Custom/local endpoints](custom-providers.md) | Tokens retained; unknown/unpriced costs, not $0. No rate editor. |

Mixed sessions sum known API estimates and retain subscription/CLI labels. Unpriced turns remain unpriced, not free. Summarizer spending counts under the same rules but does not populate the conversation meter.

Saved input counts are Pi-normalized **fresh input**, disjoint from cache buckets; do not subtract cached reads again. Old records missing a cache-write retention split, or tier-priced multi-call jobs missing per-call detail, stay unpriced where that detail could change the result. They are not reconstructed from aggregates. Flat-rate historical jobs can remain priceable with sufficient counts.

## Compaction and maintainer references

Compaction summarizes older context for future requests; original messages remain stored. The next-request estimate is separate from the displayed last-call measurement: it anchors on reported usage, estimates later messages, and falls back to active-transcript/system-prompt heuristics. The trigger is the smaller of the configured threshold and catalog window minus reserve. The reserve is a quarter of the window, capped at 16,384 tokens, or the configured output allowance if larger. Catalog output maxima that consume the entire window are clamped to that reserve on the actual request. Unknown catalog windows use the configured threshold alone; CLI display metadata does not change that trigger.

With a 4,096-token output allowance and the default threshold, the triggers are 4,096 for an 8,192 window, 12,288 for 16,384, 24,576 for 32,768, and 49,152 for 65,536. A trigger is an app budget, not evidence that a model server allocated that window.

[`src/core/compaction.ts`](../src/core/compaction.ts) ports cutoff selection and sizing heuristics from **@earendil-works/pi-coding-agent 1.4.0**, without a coding-agent dependency. The retained-tail target is at most **20,000 tokens** and at most half the input space remaining after system instructions and pending input. Summary output is at most a quarter of that remaining space, capped at 4,096 tokens and the model's output limit. The bounded walk advances only across complete exchange boundaries; it will not drop an unanswered call or leave an orphaned result to meet a size target. Text/thinking/tool names/arguments use characters ÷ 4; images get a fixed 1,200-token allowance. These remain estimates, not backend tokenization or a proof of GPU capacity; encrypted signatures are not measured or stripped.

LearnHarness retains its own educational summary prompt, plan continuity, scheduling, authorization, and persistence. A cut dropping no history does not summarize. Requests include the latest summary once, then the retained transcript; later summaries receive the prior summary once plus newly superseded material. Large imported histories are summarized in bounded chunks on the session's own model, carrying the accumulated summary forward. Every character of the serialized source reaches a chunk; the existing 2,000-character tool-result summary truncation remains labelled, and full results remain stored. A single compaction permits at most 64 summary calls. Oversized plans, retained exchanges, and summary output fail explicitly without committing a partial checkpoint. Output-limit (`length`) summaries likewise fail.

Before a new turn, School rejects an incoming message that cannot fit by itself before making any model call. It then accounts for pending input during compaction and checks the actual constructed system/tool declarations before dispatch. Every subsequent conversation operation is guarded too, so tool-loop growth cannot silently send a known estimated overflow. Custom engines resolve their current context and output limits for each operation, including after settings change during a running agent loop. A refusal keeps the stored transcript and asks the user to shorten the input or select a larger verified context. This is an application estimate guard; model-specific tokenization and the engine's active allocation still require separate measurement.

School rereads the record after a summary completes. It preserves concurrent dismissals, new observations, and artifact display preferences. A committed marker stays at the end of the original snapshot, before later appended actions, so a dismissal keeps its delivery pause. If the original message order, summarized source, prior checkpoint, or summarized plan changed, School discards that summary instead of overwriting newer history. These checks protect the current synchronous, single-process store; they are not a cross-process transaction.

The compaction slot is claimed before the summary or its status callbacks run. Simultaneous turn-start callers wait for the active compaction even if they cannot start new background work. A trailing compaction marker is neutral for dismissal and question-recovery pauses; a later real input can clear those pauses.

Completed empty, stale, or oversized summaries retain their usage with `compaction.outcome: "discarded"` and a reason. If a later chunk fails, completed earlier chunks remain accounted with `summary-failed`; none becomes a partial transcript checkpoint. Their attempt ID has no committed transcript marker. They still contribute to session spending; they create no compaction divider and do not invalidate the conversation meter. Successful summaries carry `outcome: "committed"`. Deleting a session removes its accounting as well, and a late summary cannot recreate it. Provider failures that return no usage and storage failures remain unqualified accounting paths.

Implementation: [`server/compaction.ts`](../src/server/compaction.ts), [`context-usage.ts`](../src/core/context-usage.ts), [`server/pricing.ts`](../src/server/pricing.ts). Regressions: `compaction-native-parity`, `context-usage`, `pricing-native-parity`, `subscription-usage`, and `session-cache-hit-rate` under `tests/`, plus CLI/custom-provider suites.

## Upstream attribution

The cutoff/estimator port adapts MIT-licensed code from
`@earendil-works/pi-coding-agent` 1.4.0, author Mario Zechner (published package
metadata). The inspected `dist/core/compaction/compaction.js` SHA-256 is
`f51e78ef1da66b5803fc91e185f07b968f8f989ab9326b7744958416aad3f6f6`.

MIT License

Copyright (c) Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
