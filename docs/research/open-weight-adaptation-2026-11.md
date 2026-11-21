# Open-weight adaptation: research compilation for School and AUM

Research verified **2026-11-21**.

This compilation records upstream methods and proposed experiments. The companion [research index](open-weight-adaptation-2026-11.json) is descriptive reference data with no execution semantics. Every listed method is marked **not_integrated** in School. Upstream implementation availability, repository readiness and a witnessed successful run are different states.

## What is being adapted?

AUM's records, stored operations, task specifications and symbolic state are not automatically neural weights. These methods can adapt an **explicitly bound open-weight learner used by AUM**. School can also study harness documents, AUM operations and curricula as separate targets. Improvement in one target does not establish improvement in the others.

Three choices must remain distinguishable:

| Choice | Meaning | Examples |
| --- | --- | --- |
| Learning objective | What training rewards or asks the learner to predict | Supervised fine-tuning, DPO, reward-based optimization |
| Update mechanism | Which parameters change and how | QLoRA, DoRA, LoRA-FA, Q-GaLore |
| Orchestration protocol | How experience becomes a proposal, experiment and adopted candidate | Offline training, SEAL, TTT-Discover, harness/weights co-evolution |

**Supervised fine-tuning (SFT)** is the baseline objective: predict tokens in approved demonstrations. LoRA or QLoRA determines how the learner's parameters change. DPO can likewise use QLoRA; they are not competing choices at the same level.

### Why retain a LoRA baseline?

Thinking Machines' *LoRA Without Regret* (2025-09-29) found configurations that matched full fine-tuning on their small-to-medium supervised datasets and RL experiments. Adapter targets, capacity, learning rates and batch sizes mattered. This supports a careful baseline rather than an assumption that a newer method must win; it does not establish universal equivalence, including for quantized training. [Primary research](https://thinkingmachines.ai/blog/lora/).

## Suggested sequencing for discussion

| Phase | Purpose |
| --- | --- |
| P0 | Establish reproducible task splits, pinned learner identity, independent grading, retained candidates and adoption/rollback evidence. |
| P1 | Evaluate a supervised LoRA/QLoRA baseline, verified-trace distillation and DPO when suitable pairs exist; separately study bounded harness proposals. |
| P2 | Compare adapter variants, GRPO/RLVR, TinyLoRA and knowledge-specific MiCA against working baselines. |
| P3 | Study full-parameter updates, nested adaptation, problem-specific training, joint evolution and direct weight rewriting. |

These phases express dependency order and research priorities, not an approved runtime design or an instruction to provision resources.

## Methods

### 1. QLoRA

**2023-05-23 · Update mechanism · Neural adapter · Established upstream support.** QLoRA freezes a quantized base and trains low-rank adapters. Inputs are a pinned learner/tokenizer, training examples, objective and configuration; outputs are adapter weights and training evidence. It needs compatible quantization, autograd and training software. It can support supervised learning, preference learning or RL; it does not define the learning objective. Four-bit storage does not remove activation or rollout costs, and results from the paper do not guarantee parity for every task. **Proposed phase: P1**, supervised adaptation from independently checked School episodes, with candidate evaluation before adoption.

Sources: [paper, v1](https://arxiv.org/abs/2305.14314v1); [original implementation](https://github.com/artidoro/qlora).

### 2. DoRA, PiSSA and EVA

**DoRA 2024-02-14; PiSSA 2024-04-03; EVA 2024-10-09 · Adapter mechanisms · Published, implemented upstream.** DoRA separates weight magnitude and direction. PiSSA initializes adaptation from principal weight components. EVA uses training activations and redistributes adapter rank. Inputs extend the baseline with initialization/rank settings; EVA also needs representative data for activation collection. Outputs are adapters and their initialization metadata. Dependencies include supported layers and decomposition/calibration operations. Methods differ in quantization, checkpoint and serving compatibility; improvements in selected experiments do not establish a universal winner. **Proposed phase: P2**, changing one mechanism while retaining the same task split, objective, budget and evaluator.

Sources: [DoRA, v6](https://arxiv.org/abs/2402.09353v6); [PiSSA, v4](https://arxiv.org/abs/2404.02948v4); [EVA, v5](https://arxiv.org/abs/2410.07170v5); [PEFT](https://huggingface.co/docs/peft/main/package_reference/lora).

### 3. LoRA-FA

**2023-08-07; inspected revision 2026-05-09 · Mechanism/optimizer · Upstream PEFT support.** LoRA-FA freezes the adapter's down-projection factor and trains its up-projection factor with gradient corrections, reducing activation-memory requirements. Inputs include the pinned learner, examples, fixed-factor initialization, rank and optimizer settings. Outputs are an adapter candidate and resource measurements. It requires compatible layers and the appropriate optimizer. Reduced adapter-related memory does not eliminate the cost of the base model, long sequences or RL rollouts. **Proposed phase: P2**, when a working baseline identifies activation memory as the limiting resource. Compare actual peak memory, runtime and held-out quality.

Sources: [paper, v3](https://arxiv.org/abs/2308.03303v3); [PEFT optimizer documentation](https://huggingface.co/docs/peft/main/package_reference/lora).

### 4. Q-GaLore

**2024-07-11 · Full-parameter mechanism · Published research implementation.** Q-GaLore compresses gradient projections and combines low-precision weights with stochastic rounding. Base weights can change, rather than only an attached adapter. Inputs are a base checkpoint, corpus and projection/optimizer settings; outputs are a complete candidate checkpoint and training evidence. It needs compatible low-precision training code and projection updates. The reported 7B configuration fitting on a 16GB GPU demonstrates memory feasibility, not affordable or rapid full pretraining. **Proposed phase: P3**, after measured adapter limitations justify broader weight updates. Compare throughput, retained capabilities and checkpoint reproducibility as well as memory.

Sources: [paper, v1](https://arxiv.org/abs/2407.08296v1); [official implementation](https://github.com/VITA-Group/Q-GaLore).

### 5. Direct Preference Optimization

**2023-05-29 · Learning objective · Established upstream trainer.** DPO trains from preferred and dispreferred responses without fitting a separate reward model or requiring online rollout sampling during the basic offline procedure. Inputs are prompts, paired responses, preference provenance and a reference policy; outputs are a preference-trained candidate. It can use LoRA/QLoRA or full updates. Dependencies include reliable comparable pairs and reference log-probabilities. Preferences can encode mistakes or privileged context, so School should retain why one response was preferred and what each producer could observe. **Proposed phase: P1**, after trustworthy pairs exist, with held-out evaluation independent of preference construction.

Sources: [paper, v3](https://arxiv.org/abs/2305.18290v3); [TRL DPO trainer](https://huggingface.co/docs/trl/dpo_trainer).

### 6. GRPO and reinforcement learning with verifiable rewards

**GRPO 2024-02-05; R1 exemplar 2025-01-22 · Algorithm/reward design · Upstream trainers available.** GRPO compares sampled completions within groups. RLVR uses independently checkable rewards; it can use other optimizers, while GRPO can use other reward types. Inputs include tasks, policy, environment, rollout budget and verifier; outputs are a policy candidate and scored trajectories. Dependencies include repeated generation and a reliable executable evaluator. Reward exploitation, weak exploration and leaked evaluator information can produce misleading progress; rollouts may dominate cost. **Proposed phase: P2**, beginning with small AUM tasks whose answers or state changes can be checked independently.

Sources: [DeepSeekMath, v3](https://arxiv.org/abs/2402.03300v3); [DeepSeek-R1, v2](https://arxiv.org/abs/2501.12948v2); [TRL](https://github.com/huggingface/trl).

### 7. Verified-trace distillation

**Longstanding approach; R1 exemplar 2025-01-22 · Data transfer · Established practice.** Distillation trains a learner using selected outputs or trajectories from a teacher or more expensive search procedure. Inputs include task, producer identity, observable context, retained response and independent outcome evidence. Outputs are a training dataset and student candidate, often through supervised LoRA/QLoRA. Dependencies include usable data, filtering and sufficient learner capacity. Teacher fluency is not correctness evidence; privileged teacher context and held-out answers must not become unnoticed training hints. **Proposed phase: P1**, starting with existing verified episodes and testing performance beyond imitation loss.

Sources: [DeepSeek-R1, v2](https://arxiv.org/abs/2501.12948v2); [official repository](https://github.com/deepseek-ai/DeepSeek-R1).

### 8. TinyLoRA

**2026-02-04 · Adapter parameterization · Recent research with PEFT support.** TinyLoRA projects a small trainable vector through fixed structures, with optional sharing across modules. The paper demonstrates math adaptation with as few as thirteen learned parameters under RL. Inputs include the model, projection seed/structures, sharing settings and RL tasks; outputs are coefficients plus reconstruction metadata. It still needs the base model and rollout infrastructure. Learned-byte counts exclude those resources, and strong low-parameter results do not establish large-scale knowledge ingestion or generality beyond tested tasks. **Proposed phase: P2**, after GRPO works, comparing quality and complete resource cost.

Sources: [paper, v1](https://arxiv.org/abs/2602.04118v1); [PEFT implementation](https://huggingface.co/docs/peft/en/package_reference/tinylora).

### 9. MiCA

**2026-04-02 · Constrained adapter mechanism · Recent preprint and PEFT example.** MiCA constrains updates to minor singular directions of pretrained weights, freezing the basis while training the other factor. Inputs are a base model, domain corpus, decomposition settings and knowledge tests; outputs are a domain-adapted candidate. Dependencies include supported layers and continued-pretraining software. Evidence covers 7B-scale models and controlled corpora. Current guidance targets knowledge/domain adaptation, followed where needed by instruction tuning, rather than general instruction training. **Proposed phase: P2**, a bounded knowledge-ingestion study with retrieval-only and ordinary LoRA controls, including tests of retained capabilities.

Sources: [paper, v1](https://arxiv.org/abs/2604.01694v1); [PEFT example](https://github.com/huggingface/peft/blob/main/examples/mica_finetuning/README.md).

### 10. SEAL

**2025-06-12 · Learned adaptation protocol · Published research with code.** SEAL trains a model to generate its own adaptation material or directives. An inner supervised update produces adapted weights; an outer RL loop rewards directives according to downstream performance. Inputs are new information/tasks, allowed directives and adaptation evaluation; outputs include the proposed edit, adapted candidate and meta-training evidence. Dependencies include nested training, temporary model versions and separated learning/evaluation data. Published demonstrations cover knowledge incorporation and few-shot generalization. A generated self-edit does not establish improvement. **Proposed phase: P3**, after School can independently evaluate ordinary adaptation candidates.

Sources: [paper](https://arxiv.org/abs/2506.10943); [official repository](https://github.com/Continual-Intelligence/SEAL).

### 11. TTT-Discover

**2026-01-22 · Problem-specific training/search protocol · Research implementation.** TTT-Discover continues RL while working on one problem, prioritizing discovery of an excellent solution. Inputs are a problem, solution representation, continuous reward and budget; outputs include solutions, verification evidence and an adapted proposal policy. It needs repeated evaluation and a training backend. Published experiments use an open 120B model through Tinker, so they are not a consumer-GPU recipe. Improving one solution does not establish general capability or retention. **Proposed phase: P3**, comparing a bounded AUM optimization task against frozen-policy search at the same total budget.

Sources: [paper](https://arxiv.org/abs/2601.16175); [authors' project](https://test-time-training.github.io/discover/).

### 12. Harness and weights co-evolution

**2026; exact day unverified · Two-layer protocol · Research code and records.** Failure traces drive tested harness-rule edits and multi-turn GRPO adapter updates. Inputs are conversations, task splits and proposals; outputs are separately identified harness/weight versions and joint evaluations. The published round uses four 80GB GPUs, about 84 hours across both domains, and external simulator/judge services. Teacher-free does not mean service-free. **Proposed phases: P1** for separate targets and the four-way old/new harness/weights comparison; **P3** for full reproduction. These measurement concepts do not constitute an integrated trainer.

Source: [official README](https://github.com/Brightendata/knowledge-in-the-harness/blob/main/README.md), inspected blob `3a2bf0b55c1b661d3bd6362d0ec934c4359ab75d`. Its citation confirms 2026 but leaves the arXiv link blank.

### 13. Direct self-rewriting of weights

**2026-11-16; revision 2026-11-18 · Direct numerical edits/protocol · Very recent preprint.** A model inspects weights and graded practice behavior, then proposes weight-editing code without gradient training. Inputs are pinned weights, practice evidence and controlled execution; outputs are a candidate edit and evaluation trace. Dependencies include tensor access, isolated execution and model-serving resources. Evidence concerns the reported model family; smaller models sometimes failed or damaged performance. Crucially, the reported sessions restart from base weights: accepted candidates can replace the incumbent, but this is not cumulative training initialized from each accepted edit. **Proposed phase: P3**, isolated research after ordinary candidate evaluation and rollback are proven.

Source: [paper, v2](https://arxiv.org/abs/2611.21885v2).

## Evidence needed for useful School comparisons

The comparison should identify its target, objective, mechanism and protocol; pin the base model/tokenizer, data split and evaluator; and retain the actual candidate, execution record and independent result. Proposed, attempted, completed, evaluated and adopted are distinct outcomes. A missing trainer or unavailable resource is not evidence of a successful adaptation.

Keep training, model selection and final evaluation separate. Preference pairs must preserve comparable observable context and the reason for preference. Distillation must identify what the teacher saw. Private verifier context, reference answers and held-out labels must not leak into learner inputs, generated examples or adaptation directives.

Measure held-out task success, preservation of relevant prior capabilities, wall time, peak memory, generated tokens, environment calls and any external spend. Small adapters do not imply small complete training costs.

When harness and weights both change, compare old harness/old weights, new harness/old weights, old harness/new weights and new harness/new weights. This distinguishes contributions that a single final score hides.

**First candidate study for discussion:** an AUM task with an exact checker, a frozen local-learner baseline, retained verified episodes, supervised QLoRA adaptation, then held-out evaluation and an adoption/reopen check. Subsequent methods can reuse that measurement foundation.

## Source and claim boundaries

Paper dates are first publication dates unless stated otherwise. Versioned arXiv links identify inspected revisions where known. Live repository and documentation links are explicitly unpinned in the index. The co-evolution README's blob hash identifies inspected content; it is not a commit reference or a complete environment pin.

Reported study results remain scoped to their published conditions. The index contains no trainer implementation, executable configuration, tensor interface or new AUM record schema. Applying these methods requires a separately approved design and witnessed execution.
