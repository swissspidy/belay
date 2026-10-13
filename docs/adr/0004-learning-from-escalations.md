# ADR 0004: Learning from escalations

- Status: Accepted
- Date: 2026-10-12
- Scope: `@swissspidy/belay-core` (`learn()`, `feedback()`, `explore`), `@swissspidy/belay-learn` (new), examples, site
- Amends: ADR 0001 (adds an escalation reason, run event fields and an error stage); the README's
  "not in scope: training or fine-tuning"

## Context

Every escalation pays for a cloud answer and then throws it away. The cloud's answer to an input
the local model was unsure about is exactly the training example the local model lacked. A local
model that learns from those answers needs the cloud less over time: distillation, done online,
one escalation at a time, and only where the local model was unsure (active learning).

The built-in Classifier API cannot learn: its model is fixed. Fine-tuning an LLM in the page is
far too slow and memory-hungry for this. What is cheap is a small text embedding model (about
34 MB) and a classifier head on its vectors, which trains in milliseconds.

Four questions had to be answered:

1. How does a cloud answer reach the local runner, without the core knowing about training?
2. What does a learning model's confidence mean, when the model changes after every escalation?
3. Once the local model is confident, nothing checks it anymore. How do we notice it is wrong?
4. Where do the examples live, and what about privacy?

## Decisions

### 1. Core: an optional `learn()` on local runners, `feedback()` on tasks

`LocalRunner.learn?(example, ctx)` receives `{ input, value, source, cloudConfidence?, local?,
reason? }`. The task calls it after every validated cloud answer, without awaiting it (learning
must not add latency to `run()`); a rejection is an `error` event with stage `learn`. Runners
without `learn()` are unaffected.

`task.feedback(input, value)` validates `value` against the schema
(`BelayError('invalid-feedback')` otherwise) and awaits `learn()` with `source: 'feedback'`. It
resolves to `false` when the runner cannot learn. A user's correction is the strongest label
there is, so the learned runner weights it 3× and never lets a later cloud answer override it.

`learn()` receives the original input, not the redacted one: the redaction protects what leaves
the device, and learning stays on it. The examples store embeddings, never text.

Nothing is learned when escalation is blocked (`never`, consent denied, cloud error): there is no
label. Invalid cloud output is not learned either.

### 2. Confidence: Platt scaling on prequential pairs

The task's rule stays `confidence >= threshold`. For that to keep meaning "accept when at least
this likely right" while the head changes, the confidence must be calibrated continuously.

When the head predicts an input, it remembers its top label and raw score. When a label for that
input arrives (a cloud answer or feedback), the head records `(score, correct)` *before* learning
the input. These prequential pairs measure the head on data it had not seen. Platt scaling,
`P(correct) = σ(a · logit(score) + b)`, is fitted on the most recent 300 pairs, each weighted
by `0.5 ^ (age / 50)` in pairs, with Platt's smoothed targets (so a streak of right answers never
yields exactly 1) and a weak prior towards the identity. Newton's method with step halving fits it; the first version without step halving
diverged on a mostly-wrong head (`a` ≈ 4,000) and reported 0.99 for a 70%-accurate head.

The pairs are biased towards hard inputs, since most labels come from escalations. That does not
bias the calibration: the selection depends only on the score, and the fit is conditional on the
score. What escalations do not cover is the high-score region, which is what exploration is for.

Cold start: the confidence is 0 until there are 10 examples, 3 for the predicted label, and 30
pairs for the answering head. Below that, everything escalates, which is what produces the pairs.
Recent pairs weigh more, because the head changes. Old pairs describe a worse head and keep it
under-confident for longer; and when the inputs change under a confident head (drift), its new
mistakes must lower its confidence before a window of good pairs has scrolled by. Once most runs
stay local, labels arrive only from the few escalations and explored runs, so a window of 150
unweighted pairs covered about 1,400 inputs. A data bug made the first simulation stream sort
content moderation by label (non-toxic first): the classifier then answered most toxic comments
"non-toxic" for about 200 inputs before the window caught up. With the half-life, the label-shift
scenario in the simulation drops the device's share when the toxic comments arrive and keeps its
accuracy (see Results).

### 3. Exploration: `explore` in the core

`explore` (a rate, or `{ rate, random }`) sends that share of *confident* runs to the cloud
anyway, with the new escalation reason `exploration`. The cloud's answer is returned (it is the
better one) and the local runner learns from it, which gives the calibration pairs in the region
where the head is confident and would otherwise never be checked. Without it, a head that becomes
overconfident stays so: in the first prototype, content moderation reached 90% local share at 56%
accuracy.

It is a core feature, not a learned-runner one, because it is useful for any runner: run events
now carry `localLabel`, so on an `exploration` event `label === localLabel` is a live agreement
rate for the Classifier API too. Exploration only applies under the `auto` policy (asking a user's
consent about an answer the cascade already trusts makes no sense), and `savingsMeter()` counts
explored runs (`explored`) as cloud spend, because they are.

### 4. `@swissspidy/belay-learn`: embeddings plus a small head

A separate package, because it depends on transformers.js (an optional peer dependency, loaded
only by `transformersEmbedder()`) and `@swissspidy/belay-web` has no runtime dependencies.

- **Embedder:** `transformersEmbedder()`, defaulting to `Xenova/bge-small-en-v1.5` (384
  dimensions, about 34 MB at q8). On the three classification examples it had the best
  leave-one-out kNN accuracy of the three small models tried (all-MiniLM-L6-v2,
  bge-small-en-v1.5, multilingual-e5-small): 100%, 71% and 96% on triage, moderation and
  intents. `availability()` never downloads: in a browser it checks the Cache API for the
  model's files (transformers.js v4 rejects `local_files_only` there), in Node it loads with
  `local_files_only`. So a page can load the model without a user gesture after the first visit.
- **Heads:** k-nearest neighbors (k = 7, votes weighted by `exp(similarity / 0.1)`) from the first
  example, and a softmax layer (full-batch Adam, warm-started, retrained in the background after a
  200 ms debounce) from 50 examples. Both predict every input, so both collect calibration pairs;
  in `auto` mode the head that was right more often on the same recent inputs answers.
- **Store:** `memoryStore()` by default, `indexedDbStore()` to keep examples across reloads,
  scoped by task, schema fingerprint and embedder id. Examples are stored as embeddings, never
  as text. Embeddings can be partly inverted, so the README says to treat them as sensitive too.
- **Seed files:** `buildSeed()` embeds labeled examples (at build time, in Node, with the same
  embedder) into int8 base64 vectors plus leave-one-out kNN pairs, so a seeded classifier is
  calibrated from its first run. A seed for another embedder or schema is rejected.
- **Pending queue:** cloud answers that arrive before the embedding model is loaded are kept in
  memory (at most 256) and learned on `prepare()`.

## Results

`examples/scripts/learn-simulate.mjs` streams 1,000–1,500 inputs per task (disjoint from
`examples.jsonl`) through the real `task()` and `learnedClassifier()`, threshold 0.9, explore 5%,
with real bge-small embeddings. The teacher is the dataset's labels, or labels flipped as often as
the task's calibrated cloud model was wrong. Accuracy is against the dataset's labels.

| Task | Order | Teacher | Seed | On device | Accuracy on device | Accuracy | On device, last 300 | Accuracy on device, last 300 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ticket triage (1,500) | mixed | always right | – | 87.1% | 99.5% | 99.6% | 94.3% | 99.6% |
| Ticket triage (1,500) | mixed | always right | 300 | 95.6% | 99.0% | 99.1% | 94.3% | 98.9% |
| Ticket triage (1,500) | mixed | 94.3% right | – | 78.2% | 100.0% | 99.0% | 96.0% | 100.0% |
| Ticket triage (1,500) | mixed | 94.3% right | 300 | 95.6% | 99.0% | 98.8% | 94.3% | 98.9% |
| Content moderation (1,000) | by label | always right | – | 78.9% | 99.5% | 99.6% | 93.0% | 99.3% |
| Content moderation (1,000) | mixed | always right | – | 27.4% | 96.0% | 98.9% | 38.0% | 94.7% |
| Content moderation (1,000) | mixed | always right | 300 | 30.9% | 97.4% | 99.2% | 38.3% | 95.7% |
| Content moderation (1,000) | mixed | 83.7% right | – | 1.4% | 85.7% | 81.6% | 4.7% | 85.7% |
| Content moderation (1,000) | mixed | 83.7% right | 300 | 2.8% | 100.0% | 81.9% | 9.0% | 100.0% |
| Intent detection (1,467) | mixed | always right | – | 87.5% | 97.5% | 97.8% | 83.0% | 99.6% |
| Intent detection (1,467) | mixed | always right | 300 | 86.4% | 99.6% | 99.7% | 86.0% | 100.0% |
| Intent detection (1,467) | mixed | 99.7% right | – | 87.5% | 97.5% | 97.7% | 83.0% | 99.6% |
| Intent detection (1,467) | mixed | 99.7% right | 300 | 85.5% | 99.6% | 99.5% | 82.3% | 100.0% |

- Ticket triage and intent detection are the cases the design is for: narrow tasks whose labels
  are well separated in embedding space. Learning from nothing, the device answered 87% of the
  stream at 97.5–99.5% accuracy, and 99.6% at the end of it. A seed of 300 examples skips the
  cold start. Against a cloud that is right 94.3% of the time (Claude on triage), what the device
  answered was more accurate than the cloud.
- Content moderation is where embeddings are weak (about 70% leave-one-out kNN accuracy). With an
  always-right teacher the classifier still found the 30–38% of comments it could answer at
  95–97%, mostly through the softmax head, which `auto` picked over kNN. With a teacher as noisy
  as the real cloud (Jev, 83.7%), it kept almost everything in the cloud: its calibration
  measures agreement with the teacher, so it can never look more reliable than the teacher's
  labels let it. That is the safe failure.
- Sorted by label (500 non-toxic comments, then 500 toxic ones), the stream is the worst case for
  drift. The device answered the first block, lost its confidence when the toxic comments began,
  and relearned: 99.5% accuracy on device over the whole stream.
- The noisy teacher flips labels uniformly at random. Real cloud mistakes are systematic and
  would be learned as if they were right; the explored runs would then agree with them too. The
  classifier can only be as right as its teacher; `feedback()` is the way to correct both.

## Prior art and future work

The loop is established research: neural caching ([Cache & Distil](https://aclanthology.org/2024.findings-acl.704/),
Findings of ACL 2024), [OCaTS](https://arxiv.org/abs/2310.13395) (Findings of EMNLP 2023, with a
kNN student like ours) and [Online Cascade Learning](https://proceedings.mlr.press/v235/nie24a.html)
(ICML 2024). The [guide](../learned-classifier.md#prior-art) compares them. What is new here is
the packaging: in the browser, stored on the device, corrections as a second teacher, shippable
seeds, and the task's threshold, privacy policies and telemetry. Not adopted here, and since
adopted by [ADR 0005](0005-choosing-what-to-ask-and-keeping-what-it-learns.md):

- **Which runs to explore.** Exploration picks confident runs uniformly at random. Cache &
  Distil found margin sampling and query by committee (here: the two heads disagreeing) the best
  ways to choose what goes to the LLM. Exploring by margin would spend the same calls where the
  classifier is least sure of its top label.
- **A distance gate.** OCaTS also requires the input to be close to its nearest stored examples.
  A calibrated vote can be confident about an input unlike anything it has seen, if its
  neighbors happen to agree. A distance check would send those inputs to the cloud.
- **A cost-aware threshold.** OCaTS tunes its thresholds for accuracy minus λ × the share of
  LLM calls, and Online Cascade Learning learns the deferral policy itself. Here the threshold is
  a fixed target probability, as for every Belay runner.

## Consequences

- A cascade can now get cheaper as it runs. The calibration CLI does not model that: it fits a
  threshold for a fixed local runner. For a learned runner the threshold is a target probability
  (the confidence is calibrated), and the simulation script is the evaluation.
- `exploration` is a new `EscalationReason`, `learn` a new error stage and `invalid-feedback` a new
  error code: exhaustive switches over them in apps need a case.
- Learning happens on each user's device, from that user's escalations. A shared model would mean
  collecting embeddings and labels on a server (federated learning), which this does not do.
- The demo on the site (`site/learn/`) runs the triage stream in the page, with a simulated cloud,
  and is built from the packages' `dist/`, so the Pages workflow now installs and builds them.
