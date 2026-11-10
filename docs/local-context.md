# Measure local Ollama context

School's displayed context budget, a model's supported context, and the context allocated by Ollama are separate values. This workflow measures the local runtime before choosing the matching School budget. It uses installed weights and makes no hosted-provider calls.

## Windows setup and measurement in one command

From the repository on the Windows machine with Ollama installed:

```powershell
powershell -File .\scripts\local-ollama-context.ps1 -RestartOllama
```

The wrapper backs up only the five environment values it changes, then configures `OLLAMA_NO_CLOUD=1`, `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_NUM_PARALLEL=1`, and `OLLAMA_MAX_LOADED_MODELS=1`. It preserves model storage paths and other unrelated settings. It discovers the installed executables through `Get-Command` and filesystem checks, restarts only matching observed Ollama executables, waits for local health, and runs the 16k/32k/64k matrix. Finish other Ollama requests before invoking the explicit restart. Automatic restart supports only `http://127.0.0.1:11434`; a nonmatching existing `OLLAMA_HOST` or probe lock is refused before settings change. Custom endpoints can use the CLI after their server is restarted separately.

You can supply `-Model`, `-Contexts`, `-Output`, and `-TimeoutMs`. With no `-RestartOllama`, the wrapper saves the settings and prints the restart/run instructions without running inference against an unchanged daemon. It neither downloads an engine nor pulls weights. The rollback command printed at the end restores the prior values of only those five settings:

```powershell
powershell -File .\scripts\local-ollama-context.ps1 -RestoreSettings .\local-ollama-settings-<timestamp>.json -RestartOllama
```

The PowerShell wrapper requires Windows and installed Node/Ollama. The platform-independent CLI below can also be used without changing server settings.

## Run it on the machine with the GPU

From the School repository in PowerShell or another terminal:

```powershell
npm run school:context -- --model qwen38-27b-ctx8k:latest
```

The default is inspection. It reads native Ollama metadata and memory snapshots; it does not load a model, create profiles, or change settings. Ollama must already be running. Use the exact installed model name from `ollama list`.

To prepare and test 16k, 32k, and 64k sequentially:

```powershell
npm run school:context -- --model qwen38-27b-ctx8k:latest --run --contexts 16384,32768,65536 --output .\local-context-results.json
```

Use a new output filename for each run. The output directory must exist. Progress is written to the terminal and the JSON receipt is updated as candidates complete. The command stops testing larger allocations after a failed candidate. A partial result keeps the successful smaller candidates and exits with status 1.

Run this while other model requests are idle so competing loads do not distort the comparison. The command processes one request at a time and holds an exclusive per-endpoint lock across preparation and testing. A preloaded target alias is refused before inference. A newly created profile is unloaded only when its exact inspected manifest, configuration and loaded context still match. A reused alias is never explicitly unloaded; the command observes expiry of its short idle lifetime before continuing, or preserves it and stops larger candidates. It does not kill unrelated model processes. A run can take several minutes per profile; each generation has a five-minute deadline, adjustable with `--timeout-ms` up to 1,800,000 ms. If a process crashes, its lock is retained; confirm it has stopped before removing the specific lock path reported by the next attempt. Other clients do not participate in this cooperative lock, so keep School requests idle throughout measurement.

To create profiles without loading or testing them:

```powershell
npm run school:context -- --model qwen38-27b-ctx8k:latest --prepare --output .\local-context-prepared.json
```

Profiles use names like `school-local-<configuration-digest>-ctx65536:latest`. They inherit the selected model and set `num_ctx`. The configuration digest distinguishes different weights, templates, system prompts, parameters, adapters, and baked message history. An existing matching profile is reused; a conflicting profile is refused, never overwritten. No model pull is issued. The profile is checked again after generation, and `/api/ps` must identify the same manifest before its allocation is qualified.

## What is checked

The command admits only an HTTP Ollama root on `127.0.0.1`, `localhost`, or `[::1]`. It converts `localhost` to literal IPv4 and makes direct HTTP connections, bypassing environment proxy variables. It never follows redirects or resolves provider credentials.

An admitted model must appear in `/api/tags`, report local GGUF weights and a local blob digest through `/api/show`, and advertise completion support. Cloud names and `remote_model`/`remote_host` metadata are refused, including aliases whose names do not say cloud. This is evidence supplied by the local Ollama server; it is not an independent attestation of GPU-resident weights or a defense against a compromised local server.

For each candidate, the run:

1. Confirms the requested size is within the reported native context. It does not apply RoPE extensions.
2. Creates or reuses the corresponding profile and checks its inherited configuration.
3. Makes a small calibration request to measure the model's actual token density.
4. Builds a synthetic archive targeting approximately 75% of the window, with separately generated values near its beginning, middle, and end.
5. Asks for all three values and checks the answer exactly.
6. Reads `/api/ps` to observe the allocated context and memory accounting.
7. Records RAM and, when `nvidia-smi` is available, GPU memory snapshots.

Generation exercises the profile's stored `num_ctx`; it does not override context through request options. Thinking is disabled for this narrow retrieval test and output is capped at 256 tokens. A real reasoning or tool-heavy conversation can have different costs.

## Read the result

| Field | Meaning |
| --- | --- |
| `model.nativeContext` | The context limit reported by the model metadata. |
| `model.configuredContext` | The source profile's configured `num_ctx`, if reported. |
| `candidates[].allocation.context` | Context observed in the running-model response after generation. |
| `probe.promptTokens` | Input tokens actually reported for the larger request. |
| `quality.testedContextFraction` | Actual measured input tokens divided by the requested context. |
| `quality.expected` and `probe.answer` | Values and answer retained for an independent exact-match check. |
| `probe.promptTokensPerSecond` / `outputTokensPerSecond` | Rates derived from Ollama's token counts and durations. |
| `allocation.residencyFraction` | `size_vram / size` from Ollama's running-model accounting. |
| `memory` | A post-request snapshot while the profile is still loaded; **not peak memory**. |
| `largestPassingContext` | Largest candidate that passed allocation, exact-answer, and measured-span checks. |
| `recommendedProfile` | Largest passing candidate also meeting the observed GPU/headroom criteria below. |

A measured-span pass requires actual input occupancy between 60% and 90% of the requested context. The bounds tolerate tokenization differences while refusing to qualify a 64k profile from a tiny input. The receipt always preserves the actual span. Three successful lookups are a narrow test, not proof that every task remains accurate across that window.

The recommendation additionally requires at least 98% GPU residency according to Ollama, exactly one detected GPU with at least 1 GiB free, and at least 2 GiB free RAM in the retained snapshot. Missing GPU telemetry leaves `recommendedProfile` empty. A candidate using CPU/RAM offload may pass the inference checks and become `largestPassingContext` without receiving a GPU-fit recommendation. Its measured latency remains available for the user's decision. System RAM is not as fast as VRAM, so prefer the larger offloaded profile only when its observed response time is useful for the task. Neither field establishes the maximum the hardware could ever fit.

**A profile passing at 64k does not establish peak-memory headroom or reliable School operation across 64k.** Test a representative School conversation, its tools, and compaction before making that profile the daily setting. No setting is changed by this command.

## Match School to the measured profile

After a candidate has passed and its speed is acceptable:

1. Open **Settings → Providers → Custom endpoint** and refresh the Ollama model inventory.
2. Find the exact profile named in the result.
3. Set its context to the candidate's `context` and output limit to `applicationPin.maxTokens`.
4. Select that model for the conversation and the applicable Strong/Cheap/Vision roles. Only choose it for vision if the actual local model and runtime support images.
5. Verify `ollama ps` after a request from School and test conversation compaction.

These pins are application budgets. They do not allocate runtime context. See [custom providers](custom-providers.md) and [compaction accounting](compaction-accounting.md).

## Memory options to evaluate separately

Ollama supports Flash Attention and quantized KV caches. `OLLAMA_KV_CACHE_TYPE=q8_0` can reduce cache memory relative to `f16`; it changes cache precision rather than model-weight precision. `OLLAMA_NUM_PARALLEL=1` limits concurrent request allocations. These are server-wide environment settings and may require restarting Ollama. This command does not change them or infer their effective values from client environment variables. Record any changes alongside comparative reports.

Primary references:

- [Ollama context length](https://docs.ollama.com/context-length)
- [Ollama OpenAI compatibility: local context size](https://docs.ollama.com/api/openai-compatibility)
- [Ollama API definitions](https://github.com/ollama/ollama/blob/main/docs/openapi.yaml)
- [Ollama native API](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [Ollama memory and concurrency options](https://docs.ollama.com/faq)
