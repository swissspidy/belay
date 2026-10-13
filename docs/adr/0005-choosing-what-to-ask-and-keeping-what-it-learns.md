# ADR 0005: Choosing what to ask, and keeping what it learns

- Status: Accepted
- Date: 2026-10-12
- Scope: `@swissspidy/belay-core` (`explore.strategy`, `costAwareThreshold()`),
  `@swissspidy/belay-learn` (distance gate, snapshots, `persistStorage()`, `simulateLearning()`),
  `@swissspidy/belay-calibrate` (`belay seed`, `belay simulate`), examples, site
- Amends: ADR 0004 (adopts its three "not adopted yet" ideas)

## Context

ADR 0004 shipped a local classifier that learns from the cloud's answers, and listed three ideas
from the research it had not adopted: choosing which confident runs to spot-check by how
informative they are, a gate on inputs far from anything stored, and a threshold derived from
costs. Using it also raised practical questions the first version left to the app:

1. Which confident runs are worth a cloud call?
2. What about an input unlike anything the classifier has seen, which its calibrated vote can
   still be confident about?
3. Where does the threshold come from, for a runner whose confidence is already a probability?
4. How does what it learned survive the browser clearing storage, or move to another device?
5. How does a developer find out whether their task suits it, and build a seed, without writing
   the scripts in `examples/scripts/`?

## Decisions

### 1. Informative exploration, with importance weights

`explore: { rate, strategy: 'informative', floor }` spends about the same budget as `rate`
(somewhat more, because of the floor) but skews it towards the runs the local runner is least
sure of. A local runner may report
`informativeness` in [0, 1] with its output; the learned classifier reports `1 − (top1 − top2)`
(margin sampling), or 1 when its kNN and softmax heads disagree (query by committee). Runners
that don't report it get `1 − confidence`.

A confident run is explored with probability

    p = clamp(rate × u / mean(u), rate × floor, 1)

where `mean(u)` is an exponential moving average (α = 0.02) of the informativeness of confident
runs. Dividing by the running mean keeps the average rate near `rate` without knowing the
distribution of `u` in advance, the same idea as Cache & Distil's budget by percentile of its own
score history.

Exploring by informativeness biases the explored sample. The calibration (ADR 0004 §2) and any
agreement rate computed from explored runs would then over-represent hard inputs and
underestimate how often the device agrees with the cloud. So:

- **A floor.** Every confident run keeps probability at least `rate × floor` (default 0.2, and
  required to be above 0), so none is unobservable: importance weighting needs a probability
  bounded away from 0 (IWAL's `p_min`). An informativeness that is not a finite number is ignored.
- **Importance weights.** An explored run carries `explorationWeight = rate / p` on its
  `LearnExample` and its run event. The learned classifier multiplies the weight of the
  calibration pair it records for that run (capped at 20); dashboards weigh agreement by it. A
  run explored with probability `rate` has weight 1, so `uniform` is unchanged.

What the weights buy is limited, and the docs say so: the explored pairs enter the calibration in
the proportions uniform exploration would have given, in expectation. That does not make the fit
unbiased. Platt scaling is a two-parameter, recency-weighted model; the pairs from escalations
below the threshold (and from gated inputs) enter at weight 1; and a weighted agreement rate is a
ratio estimator, consistent rather than unbiased. Agreement is also agreement with the cloud,
not accuracy.

In the ablation (cold start, 1,000–1,500 inputs per task, below) it made no consistent
difference. Without the gate it raised the device's accuracy on intents from 97.5% to 98.4% for
0.6 points of local share, and the local share on ticket triage with a noisy teacher from 78.2% to
81.3%; with the gate on, it cost 0.2–5.1 points of local share for at most 0.7 points of accuracy,
and lowered overall accuracy on ticket triage with a noisy teacher from 98.9% to 98.4%. It also
explored more: 4.6–6.4% of confident runs, against 4.1–4.5% for uniform.
The default stays `uniform`, whose agreement rate needs no weights, and `informative` is an
option to try with `belay simulate` on one's own data.

### 2. A distance gate

The calibrated confidence is P(correct) averaged over the inputs the classifier has been scored
on. An input far from all of them is not covered by that average, and a kNN vote among distant
neighbors can still be unanimous. The learned classifier now gates those inputs: their
confidence is 0 (they escalate as `low-confidence`, with `raw.gate: 'distance'`).

- **Score:** cosine similarity to the k-th nearest stored example (k = 5), the out-of-distribution
  score of Sun et al. (2022) on normalized embeddings. The k-th rather than the first neighbor is
  robust to one stray near-duplicate.
- **Threshold:** the 5% quantile of the same score for the stored examples, each left out in
  turn, so about 95% of what the classifier has learned from would pass, the operating point
  Sun et al. report. It is computed on up to 300 stored examples and recomputed once examples
  amounting to 10% of the store (at least 5) have been added or replaced since. A refit costs up
  to 300 × n dot products, about a second at 5,000 examples, so it runs in the background in
  chunks that yield to the event loop: runs use the previous threshold meanwhile, and the first
  run after loading a store waits for the first fit.
- **Off until 30 examples:** with fewer, the leave-one-out scores are too few and too far apart
  to say what "unusual" means.
- **On by default**, `distanceGate: false` to disable, a number for a fixed threshold, or
  `{ k, quantile, minSamples }`.

A first version scored each input on arrival against the examples before it. That baseline was
skewed low by the early, sparse examples and gated almost nothing later on; the leave-one-out
quantile over the current examples tracks the store as it grows.

In the ablation the gate cost 0.1–2.8 points of local share with uniform spot checks (1.1–8.6
with informative ones) and sent 8–44 inputs per stream to the cloud. Where the device made confident mistakes it removed many of them: on intents, the
device's accuracy rose from 97.5% to 98.6% (its mistakes fell from 2.2% to 1.2% of all inputs) and
overall accuracy from 97.8% to 98.8%; on ticket triage from 99.5% to 99.7%. On content moderation
it changed nothing. On the label-sorted moderation stream it did not help: it gated only 8
inputs, and on-device accuracy went from 99.5% to 98.9%, because the toxic comments arrived
close to civil ones in embedding space, not far from everything. A distance gate catches inputs
unlike anything stored, not a change of label among similar inputs; the calibration's recency
weighting handles that (ADR 0004). On by default because it trades a few cloud calls for fewer
confident mistakes, which is what a threshold of 0.9 asks for. With a seed it cost little on
intents: 85.2% on device at 99.7%, against ADR 0004's 86.4% at 99.6% without the gate.

Seeded runs turned out sensitive to when the softmax head first trains. Once refits moved off the
run path (see the threshold above), the first run after loading a seed waits for the gate's first
fit, and the softmax head trains on the seed meanwhile instead of a few runs later. This moved
seeded intents from 79.9% to 85.2% on device (99.9% to 99.7% accurate), and seeded content
moderation from 30.0% at 96.7% to 38.8% at 93.3% (91.2% over the last 300 inputs, close to the 0.9
target). The tables show the current code.

### 3. A cost-aware threshold, as a helper

Escalating costs `C_call + (1 − a_cloud) × C_err` in expectation; answering locally costs
`(1 − P(local right)) × C_err`. What P(local right) is depends on what the confidence p is
calibrated against:

- **Against labels** (`belay calibrate`), p = P(right), and accepting locally is cheaper iff

      p ≥ a_cloud − C_call / C_err

  Chow's (1970) reject rule, with the cloud as the reject option. OCaTS's objective, accuracy
  minus λ × the share of LLM calls, is the same rule with `λ = C_call / C_err`.
- **Against the cloud** (the learned classifier: the cloud's answers are its only labels), p =
  P(agrees with the cloud). Counting a local answer as right only when it agrees with a right
  cloud, P(local right) ≈ p × a_cloud, and the break-even is

      p ≥ 1 − C_call / (a_cloud × C_err)

  This is conservative: a local answer that disagrees with a wrong cloud can still be right. A
  fallible cloud raises this threshold, where it lowers the first one.

`costAwareThreshold({ errorCost, cloudCost, cloudAccuracy, calibration, calibratedAgainst })` in
the core returns either (default `'cloud'`), reading the cloud's cost and accuracy from a
calibration file when given one. The two agree when the cloud is always right. A first version
used the first rule for the learned classifier, which with a 97%-accurate cloud gave 0.966 where
0.996 was the break-even; the adversarial review caught it. It is a helper that computes a number
for `threshold`, not a new mode: the threshold keeps one meaning for every runner, and the rule is
approximately right at best, since the cloud's accuracy also varies with p. Learning the deferral
policy online (Online Cascade Learning; learning to defer, Mozannar & Sontag 2020) would need the
error cost at run time, which apps rarely have.

### 4. Keeping what it learns

- **Snapshots.** `exportState(task)` returns a versioned JSON document (`kind:
  'belay-learn-state'`, `version: 1`): the task, schema fingerprint and embedder id, the examples
  (int8 embeddings, label, source, time; no text) and the calibration pairs of both heads.
  `importState(snapshot, { replace })` merges into the store (a user's correction wins over a
  cloud answer for the same input) or replaces it, then reloads the task if it is loaded.
  Calibration pairs carry the id of the input they were scored on, so a merge counts each
  prediction once and re-importing one's own backup changes nothing. Imports respect
  `maxExamples`, reject malformed embeddings (wrong length, non-finite values) and pair weights
  above the cap, and refuse a snapshot for another schema of a task the page runs (one for a task
  not loaded yet lands in its schema's scope). Runs that start during an import wait for it, and
  labels waiting for the embedding model survive it. This mirrors TensorFlow.js's model save handlers (`indexeddb://`, `downloads://`, HTTP),
  and Teachable Machine's export, for a model that is mostly data.
- **`persistStorage()`** asks for persistent storage (`navigator.storage.persist()`) and reports
  usage and quota. Best-effort storage is evicted under pressure, and Safari deletes
  script-written storage after 7 days of Safari use without an interaction on the site, unless
  it runs as a Home Screen web app. The guide says when to ask, and that export is the fallback.
- **No OPFS store.** The origin private file system shares IndexedDB's quota and eviction, so it
  would not keep data any longer; IndexedDB is enough for a few MB of vectors.
- **Server sync is a recipe, not a feature.** An `ExampleStore` is five methods; the guide shows a
  write-through wrapper. Shipping one would mean choosing an auth and conflict model for apps.
- **Embeddings are personal data.** Embedding inversion (Morris et al., 2023) recovers much of a
  short text from some models' embeddings. The guide says to treat snapshots like the inputs.

### 5. Tooling and onboarding

- **`simulateLearning()`** in `belay-learn` streams labeled inputs through the real `task()` and
  `learnedClassifier()` and returns the local share and accuracy, overall and as a learning
  curve. `examples/scripts/learn-simulate.mjs` now uses it.
- **`belay seed`** and **`belay simulate`** in `belay-calibrate` wrap `buildSeed()` and
  `simulateLearning()`, reading the schema from the same `belay.config.mjs` as `belay calibrate`
  and an optional `learn` section (embedder, classifier options, threshold, explore). One CLI for
  everything a developer runs before shipping; `@huggingface/transformers` is an optional peer
  dependency, loaded only by these two commands.
- **`examples/learned-quickstart/`** is a complete app: one page and a small server that proxies
  escalations to Claude. Without credentials, the page asks the developer for the label instead,
  so the loop can be tried with no API key. It shows IndexedDB, persistent storage, corrections,
  export, import and reset.
- **The guide** starts with a five-minute path (the quickstart, or an import map with no build
  step), and adds chapters on evaluating a task first, keeping what it learns, choosing the
  threshold and choosing what to spot-check, and an FAQ.

## Results

`examples/scripts/learn-simulate.mjs` streams each task's held-out inputs through
`simulateLearning()` at threshold 0.9 and `explore: 0.05`, from a cold start, with each spot-check
strategy, with and without the gate. Teachers: the dataset's labels ("always right"), or those
labels flipped as often as the task's calibrated cloud model was wrong. The rows with uniform spot
checks and no gate reproduce ADR 0004's results exactly, so the refactor onto
`simulateLearning()` changed nothing else.

| Task | Teacher | Spot checks | Gate | On device | Accuracy on device | Accuracy | Gated |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ticket triage | always right | uniform | – | 87.1% | 99.5% | 99.6% | |
| Ticket triage | always right | uniform | ✓ | 85.9% | 99.7% | 99.7% | 20 |
| Ticket triage | always right | informative | – | 86.7% | 99.8% | 99.9% | |
| Ticket triage | always right | informative | ✓ | 85.6% | 99.8% | 99.8% | 25 |
| Ticket triage | 94.3% right | uniform | – | 78.2% | 100.0% | 99.0% | |
| Ticket triage | 94.3% right | uniform | ✓ | 77.3% | 99.9% | 98.9% | 38 |
| Ticket triage | 94.3% right | informative | – | 81.3% | 99.9% | 99.0% | |
| Ticket triage | 94.3% right | informative | ✓ | 72.7% | 100.0% | 98.4% | 42 |
| Content moderation | always right | uniform | – | 27.4% | 96.0% | 98.9% | |
| Content moderation | always right | uniform | ✓ | 25.2% | 96.0% | 99.0% | 35 |
| Content moderation | always right | informative | – | 26.8% | 95.9% | 98.9% | |
| Content moderation | always right | informative | ✓ | 25.0% | 96.0% | 99.0% | 36 |
| Content moderation, by label | always right | uniform | – | 78.9% | 99.5% | 99.6% | |
| Content moderation, by label | always right | uniform | ✓ | 76.1% | 98.9% | 99.2% | 8 |
| Content moderation, by label | always right | informative | – | 77.5% | 99.7% | 99.8% | |
| Content moderation, by label | always right | informative | ✓ | 74.8% | 99.1% | 99.3% | 8 |
| Intent detection | always right | uniform | – | 87.5% | 97.5% | 97.8% | |
| Intent detection | always right | uniform | ✓ | 84.8% | 98.6% | 98.8% | 23 |
| Intent detection | always right | informative | – | 86.9% | 98.4% | 98.6% | |
| Intent detection | always right | informative | ✓ | 82.3% | 99.3% | 99.4% | 22 |
| Intent detection | 99.7% right | uniform | – | 87.5% | 97.5% | 97.7% | |
| Intent detection | 99.7% right | uniform | ✓ | 85.3% | 98.6% | 98.6% | 22 |
| Intent detection | 99.7% right | informative | – | 86.4% | 98.4% | 98.5% | |
| Intent detection | 99.7% right | informative | ✓ | 80.2% | 99.3% | 99.3% | 22 |

- **The gate** trades 0.1–2.8 points of local share (with uniform spot checks) for fewer confident
  mistakes where there were some (intents: 2.2% → 1.2% of all inputs answered wrongly on the
  device), and does not help when the labels change among similar inputs (the sorted moderation
  stream).
- **Informative spot checks** are not consistently better than uniform ones at a 5% rate on
  these streams. With at most 80 explored runs per stream, which runs are explored likely
  matters less than the escalations below the threshold, which already are the uncertain ones.
- **The gate and informative spot checks together** cost the most local share (ticket triage
  with a noisy teacher: 72.7%, against 77.3% with the gate alone).

## Prior art

- **Margin sampling and query by committee** as the policy for which requests go to the LLM:
  [Cache & Distil](https://aclanthology.org/2024.findings-acl.704/) (Ramírez et al., 2024). Margin
  was best without retraining, QBC the most robust with it.
- **Importance-weighted active learning**:
  [Beygelzimer, Dasgupta & Langford, 2009](https://arxiv.org/abs/0812.4952). Queried labels are
  weighted by the inverse of their query probability, with a minimum probability, so estimates
  from the queried sample stay unbiased.
- **Distance gates**: [OCaTS](https://arxiv.org/abs/2310.13395) (Stogiannidis et al., 2023)
  trusts its kNN student only when the input is close to its neighbors; [Sun et al.,
  2022](https://proceedings.mlr.press/v162/sun22d.html) showed the k-th nearest neighbor
  similarity on normalized features is a strong, assumption-free out-of-distribution score.
- **Reject option and deferral**: [Chow, 1970](https://doi.org/10.1109/TIT.1970.1054406);
  [Mozannar & Sontag, 2020](https://proceedings.mlr.press/v119/mozannar20b.html);
  [Online Cascade Learning](https://proceedings.mlr.press/v235/nie24a.html) (Nie et al., 2024).
- **Persisting models in the browser**: TensorFlow.js
  [save handlers](https://www.tensorflow.org/js/guide/save_load); Teachable Machine's export;
  MDN on [storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria);
  WebKit's [7-day cap on script-writable storage](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/).
- **Embedding inversion**: [Morris et al., 2023](https://arxiv.org/abs/2310.06816) (vec2text).

## Consequences

- `ExploreOptions` gains `strategy` and `floor`, `LocalOutput` gains `informativeness`,
  `LearnExample` and `RunEvent` gain `explorationWeight`. All optional: existing runners and
  dashboards are unaffected, and `uniform` exploration behaves as before.
- The distance gate is on by default, so the classifier answers slightly fewer inputs locally
  than ADR 0004's once it has 30 examples. `distanceGate: false` restores the old behavior.
- In `belay.config`, a task's `local` and `cloud` are optional: `belay seed` and `belay simulate`
  only need the schema, and `belay calibrate` says when they are missing.
- `belay-calibrate` depends on `belay-learn`. It does not load transformers.js unless `belay seed`
  or `belay simulate` runs.
- Snapshot files are a format: a later change to them needs a new `version` and a migration in
  `parseLearnedState()`.
