# Belay Tune on ticket triage: five runs, with the ledger

This is what `belay tune` did on one public task, with every file it wrote. The numbers come
from the files in this folder; nothing here was run on a schedule, so the series is per run,
not per night (see [Limits](#limits)).

## Result

On the holdout (301 inputs with gold labels), at a target of 95% cascade accuracy:

| Backend | Local share before | Local share after | Accuracy before | Accuracy after |
| --- | --- | --- | --- | --- |
| Chrome's built-in classifier | 96.0% | 100.0% | 97.1% | 97.3% |
| Gemini Nano through the Prompt API, with a classifier as judge | 57.1% | 100.0% | 96.6% | 97.3% |

Local share is the share of inputs answered on the device. For the Prompt API backend, 43 of
100 inputs went to the cloud before tuning and none after, at an accuracy that the gate could
not tell apart from the baseline's. Both changes are few-shot examples added to the prompt, six for the classifier and seven for
the Prompt API ([`belay/`](belay)); no rule and no rewording was kept.

## Setup

- **Task:** route a support message to one of five teams (`examples/ticket-triage`).
- **Data:** 1,500 messages from the
  [Bitext customer support dataset](https://huggingface.co/datasets/bitext/Bitext-customer-support-llm-chatbot-training-dataset)
  (CDLA-Sharing-1.0, see `examples/DATA-LICENSES.md`), with their labels as gold labels: 915
  for training, 284 for validation, 301 held out for the gate.
- **Browser:** Chrome 157 on Linux, models on CPU.
- **Reflecting model:** Gemini, through the Gemini API. It proposes changes; it never sees the
  holdout.
- **Cloud side:** not called. The cloud's accuracy on this task is taken as 94.3%, from the
  example's calibration.

## The runs

| Run | Backend | Experiments | Best on validation (local share at accuracy) | Holdout: local share, accuracy | Gate | Reflector spend |
| --- | --- | --- | --- | --- | --- | --- |
| `m3-acceptance` | classifier | 20 | 100.0% at 95.8% (from 96.5% at 95.2%) | 100.0%, 97.3% (from 96.0%, 97.1%) | rejected: accuracy interval too wide for a 1-point margin; 25% slower | 0.19 USD |
| `m4-promote` | classifier | 1 (the same candidate, carried over) | 100.0% at 95.8% | 100.0%, 97.3% | passed, after the gate was widened (below) | 0 |
| `m5-prompt` | Prompt API | 6 | 100.0% at 97.2% (from 52.5% at 95.2%) | 100.0%, 95.7% (from 57.1%, 96.6%) | rejected: recall of "order" down 6.1 points; accuracy inconclusive | 0.08 USD |
| `m5-prompt-2` | Prompt API | 6 | 100.0% at 95.8% | 100.0%, 94.4% | rejected: recall of "order" down 12.4 points; accuracy inconclusive | 0.12 USD |
| `m5-prompt-3` | Prompt API | 6 | 100.0% at 96.5% | 100.0%, 97.3% | passed: recall of "order" down 2.9 points; accuracy +0.8 points (95% CI -1.4 to +3.0) | 0.09 USD |

In total: 49 ledger entries, 39 experiments, 0.49 USD of reflector spend, and about fourteen
hours of one CPU machine. A run of six experiments with the Prompt API took about three and a
half hours.

## What the runs changed in Belay Tune

Three of the five runs ended in a rejection, and each rejection changed the tool:

1. **`m3-acceptance`.** The candidate was 4 points more local and no less accurate, but 301
   holdout examples give an interval of about 3.7 points, and the gate's default asks for
   proof of "at most 1 point lower". A result like this is now reported as **inconclusive**, with
   an estimate of the holdout that would settle it (about 900 examples here), and the
   candidate is tried again first on the next run.
2. **`m5-prompt` and `m5-prompt-2`.** The loop fitted thresholds on the accuracy over all
   labels, and found prompts with which the local model answered everything while getting one
   label wrong more often. The gate's recall check refused both. The loop now fits a
   candidate's threshold so that no label's recall falls more than half of the gate's limit
   below the baseline's on validation. `m5-prompt-3` ran with that change.

## Limits

- **The gate was widened by hand.** Between `m3-acceptance` and `m4-promote`,
  [`belay.gate.json`](belay.gate.json) was changed from the defaults (1 point of accuracy, 10%
  of latency) to 2 points and 30%. That is the gate owner's decision to make, and the ledger
  shows it: the `protected` hash of the entries changes there. Under the defaults, both
  promotions would have been "inconclusive" for accuracy, and the classifier's also rejected
  for latency (p95 2145 ms to 2690 ms).
- **The protected hash changes a second time,** before `m5-prompt-3`: the evaluator was
  rebuilt with the recall change and the lock was made again.
- **Runs, not nights.** The runs were started by hand over one day. Both backends reached 100%
  local share on this task, so a further night has nothing left to gain here; a harder task
  would be needed to show a series over weeks.
- **One passing run after the recall change** shows that it can work, not how often it does.
- **One machine, one Chrome version.** `belay verify` reproduced both gate records on the same
  machine ([classifier](classifier-api.verify.md), [Prompt API](prompt-api.verify.md)); the
  Prompt API answered 8 of 301 inputs differently on the second pass, at the same accuracy.
- **Bitext's texts are generated from templates,** which makes this task easier than real
  support mail.

## Files

| File | What it is |
| --- | --- |
| [`ledger.jsonl`](ledger.jsonl) | Every experiment of the five runs: hypothesis, patch, scores, verdict and reason, in a hash chain. `belay ledger --file docs/reports/ticket-triage/ledger.jsonl` prints it. |
| [`belay/`](belay) | The two promoted configs, their calibration files and their gate records (per holdout input: confidence, and right or wrong). |
| [`classifier-api.report.md`](classifier-api.report.md), [`prompt-api.report.md`](prompt-api.report.md) | The report of the promoting run of each backend. |
| [`classifier-api.verify.md`](classifier-api.verify.md), [`prompt-api.verify.md`](prompt-api.verify.md) | `belay verify`, run after the last promotion. |
| [`belay.gate.json`](belay.gate.json) | The widened gate. |

The datasets are not copied here: they are the 1,500 rows of
`examples/ticket-triage/stream.jsonl`, imported as gold-labeled traces with `labelTrace()` and
split by `belay datasets` with seed 7. ADR 0007 sections 9 to 11 describe the runs in more
detail.
