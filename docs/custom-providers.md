# Custom and local models

LearnHarness supports **one custom OpenAI-compatible endpoint with multiple models**, including a local model server. The setup/UI builds on PR #62 by Daniel Buckner and Abhishek Thakur. Pi handles inference, message conversion, tools, streaming, and reasoning effort. [Claude Code](claude-code.md) is a separate provider.

## Connect

1. Open **Settings → Providers → + Add a provider → Custom endpoint**, or use the first-run provider picker.
2. Enter the complete API base URL, such as `http://localhost:11434/v1`. LearnHarness **does not append `/v1`**. HTTP/HTTPS and private-network addresses are supported; embedded credentials, query strings, fragments, and discovery redirects are rejected.
3. Choose **Keyless** or **API key**. Keyless ignores saved/environment custom keys. API key uses `CUSTOM_OPENAI_API_KEY`; a real environment value overrides a saved value, and the editor identifies environment ownership.
4. Optionally enter model IDs, separated by commas or whitespace, for servers without working model discovery.
5. Click **Connect**, then select Strong, Cheap, and Vision models.

A key is bound to the canonical endpoint URL and authentication mode. Changing the URL requires a new effective key or explicit consent to reuse it; it is never silently forwarded. Clearing authentication selects Keyless. Use this editor—not generic key management—to change custom credentials.

Connect requests `GET <base>/models`; reported metadata wins over duplicate entered IDs. A nonfatal discovery failure can fall back to entered IDs. At the same URL, fallback preserves the previous model snapshot/pins; a different URL starts its own snapshot. **401/403, redirects, response-size, and model-count violations fail even with entered IDs.** A failed connect without fallback leaves configuration unchanged.

Discovery is not a continuous health or capability check. LearnHarness does not install a backend, download models, or perform custom-endpoint OAuth.

## Local Ollama only

For local inference without hosted model calls, enable **Local Ollama only** in
the custom endpoint editor, use **Keyless** and a loopback base URL such as
`http://127.0.0.1:11434/v1`, then click **Connect**. This mode uses native Ollama
metadata rather than the generic `/models` fallback. It excludes cloud aliases
and embedding-only models, including aliases with remote-upstream metadata but
an innocent-looking name.

The model row separates the profile's explicit `num_ctx`, the last observed
loaded context, and the model's advertised native capacity. The profile controls
the application budget; a loaded observation or native maximum cannot silently
enlarge it. A model without explicit `num_ctx` needs a prepared profile before
inference in this mode. [Measure and prepare 16k/32k/64k profiles](local-context.md)
on the computer that has the model and GPU.

Local-only mode is checked before each model operation, including background
roles and explicit School participant connections. It hides other providers
from model selection and refuses their requests rather than falling back.
Existing model selections are preserved: select a local model for Strong/Cheap/
Vision and clear any background-role overrides that still name another provider.
Only assign a model to Vision if its actual weights and runtime support images.
The final inference transport must target the configured loopback endpoint and
verified model, without redirects or forwarded authorization headers.

New hosted search requests and dictation token grants are also blocked while
the mode is enabled. Work already dispatched is not revoked. Existing keys and
other provider configuration are retained. Disconnecting the custom endpoint
preserves the restriction so an outstanding background job cannot switch to a
paid provider. Reconnecting with the checkbox explicitly cleared disables it.

Ollama metadata is evidence from the local server, not an independent attestation
of its executable or resident weights. The optional Windows setup script also
sets `OLLAMA_NO_CLOUD=1` in the Ollama server environment. No cloud/API inference
is used by the context measurement workflow.

## Budgets and reasoning

Edit each model's pins offline:

| Setting | Resolution |
| --- | --- |
| Context budget | User pin → reported limit → **8192 fallback** |
| Maximum output | User pin → reported limit → **4096 fallback** |
| Reasoning support | User declaration → reported support |

Positive integer token pins are accepted, including small output limits; blank removes a pin. The editor labels reported, fallback, and pinned values. **These are request/compaction budgets, not commands to resize the backend's context.** Configure the server separately and match its active limits. Reconnecting prunes pins only to the resulting model IDs.

Reasoning support declares a capability; it does not enable execution. The normal Pi effort picker remains available, but **Off may not disable a backend's default thinking**. There is no model-name inference, Ollama preset, thinking-map/compatibility editor, or nonstandard-header editor.

## Images

All custom models are Vision-selectable; reported image-capable models appear first. Choose a backend that actually understands images.

Every custom-engine image-bearing request attempts delivery even when discovery omitted image support. This includes file reads, PDF pages, and visual previews. A request-local model allowance lets Pi encode images without changing the catalog's capability claims. Text-only servers may reject them; errors surface without silent text-only fallback. Payload delivery tests do not establish real-model image quality.

## Editing, credentials, and recovery

Nonsecret configuration lives in `settings.json.customProvider`; saved keys and an internal binding live in `auth.json`. Authorization requires matching binding IDs, URL, and mode. A crash between auth/settings writes leaves the provider disabled rather than sending a key to a mismatched endpoint. Keyless also needs a valid nonsecret binding but never resolves a key. Missing private storage can initialize; malformed/unreadable storage fails closed without overwrite.

If authorization is interrupted, reload and explicitly reconnect. An environment key changing endpoints does not authorize a shadowed saved key for that new URL. Disconnect prevents a latent environment key from reviving the provider. These are crash/restart guards, not a power-loss/fsync transaction guarantee.

Stale editor saves return **409**: reload and retry. Mutations preserve unrelated settings changes; failed edits do not claim success. Each new model operation resolves current endpoint, credentials, limits, and effort; in-flight requests keep their setup. Disconnecting/removing a model does not remap saved selections or rewrite history.

Discovery limits are **15 seconds**, **8 MiB**, and **10,000 models**; configuration bodies are bounded to **64 KiB**. Desktop capability/same-origin browser checks are not multi-user authentication.

## Pricing and older development configurations

Prices are **unknown/unpriced**, not $0—even for a local server. Internal zero rates are Pi-required placeholders; there is no rate editor. See [accounting](compaction-accounting.md).

The earlier unshipped `models.json` configuration is not read or migrated. Existing early development profiles need explicit endpoint configuration/reconnect and model reselection; files/history are not deleted or silently remapped.

## Maintainer entry points

- [`server/custom-provider.ts`](../src/server/custom-provider.ts): discovery/registration; [`custom-provider-http.ts`](../src/server/custom-provider-http.ts): HTTP revisions and mutation boundaries.
- [`custom-provider-auth.ts`](../src/server/custom-provider-auth.ts) and the [binding contract](../src/core/custom-provider-auth.ts): credential authorization and restart behavior.
- [`agent/models.ts`](../src/agent/models.ts): per-operation engine resolution and image allowance.

`tests/custom-provider-*.test.*` covers fake endpoints, binding/restart failures, concurrent editing, UI, and payload delivery—not backend installation or real-model capabilities.
