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

`explore: { rate, strategy: 'informative', floor }` spends the same average budget as `rate` but
skews it towards the runs the local runner is least sure of. A local runner may report
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
underestimate the local accuracy. So:

- **A floor.** Every confident run keeps probability at least `rate × floor` (default 0.2), so
  none is unobservable: importance weighting needs a probability bounded away from 0 (IWAL's
  `p_min`).
- **Importance weights.** An explored run carries `explorationWeight = rate / p` on its
  `LearnExample` and its run event. The learned classifier multiplies the weight of the
  calibration pair it records for that run (clipped to [0.05, 20]); dashboards weigh agreement by
  it. A run explored with probability `rate` has weight 1, so `uniform` is unchanged.

The default stays `uniform`. RESULT_STRATEGY

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
  Sun et al. report. It is computed on up to 300 stored examples and recomputed when the example
  count has moved by 10%, which keeps it at O(300 × n) per refresh.
- **Off until 30 examples:** with fewer, the leave-one-out scores are too few and too far apart
  to say what "unusual" means.
- **On by default**, `distanceGate: false` to disable, a number for a fixed threshold, or
  `{ k, quantile, minSamples }`.

A first version scored each input on arrival against the examples before it. That baseline was
skewed low by the early, sparse examples and gated almost nothing later on; the leave-one-out
quantile over the current examples tracks the store as it grows.

RESULT_GATE

### 3. A cost-aware threshold, as a helper

With a calibrated confidence p, answering locally costs `(1 − p) × C_err` in expectation and
escalating costs `C_call + (1 − a_cloud) × C_err`. Accepting locally is cheaper iff

    p ≥ a_cloud − C_call / C_err

Chow's (1970) reject rule, with the cloud as the reject option. OCaTS's objective, accuracy minus
λ × the share of LLM calls, is the same rule with `λ = C_call / C_err` and a perfect cloud.

`costAwareThreshold({ errorCost, cloudCost, cloudAccuracy, calibration })` in the core returns
that threshold, reading the cloud's cost and accuracy from a calibration file when given one. It
is a helper that computes a number for `threshold`, not a new mode: the threshold keeps one
meaning for every runner, and only a runner with calibrated confidence (the learned classifier)
makes the formula exact. Learning the deferral policy online (Online Cascade Learning; learning to
defer, Mozannar & Sontag 2020) would need the error cost at run time, which apps rarely have.

### 4. Keeping what it learns

- **Snapshots.** `exportState(task)` returns a versioned JSON document (`kind:
  'belay-learn-state'`, `version: 1`): the task, schema fingerprint and embedder id, the examples
  (int8 embeddings, label, source, time; no text) and the calibration pairs of both heads.
  `importState(snapshot, { replace })` merges into the store (a user's correction wins over a
  cloud answer for the same input) or replaces it, then reloads the task if it is loaded. A
  snapshot from another embedder is rejected; one for another schema lands in that schema's
  scope. This mirrors TensorFlow.js's model save handlers (`indexeddb://`, `downloads://`, HTTP),
  and Teachable Machine's export, for a model that is mostly data.
- **`persistStorage()`** asks for persistent storage (`navigator.storage.persist()`) and reports
  usage and quota. Best-effort storage is evicted under pressure, and Safari deletes
  script-written storage after 7 days without a visit unless the site is installed. The guide
  says when to ask, and that export is the fallback.
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

RESULT_TABLE

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
- `belay-calibrate` depends on `belay-learn`. It does not load transformers.js unless `belay seed`
  or `belay simulate` runs.
- Snapshot files are a format: a later change to them needs a new `version` and a migration in
  `parseLearnedState()`.
