# A local classifier that learns from the cloud

`@swissspidy/belay-learn` is a Belay local runner that gets better as your app runs. This guide
explains how it works and how to add it to an app. The design decisions and their trade-offs are
in [ADR 0004](adr/0004-learning-from-escalations.md). To see it working, open the
[demo](https://swissspidy.github.io/belay/learn/).

- [How it works](#how-it-works)
- [When to use it](#when-to-use-it)
- [How to add it to your app](#how-to-add-it-to-your-app)
- [Tuning](#tuning)
- [Watching it in production](#watching-it-in-production)
- [Troubleshooting](#troubleshooting)
- [Prior art](#prior-art)

## How it works

A Belay task runs a local model first and sends the input to the cloud when the local answer's
confidence is below the threshold. With a fixed local model, such as Chrome's Classifier API,
the cloud's answer is used once and thrown away. The learned classifier keeps it as a training
example:

```
          input
            │
            ▼
  embed on the device ──► classify ──► confidence ≥ threshold? ── yes ──► answer locally
  (bge-small, 34 MB)     (kNN or                  │                     (5% still go to the
                          softmax head)           no                     cloud: "explore")
                               ▲                  ▼
                               │            ask the cloud ──► answer
                               │                  │
                               └── learn (input embedding, cloud's label) ◄┘
                                   users' corrections count 3×
```

**Embeddings.** Each input becomes a 384-number vector from a small sentence-embedding model
that runs in the page through [transformers.js](https://huggingface.co/docs/transformers.js), on
WebGPU or WebAssembly. Texts with similar meanings get nearby vectors, so "I was charged twice"
lands next to "refund the double payment". The model downloads once (about 34 MB) and is then
read from the browser cache.

**The head** turns a vector into a label:

- *k-nearest neighbors* works from the first example: the 7 most similar stored examples vote,
  and closer ones count more.
- *A softmax layer* (logistic regression) is trained in the background once there are 50
  examples. It generalizes better when a label covers varied wording.

Both heads predict every input. In `auto` mode, the one that was right more often on recent
inputs answers.

**Confidence.** A raw score such as "0.97 of the neighbors' votes" is not a probability of being
right. The classifier calibrates it on its own track record. Each time a label arrives for an
input it had already predicted (a cloud answer, or a user's correction), it records whether that
prediction was right, *before* learning the input. Platt scaling then maps raw scores to
P(correct) from those records, with recent ones weighted most. So `threshold: 0.9` keeps meaning
"answer locally when at least 90% likely right", at the first example and the thousandth.

**Cold start.** Until there are 10 examples, 3 of them for the predicted label, and 30 scored
predictions, the confidence is 0 and everything goes to the cloud. That is how it collects its
first examples. A [seed file](#3-optional-ship-a-seed) skips this phase.

**Exploration.** Once the classifier is confident, the cloud stops seeing those inputs, so
nothing would tell it if it were wrong. With `explore: 0.05`, 5% of confident runs still go to
the cloud. Their answers keep the calibration honest and teach the classifier where it is most
sure. If the inputs change (a new product, new phrasing), the explored runs disagree, the
confidence drops, and the cloud takes over again until the classifier has relearned.

**Privacy.** Learning happens on the user's device, from that user's escalations. Inputs are
stored as vectors, never as text, in memory or in IndexedDB. Embeddings can be partly inverted
back into text, so treat them as sensitive. Each user's classifier is their own; nothing is
pooled on a server.

## When to use it

It suits tasks where:

- the same kind of input arrives many times, so there is a lot to learn from;
- the labels are about *what the text is about* (routing, intents, topics, categories), which is
  what embeddings capture well;
- each cloud call has a cost or latency worth saving, and some inputs are sensitive enough that
  keeping them on the device matters.

It is a poor fit when:

- the label depends on tone, subtle wording or world knowledge. Embeddings separate toxic from
  civil comments at about 70%; on that task the classifier answered about a third of comments
  and left the rest to the cloud;
- the task generates text (use `promptApi()` and a judge instead);
- each user sees only a handful of inputs. It learns per device, so they never reach the cold
  start's 10 examples. Ship a seed instead.

In the [simulation](../examples/README.md#learned-classifier), starting from nothing at threshold
0.9, it answered 87% of 1,500 ticket-triage messages on the device at 99.5% accuracy, and 87% of
1,467 voice-assistant intents at 97.5%.

## How to add it to your app

### 1. Install

```sh
npm install @swissspidy/belay-core @swissspidy/belay-learn @huggingface/transformers
```

`@huggingface/transformers` is an optional peer dependency: only `transformersEmbedder()` loads
it, with a dynamic import, so it lands in its own chunk with most bundlers.

### 2. Define the task

```ts
import { task, fetchAdapter } from '@swissspidy/belay-core';
import { indexedDbStore, learnedClassifier, transformersEmbedder } from '@swissspidy/belay-learn';

export const schema = {
  type: 'categorical',
  prompt: 'Which team should handle this customer message?',
  options: ['account', 'billing', 'order', 'shipping', 'feedback'],
} as const;

const local = learnedClassifier({
  embedder: transformersEmbedder(),   // Xenova/bge-small-en-v1.5
  store: indexedDbStore(),            // keep what it learned across reloads
  seed: '/belay-seed.json',           // optional, see step 3
});

export const triage = task({
  name: 'ticket-triage',
  schema,
  local,
  cloud: fetchAdapter({ url: '/api/belay' }), // your backend calls the LLM
  threshold: 0.9,
  explore: 0.05,
});
```

The cloud side is the same as for any Belay task. See the main
[README](../README.md#cloud-adapters).

### 3. Optional: ship a seed

If you have labeled examples, embed them at build time. The classifier then answers from its
first run, already calibrated:

```ts
// scripts/build-seed.mjs, run in Node with the same model the page uses
import { writeFile } from 'node:fs/promises';
import { buildSeed, transformersEmbedder } from '@swissspidy/belay-learn';
import { schema } from '../src/triage.js';
import labeled from '../data/labeled.json' with { type: 'json' };

const seed = await buildSeed({
  task: 'ticket-triage',
  schema,
  embedder: transformersEmbedder(),
  examples: labeled.map((e) => ({ input: e.text, value: e.team })),
});
await writeFile('public/belay-seed.json', JSON.stringify(seed));
```

A seed stores about 0.5 KB per example (int8 vectors, no text). A seed made with another
embedding model or for another schema is rejected, with an `error` event at stage `local`.
`local.exportSeed()` turns what a classifier learned during development into a seed too.

[`examples/scripts/build-seeds.mjs`](../examples/scripts/build-seeds.mjs) is a working example.

### 4. Load the model

`run()` never downloads a model. The first time, download it from a user gesture. On later
visits it loads from the browser cache without one:

```ts
if ((await triage.availability()) === 'available') {
  await triage.prepare();               // cached: loads it, no download
} else {
  enableButton.onclick = () => triage.prepare({ onProgress: (p) => (progress.value = p) });
}
```

Until the model is loaded, runs escalate with `local-unavailable`. The classifier still learns
from those cloud answers: they wait in memory and are embedded on `prepare()`.

### 5. Run it, and let users correct it

```ts
const result = await triage.run(message);
show(result.value);

// When a user says the answer was wrong:
await triage.feedback(message, 'billing');
```

A correction weighs 3× a cloud answer, and a later cloud answer for the same input doesn't
override it. `feedback()` resolves to `false` for runners that can't learn, so the same UI works
with any runner.

## Tuning

| Option | Default | Raise it to… | Lower it to… |
| --- | --- | --- | --- |
| task `threshold` | | answer locally only when very sure (more cloud calls) | keep more on device, accepting more mistakes |
| task `explore` | 0 | catch drift sooner and learn faster where it is confident | save the extra cloud calls (0.02–0.05 is a good range) |
| `minExamples`, `minPerLabel` | 10, 3 | wait longer before answering | answer sooner (or ship a seed) |
| `calibration.minPairs` | 30 | demand more evidence before trusting itself | |
| `calibration.halfLife` | 50 | steadier confidence on stable inputs | react to drift faster |
| `knn.k` | 7 | smooth over noisy labels | follow rare cases more closely |
| `head` | `'auto'` | | pin `'knn'` for the lowest CPU use |
| `minCloudConfidence` | 0 | skip cloud answers the cloud itself was unsure of (needs an adapter that reports confidence) | |
| `maxExamples` | 5,000 | | cap memory and IndexedDB use |

The threshold is a target probability, not a number fitted to a dataset. `belay calibrate` fits
thresholds for fixed local runners. To evaluate a learned classifier on your data, stream your
labeled examples through it, as
[`examples/scripts/learn-simulate.mjs`](../examples/scripts/learn-simulate.mjs) does.

The classifier can only be as right as the labels it learns from. Its confidence measures
agreement with the cloud's answers and users' corrections, so with a noisy cloud it stays more
cautious. In the simulation, against a teacher right 83.7% of the time, it kept almost every
comment in the cloud. Systematic cloud mistakes are learned as if they were right; corrections
are the way to fix them.

## Watching it in production

```ts
const stats = await local.stats();
// { examples, seedExamples, perLabel: { billing: 41, … }, head: 'knn', ready: true,
//   heads: { knn: { pairs, recentAccuracy, … }, softmax: { … } }, pending, version }
```

The task's run events say what happened on each run, without the input text:

- `source` and `escalationReason` give you the local share over time.
- On `exploration` runs, `label` (the cloud's) and `localLabel` show whether the device agreed.
  A falling agreement rate means the inputs have drifted.
- `savingsMeter()` counts explored runs in `explored`, and their cost in `cloudSpend`.

## Troubleshooting

- **Every run escalates with `local-unavailable`.** The model isn't loaded (call `prepare()`), or
  the classifier has no examples yet. The first cloud answers fix the second case.
- **Every run escalates with `low-confidence`.** It is in the cold start, or its record says it
  can't reach the threshold on this task. Check `stats().heads.*.recentAccuracy`. If that stays
  below the threshold, the task is beyond what embeddings can tell apart; keep it in the cloud.
- **`local-error` with "seed file was made with embedder …".** The seed was built with a
  different model, dtype or pooling than the page's `transformersEmbedder()`. Rebuild it with the
  same options.
- **It forgot everything after a reload.** The default store is in memory; pass
  `indexedDbStore()`. Changing the schema or the embedding model starts a new store scope on
  purpose: old vectors don't fit.
- **The page stutters while learning.** The softmax head retrains in short steps between
  frames. On slow devices, use `head: 'knn'`.
- **Learning errors** arrive as `error` events with stage `learn` (for example, a full IndexedDB
  quota). The run's answer is unaffected.

## Prior art

The idea is not new, and this package doesn't claim it is. *Train a cheap student online on an
LLM's answers, and defer to the LLM when the student is unsure* is an established research
setting:

- **[Cache & Distil](https://aclanthology.org/2024.findings-acl.704/)** (Ramírez, Lindemann,
  Birch, Titov; Findings of ACL 2024) calls it *neural caching*. A student is retrained on an
  LLM's outputs and takes over more requests. For classification, active-learning policies
  (margin sampling, query by committee) chose best which requests to send to the LLM. Privacy is
  one of its motivations too.
- **[OCaTS](https://arxiv.org/abs/2310.13395)** (Stogiannidis, Vassos, Malakasiotis,
  Androutsopoulos; Findings of EMNLP 2023) is the closest to this package's kNN head. It caches
  LLM answers as training data for a kNN or MLP student, and trusts the student only when the
  input is close to its neighbors and the neighbors agree. The thresholds are tuned for a
  cost-aware objective.
- **[Online Cascade Learning](https://proceedings.mlr.press/v235/nie24a.html)** (Nie, Ding, Hu,
  Jermaine, Chaudhuri; ICML 2024) learns a cascade of small models (such as logistic regression)
  ending in an LLM over a stream. It learns the deferral policy as well, by online imitation of
  the LLM, with no-regret guarantees.

Related, but none of these trains a student from the LLM:

- *Routers and cascades* pick which fixed model answers:
  [FrugalGPT](https://arxiv.org/abs/2305.05176), [RouteLLM](https://arxiv.org/abs/2406.18665),
  and [Hybrid LLM](https://arxiv.org/abs/2404.14618), which routes between a small edge model and
  a cloud model. [Uncertainty-based two-tier selection](https://arxiv.org/abs/2405.02134) found
  the small model's own uncertainty a strong escalation signal, which is what Belay uses.
- *Semantic caches* such as [GPTCache](https://github.com/zilliztech/GPTCache), and
  [MeanCache](https://arxiv.org/abs/2403.02694) on the user's device, return stored answers for
  similar queries instead of learning a classifier.
- *In-browser classifiers on embeddings*: [Teachable Machine](https://teachablemachine.withgoogle.com/)
  and TensorFlow.js's [knn-classifier](https://github.com/tensorflow/tfjs-models/tree/master/knn-classifier)
  put a kNN head on a model's activations in the page, with labels a person provides.
  [SetFit](https://arxiv.org/abs/2209.11055) trains classification heads on sentence embeddings
  from a few examples.
- *Methods*: Platt scaling (Platt, 1999), prequential evaluation
  ([Dawid, 1984](https://www.jstor.org/stable/2981683)), uncertainty sampling
  ([Settles, 2009](https://research.cs.wisc.edu/techreports/2009/TR1648.pdf)) and ε-greedy
  exploration are all textbook.

What this package adds is packaging, not a new algorithm. As far as we found (npm and the
literature; GitHub search was not available to us):

- **In the user's browser:** transformers.js embeddings and IndexedDB storage, with no server.
- **Two teachers:** it learns from users' corrections as well as from the LLM.
- **Seed files:** labeled embeddings an app can ship.
- **Plugged into Belay:** the task's existing threshold, privacy policies (redaction, consent,
  `never`) and telemetry, so the cold start, calibration and escalation work as one unit.

Its confidence (Platt scaling on prequential pairs, weighted towards recent ones) is a
deliberate choice over the raw margin, entropy or distance gates most of these papers use: it
keeps the task's threshold a probability.

Ideas from this work that Belay doesn't use yet are listed in
[ADR 0004](adr/0004-learning-from-escalations.md#prior-art-and-future-work).
