# A local classifier that learns from the cloud

`@swissspidy/belay-learn` is a Belay local runner that gets better as your app runs. Inputs it
is sure about are answered in the browser; the rest go to the cloud, and it learns from the
cloud's answer. This guide gets you started, explains how it works, and covers keeping what it
learns. The design decisions are in [ADR 0004](adr/0004-learning-from-escalations.md) and
[ADR 0005](adr/0005-choosing-what-to-ask-and-keeping-what-it-learns.md). To see it working, open
the [demo](https://swissspidy.github.io/belay/learn/).

- [Get started in five minutes](#get-started-in-five-minutes)
- [How it works](#how-it-works)
- [When to use it](#when-to-use-it)
- [How to add it to your app](#how-to-add-it-to-your-app)
- [Try it on your data first](#try-it-on-your-data-first)
- [Keeping what it learns](#keeping-what-it-learns)
- [Choosing the threshold](#choosing-the-threshold)
- [Choosing what to spot-check](#choosing-what-to-spot-check)
- [Tuning](#tuning)
- [Watching it in production](#watching-it-in-production)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Prior art](#prior-art)

## Get started in five minutes

**Run the quickstart.** [`examples/learned-quickstart/`](../examples/learned-quickstart/) is a
complete app in one HTML page and a 100-line server:

```sh
git clone https://github.com/swissspidy/belay && cd belay
npm install && npm run build
node examples/learned-quickstart/server.mjs      # open http://localhost:8787
```

With `ANTHROPIC_API_KEY` set, escalations go to Claude through the server. Without it, *you* are
the cloud: when the classifier is unsure, the page asks you for the label and learns from your
answer. After about 40 messages it starts answering on its own. Reload the page and it still
knows what it learned.

**Or add it to a page without a build step.** An import map is enough:

```html
<script type="importmap">
{ "imports": {
  "@swissspidy/belay-core": "https://cdn.jsdelivr.net/npm/@swissspidy/belay-core@0.2/dist/index.js",
  "@swissspidy/belay-learn": "https://cdn.jsdelivr.net/npm/@swissspidy/belay-learn@0.2/dist/index.js",
  "@huggingface/transformers": "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0"
} }
</script>
<script type="module">
import { fetchAdapter, task } from '@swissspidy/belay-core';
import { indexedDbStore, learnedClassifier, transformersEmbedder } from '@swissspidy/belay-learn';

const triage = task({
  name: 'ticket-triage',
  schema: { type: 'categorical', prompt: 'Which team should handle this message?',
            options: ['account', 'billing', 'order', 'shipping', 'feedback'] },
  local: learnedClassifier({ embedder: transformersEmbedder(), store: indexedDbStore() }),
  cloud: fetchAdapter({ url: '/api/belay' }),   // your backend asks the LLM
  threshold: 0.9,
  explore: 0.05,
});
button.onclick = () => triage.prepare();        // downloads the 34 MB model once
const { value, source } = await triage.run('I was charged twice');
</script>
```

**Then, in this order:**

1. [Simulate it on your own labeled data](#try-it-on-your-data-first) (`belay simulate`) to see
   whether your task suits it and how many cloud calls it saves.
2. [Ship a seed](#3-optional-ship-a-seed) (`belay seed`) so it answers from the first run.
3. [Decide how long it keeps what it learns](#keeping-what-it-learns): IndexedDB, persistent
   storage, and export or sync if it must survive a cleared browser.

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
first examples. A [seed file](#3-optional-ship-a-seed) of 30 or more labeled examples skips this
phase.

**Exploration.** Once the classifier is confident, the cloud stops seeing those inputs, so
nothing would tell it if it were wrong. With `explore: 0.05`, 5% of confident runs still go to
the cloud. Their answers keep the calibration honest and teach the classifier where it is most
sure. If the inputs change (a new product, new phrasing), the explored runs disagree, the
confidence drops, and the cloud takes over again until the classifier has relearned.

**Unusual inputs.** A vote among neighbors can be unanimous even when all of them are far away.
Once it has 30 examples, an input farther from its stored examples than almost all of them are
from each other goes to the cloud regardless (the [distance gate](#choosing-what-to-spot-check)).

**Privacy.** Learning happens on the user's device, from that user's escalations. Inputs are
stored as vectors, never as text, in memory or in IndexedDB. Embeddings can be partly inverted
back into text, so treat them as sensitive. Each user's classifier is their own; nothing is
pooled on a server unless you [sync it](#keeping-what-it-learns).

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

If you have labeled examples, embed them at build time. The seed carries a scored prediction for
each example (leave-one-out), so with at least 30 examples, 3 or more per label, the classifier
can answer from its first run, already calibrated. A smaller seed only shortens the cold start:
until there are 30 scored predictions, everything still goes to the cloud.

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

## Try it on your data first

Before shipping, stream labeled examples through the classifier in the order your app would see
them, with the labels standing in for the cloud. `belay simulate` (in
`@swissspidy/belay-calibrate`) does that with the real `task()` and the same embedding model the
page uses:

```sh
npm install --save-dev @swissspidy/belay-calibrate @huggingface/transformers
npx belay simulate --task ticket-triage --data data/stream.jsonl
```

It reads the task's schema from `belay.config.mjs`, the same file `belay calibrate` uses, plus
an optional `learn` section in the task:

```js
// belay.config.mjs
import { schema } from './src/triage.js';
export default {
  tasks: {
    'ticket-triage': {
      schema,
      // local, cloud: only `belay calibrate` needs them
      learn: { threshold: 0.9, explore: 0.05 },   // optional: embedder, classifier options
    },
  },
};
```

The data is JSONL, one `{"input": "...", "label": "..."}` per line. The output is a learning
curve:

```
Inputs         On device   Accurate    Overall   Cloud calls
1–100             21.0%     100.0%     100.0%        79
101–200           54.0%     100.0%     100.0%        46
…
Learned        146 examples (knn head), distance gate 0.613, 10 gated
```

*On device* is the share it answered itself; *Accurate* is how often those answers matched the
labels. Useful flags:

- `--seed belay-seed.json` starts from a seed.
- `--threshold 0.95` trades cloud calls for accuracy.
- `--teacher-accuracy 0.9` simulates a cloud that is wrong 10% of the time.
- `--strategy informative` changes which runs are [spot-checked](#choosing-what-to-spot-check).

If *Accurate* stays below your threshold, or *On device* stays near zero, the task is beyond what
embeddings can tell apart; keep it in the cloud. In code, `simulateLearning()` from
`@swissspidy/belay-learn` does the same, for tests or your own scripts.

## Keeping what it learns

Everything it learned lives in the [store](#2-define-the-task): examples (embeddings and labels)
and the record its confidence is calibrated on. Where and how long that survives is your choice.

| What you want | Use |
| --- | --- |
| Start fresh on every page load (tests, demos) | the default `memoryStore()` |
| Keep it across reloads and visits | `indexedDbStore()` |
| Ask the browser not to clear it under storage pressure | `persistStorage()` |
| A backup, or move it to another browser or device | `exportState()` / `importState()` |
| Share it across your users | `exportSeed()`, rebuilt into a [seed](#3-optional-ship-a-seed) you ship |
| Keep it on your server | a custom `ExampleStore` |

**IndexedDB.** `indexedDbStore({ name })` keeps one store per task, schema and embedding model.
Changing the schema or the model starts a new, empty scope on purpose: the old vectors don't fit
the new labels or model. About 0.5 KB per example, so the default cap of 5,000 examples is about
2.5 MB.

**The browser can still delete it.** Storage is *best-effort* by default: browsers evict a
site's data under storage pressure, and the user can clear it. Safari also deletes script-written
storage, IndexedDB included, for sites the user hasn't visited in 7 days of use, unless the site
is installed to the home screen. To ask for *persistent* storage:

```ts
import { persistStorage } from '@swissspidy/belay-learn';

const { persisted, usage, quota } = await persistStorage();
if (!persisted) showExportHint();   // keep a copy some other way
```

Chrome and Edge grant it without a prompt to sites the user engages with (bookmarked, installed,
visited often); Firefox asks the user; Safari grants it to home-screen web apps. Ask after the
user has used the feature, not on page load.

**Snapshots.** `exportState()` returns a JSON-serializable snapshot: the examples (int8
embeddings, no text), their labels and sources, and the calibration record. `importState()`
restores one:

```ts
// Back up
const snapshot = await local.exportState('ticket-triage');
await fetch('/api/belay-state', { method: 'PUT', body: JSON.stringify(snapshot) });

// Restore, e.g. on a new device after sign-in
const saved = await fetch('/api/belay-state').then((r) => r.json());
const { examples } = await local.importState(saved);           // merges
await local.importState(saved, { replace: true });             // or replaces
```

A merge keeps both sides; for the same input, a user's correction wins over a cloud answer. A
snapshot from another embedding model is rejected (`BelayError` code `invalid-task`), and one for
another schema lands in that schema's scope, not this one. Snapshots for tasks the page hasn't run
yet are fine. The [quickstart](../examples/learned-quickstart/) has export, import and reset
buttons.

**Your own store.** An `ExampleStore` is five async methods (`load`, `put`, `delete`, `putMeta`,
`clear`), keyed by a scope string. Wrap `indexedDbStore()` to write through to a server:

```ts
import { indexedDbStore, type ExampleStore } from '@swissspidy/belay-learn';

function syncedStore(): ExampleStore {
  const local = indexedDbStore();
  return {
    ...local,
    async put(scope, examples) {
      await local.put(scope, examples);
      void fetch(`/api/belay/${encodeURIComponent(scope)}`, { method: 'POST', body: JSON.stringify(examples) });
    },
  };
}
```

**Treat it as personal data.** The store holds no text, but embeddings can be partly inverted
back into it ([Morris et al., 2023](https://arxiv.org/abs/2310.06816) recovered most of short
texts' words from some embedding models). An exported snapshot or a synced store is as sensitive
as the inputs: send it only over channels and to places you would send the inputs. `local.reset()`
deletes everything learned (a seed stays).

## Choosing the threshold

The confidence is a calibrated probability of being right, so the threshold can come from what
mistakes cost rather than from a dataset. Answering locally costs `(1 − p) × errorCost` in
expectation; escalating costs a cloud call plus the cloud's own mistakes. `costAwareThreshold()`
(in core) returns the threshold where the two break even:

```ts
import { costAwareThreshold } from '@swissspidy/belay-core';

const threshold = costAwareThreshold({
  errorCost: 0.5,      // what a misrouted ticket costs you, e.g. in support time (USD)
  cloudCost: 0.002,    // one cloud call (USD)
  cloudAccuracy: 0.97, // the cloud model's accuracy on this task
});
// 0.97 − 0.002 / 0.5 = 0.966
```

Or pass `calibration` (a `belay.calibration.json`) to read the cloud's cost and accuracy from it.
The cheaper a mistake relative to a call, the lower the threshold. It never goes above the
cloud's own accuracy: the cloud can't be more right than that. This is Chow's reject rule; the
[ADR](adr/0005-choosing-what-to-ask-and-keeping-what-it-learns.md#a-cost-aware-threshold) has
the derivation.

## Choosing what to spot-check

`explore` sends some confident runs to the cloud anyway, to keep the confidence honest and catch
drift. Two strategies:

- **`uniform`** (the default, `explore: 0.05`): every confident run has the same 5% chance. Simple,
  and the agreement rate on explored runs is an unbiased estimate of the local accuracy.
- **`informative`** (`explore: { rate: 0.05, strategy: 'informative' }`): runs where the
  classifier is least sure of its top label, or where its two heads disagree, are checked more
  often. The average rate stays about 5%, and every confident run keeps at least `rate × floor`
  (default 20% of the rate) so that nothing goes unchecked. The cloud answers of rarely-checked
  runs carry a larger `explorationWeight` (rate / probability), which the calibration uses so
  that its estimate stays unbiased.

STRATEGY_RESULT

**The distance gate.** Separately from exploration, an input far from everything the classifier
has stored goes to the cloud even if its neighbors agree. The gate scores an input by its
similarity to the 5th nearest stored example, and passes it when that is at least as close as
95% of the stored examples are to their own neighbors. It is on by default once there are 30
examples; `stats().gate` shows its threshold and how many inputs it sent to the cloud.
`distanceGate: false` turns it off.

GATE_RESULT

## Tuning

| Option | Default | Raise it to… | Lower it to… |
| --- | --- | --- | --- |
| task `threshold` | | answer locally only when very sure (more cloud calls) | keep more on device, accepting more mistakes (or use [`costAwareThreshold()`](#choosing-the-threshold)) |
| task `explore` (`rate`) | 0 | catch drift sooner and learn faster where it is confident | save the extra cloud calls (0.02–0.05 is a good range) |
| `explore.strategy`, `explore.floor` | `'uniform'`, 0.2 | | see [spot checks](#choosing-what-to-spot-check) |
| `distanceGate` | `{ k: 5, quantile: 0.05, minSamples: 30 }` | `quantile`: send more unusual inputs to the cloud | `quantile`: keep more on device; `false` turns it off |
| `minExamples`, `minPerLabel` | 10, 3 | wait longer before answering | answer sooner (or ship a seed) |
| `calibration.minPairs` | 30 | demand more evidence before trusting itself | |
| `calibration.halfLife` | 50 | steadier confidence on stable inputs | react to drift faster |
| `knn.k` | 7 | smooth over noisy labels | follow rare cases more closely |
| `head` | `'auto'` | | pin `'knn'` for the lowest CPU use |
| `minCloudConfidence` | 0 | skip cloud answers the cloud itself was unsure of (needs an adapter that reports confidence) | |
| `maxExamples` | 5,000 | | cap memory and IndexedDB use |

The threshold is a target probability, not a number fitted to a dataset. `belay calibrate` fits
thresholds for fixed local runners; for a learned classifier, [`belay
simulate`](#try-it-on-your-data-first) shows what a threshold does on your data.

The classifier can only be as right as the labels it learns from. Its confidence measures
agreement with the cloud's answers and users' corrections, so with a noisy cloud it stays more
cautious. In the simulation, against a teacher right 83.7% of the time, it kept almost every
comment in the cloud. Systematic cloud mistakes are learned as if they were right; corrections
are the way to fix them.

## Watching it in production

```ts
const stats = await local.stats();
// { examples, seedExamples, perLabel: { billing: 41, … }, head: 'knn', ready: true,
//   heads: { knn: { pairs, recentAccuracy, … }, softmax: { … } },
//   gate: { threshold: 0.61, samples: 146, gated: 10 }, pending, version }
```

The task's run events say what happened on each run, without the input text:

- `source` and `escalationReason` give you the local share over time.
- On `exploration` runs, `label` (the cloud's) and `localLabel` show whether the device agreed.
  A falling agreement rate means the inputs have drifted. Under `informative` exploration, weigh
  each run by its `explorationWeight` to estimate the local accuracy.
- `stats().gate.gated` counts the inputs the distance gate sent to the cloud. When you call the
  runner directly, its output's `raw.gate` is `'distance'` for those.
- `savingsMeter()` counts explored runs in `explored`, and their cost in `cloudSpend`.

## Troubleshooting

- **Every run escalates with `local-unavailable`.** The model isn't loaded (call `prepare()`), or
  the classifier has no examples yet. The first cloud answers fix the second case.
- **Every run escalates with `low-confidence`.** It is in the cold start, or its record says it
  can't reach the threshold on this task. Check `stats().heads.*.recentAccuracy`. If that stays
  below the threshold, the task is beyond what embeddings can tell apart; keep it in the cloud.
- **Inputs it should know go to the cloud.** Check `stats().gate.gated`. With few or very similar
  examples the gate is strict; it relaxes as varied examples arrive. Lower `distanceGate.quantile`
  or turn it off if `belay simulate` shows it costs you more than it saves.
- **`local-error` with "seed file was made with embedder …".** The seed was built with a
  different model, dtype or pooling than the page's `transformersEmbedder()`. Rebuild it with the
  same options (`belay seed` uses `learn.embedder` from the config).
- **It forgot everything after a reload.** The default store is in memory; pass
  `indexedDbStore()`. Changing the schema or the embedding model starts a new store scope on
  purpose: old vectors don't fit.
- **It forgot everything after a week (Safari) or a full disk.** The browser evicted it. See
  [keeping what it learns](#keeping-what-it-learns).
- **The page stutters while learning.** The softmax head retrains in short steps between
  frames. On slow devices, use `head: 'knn'`.
- **Learning errors** arrive as `error` events with stage `learn` (for example, a full IndexedDB
  quota). The run's answer is unaffected.

## FAQ

**Does it work offline?** Once the model is cached and it has learned, yes: confident inputs are
answered without the network. The rest escalate, and fail like any cloud call when offline.

**Does it work in Node or a worker?** The classifier, `simulateLearning()` and `buildSeed()` run
in Node (`belay seed` and `belay simulate` do). `indexedDbStore()` needs IndexedDB, so in Node
use `memoryStore()` or your own store. In a worker it works as in a page.

**Can my users share one model?** Not live: each browser learns from its own escalations. To pool
what they learned, collect snapshots (with consent; see the privacy note above), and ship a seed
built from them in the next release.

**Can I use another embedding model?** Pass `transformersEmbedder({ model, dtype, pooling })`, or
any object implementing `Embedder`. Multilingual models (such as
`Xenova/multilingual-e5-small`) suit non-English inputs. Seeds and snapshots record the model and
are rejected by a different one.

**Does it learn from what it answered itself?** No. Only cloud answers and users' corrections
teach it: learning from its own answers would reinforce its mistakes.

**What does it cost in the page?** A 34 MB model download, once; one forward pass of a small
model per run (the [demo](https://swissspidy.github.io/belay/learn/) shows the time on your
device); about 0.5 KB of storage per example.

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

Three ideas from this work are now options: margin and committee-based spot checks (Cache &
Distil), the distance gate (OCaTS, and the k-th nearest neighbor score of [Sun et al.,
2022](https://proceedings.mlr.press/v162/sun22d.html)), and a cost-aware threshold (OCaTS's
objective; [Chow, 1970](https://doi.org/10.1109/TIT.1970.1054406)). See
[ADR 0005](adr/0005-choosing-what-to-ask-and-keeping-what-it-learns.md).
