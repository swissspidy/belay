# ADR 0009: Weights spike: a LoRA-tuned Gemma 3 270M, scored in the browser

- Status: Accepted (no-go for a weights rung now; the spike's scripts are not in the repository)
- Date: 2026-11-11
- Scope: `@swissspidy/belay-tune` (rung 5 of the brief, milestone M6)
- Relates to: ADR 0007 §11 and its report in `docs/reports/ticket-triage`

## Question

The brief's fifth rung trains weights for bring-your-own models. Its milestone is a time-boxed
spike with a rule: go only if a LoRA-tuned small Gemma, exported, quantised and scored in the
browser, beats the best prompt-only config by 5 points of local share at equal accuracy.

## What was done

On the ticket-triage task of ADR 0007 (915 training, 284 validation and 301 holdout examples
with gold labels, target 95% cascade accuracy), on one machine with 4 CPU cores and no GPU:

1. **Train.** Gemma 3 270M (instruction-tuned), LoRA of rank 16 on the attention and MLP
   projections (3.8 million trainable parameters, 1.4%), three epochs over the 915 training
   examples with PyTorch and PEFT. The prompt is the task's context and question with the five
   labels; the answer is the label, which is one token for each of the five. 20 minutes.
2. **Export and quantise.** The adapter (15 MB) is merged, exported to ONNX with Optimum
   (decoder with past), and quantised to 8 bits with ONNX Runtime: 437 MB.
3. **Score in the browser.** A page loads the file with Transformers.js 4.3.2 on WASM (4
   threads), reads the logits of the first answer token and takes the softmax over the five
   label tokens as value and confidence. A `LocalRunner` drives that page through Playwright,
   and `belay tune --dry-run` scores it like any other local side.

## Result

| On the holdout (301) | Local share | Accuracy | p95 latency | Download |
| --- | --- | --- | --- | --- |
| Chrome's classifier, tuned prompt (ADR 0007) | 100.0% | 97.3% | 2.7 s | none (built in) |
| Gemini Nano through the Prompt API with a judge, tuned prompt | 100.0% | 97.3% | 6.5 s | none (built in) |
| Gemma 3 270M with LoRA, 8-bit, Transformers.js on WASM | 100.0% | 97.0% (95% CI 95.3% to 98.7%) | 0.4 s | 437 MB |

Other numbers:

- Without the adapter, the same model with the same prompt gets 26% of validation right.
- With the adapter, it gets 284 of 284 validation examples right in PyTorch at 32 bits, and
  98.2% in the browser at 8 bits: quantising cost 1.8 points.
- The latencies of the first two rows were measured in Chrome 157 with a window, the third in
  Playwright's headless Chromium 153, all on the same CPU. The median of the third is 0.3 s,
  and the model loads in 6 s from a local server.

## Decision

**No-go, by the brief's rule.** Both prompt-only configs already answer every holdout input on
the device at the target accuracy, so there are no 5 points of local share to gain on this
task. The weights model matches them; it does not beat them.

A weights rung is not built into `belay tune`.

## What the spike showed all the same

- **The pipeline works end to end on a laptop-class CPU** in under half an hour, with public
  tools, and a tuned model plugs into Belay as a `LocalRunner` without changes to the core or
  to the evaluator.
- **It is the fastest local side measured here** on CPU, by a factor of 6 to 15, because it
  reads one token's logits where the built-in models generate or run a larger model. The
  gate's latency check is where a prompt-only candidate failed in ADR 0007 §9; a weights model
  would not have.
- **It costs a 437 MB download per user and a model to host and version,** which the built-in
  models do not. The 4-bit quantisation that ONNX Runtime offers left the embedding table at
  32 bits and came out larger (840 MB), so 8 bits was used.
- **The rule may be the wrong one for this rung.** It asks for local share, which prompt
  tuning had already taken to 100% here. Where weights could win is latency, a task on which
  prompt tuning stalls below the target, or a browser without a built-in model. The spike
  measured none of those three as a requirement.

## Limits

- One task, whose texts are generated from templates (Bitext) and are easy to learn: a 270M
  model reaching 100% on validation says as much about the data as about the method.
- The model's confidence was not calibrated or checked beyond the threshold fit.
- No WebGPU, no phone, no second browser. No measurement of memory.
- Whether built-in browser models accept adapters is still unconfirmed (ADR 0007, open
  questions).
- The weights were taken from a public mirror of Gemma 3 270M; Google's Gemma terms apply to
  the model and to anything tuned from it. Nothing tuned is published.

## When to look again

- A task where the loop reports a plateau below the target on rungs 1 to 4.
- A latency requirement the built-in models cannot meet.
- A target browser without a built-in model.
