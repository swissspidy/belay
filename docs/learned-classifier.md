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
node examples/learned-quickstart/server.mjs      # open http://127.0.0.1:8787
```

With `ANTHROPIC_API_KEY` set, escalations go to Claude through the server. Without it, *you* are
the cloud: when the classifier is unsure, the page asks you for the label and learns from your
answer. After 40 to 70 messages it starts answering on its own: it first needs 30 predictions it
can check against an answer. Tick *Start from the seed* to skip that. Reload the page and it still
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
document.querySelector('#enable').onclick = () => triage.prepare(); // downloads the 34 MB model once
// Before prepare(), and until it has learned, runs go to the cloud (escalationReason tells you why).
const { value, source } = await triage.run('I was charged twice');
</script>
```

`/api/belay` is [your backend](#your-backend): it receives the task's instruction and the input,
asks the LLM, and returns the label.

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
  civil comments at about 70%; on that task the classifier answered about a quarter of comments
  and left the rest to the cloud;
- the task generates text (use `promptApi()` and a judge instead);
- each user sees only a handful of inputs. It learns per device, so they never reach the cold
  start's 10 examples. Ship a seed instead.

In the [simulation](../examples/README.md#learned-classifier), starting from nothing at threshold
0.9, it answered 86% of 1,500 ticket-triage messages on the device at 99.7% accuracy, and 85% of
1,467 voice-assistant intents at 98.6%.

## How to add it to your app

### 1. Install

```sh
npm install @swissspidy/belay-core @swissspidy/belay-learn @huggingface/transformers
```

`@huggingface/transformers` is an optional peer dependency, so apps that bring their own
`Embedder` don't need it. `transformersEmbedder()` imports it by name at run time, which works with
an import map but not after bundling: with Vite, webpack or similar, pass the import yourself so
the bundler sees it (and puts it in its own chunk):

```ts
transformersEmbedder({ transformers: () => import('@huggingface/transformers') })
```

If `npm install` fails in `onnxruntime-node`'s postinstall (it downloads native binaries for
Node), `npm install --ignore-scripts` is enough for the browser; Node scripts such as
`belay seed` need the binaries.

### 2. Define the task

Put the schema in a module of its own, plain JavaScript, so that the app, the build scripts and
`belay.config.mjs` (which Node runs directly) all import the same object:

```js
// src/schema.js
export const schema = /** @type {const} */ ({
  type: 'categorical',
  prompt: 'Which team should handle this customer message?',
  options: ['account', 'billing', 'order', 'shipping', 'feedback'],
});
```

```ts
// src/triage.ts
import { task, fetchAdapter } from '@swissspidy/belay-core';
import { indexedDbStore, learnedClassifier, transformersEmbedder } from '@swissspidy/belay-learn';
import { schema } from './schema.js';

export const local = learnedClassifier({
  embedder: transformersEmbedder({ transformers: () => import('@huggingface/transformers') }), // Xenova/bge-small-en-v1.5
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

The cloud side is the same as for any Belay task. See [your backend](#your-backend) below, and the
main [README](../README.md#cloud-adapters) for other adapters.

### 3. Optional: ship a seed

If you have labeled examples, embed them at build time. The seed carries a scored prediction for
each example (leave-one-out), so with at least 30 examples, 3 or more per label, the classifier
can answer from its first run, already calibrated. A smaller seed only shortens the cold start:
until there are 30 scored predictions, everything still goes to the cloud.

```ts
// scripts/build-seed.mjs, run in Node with the same model the page uses
import { writeFile } from 'node:fs/promises';
import { buildSeed, transformersEmbedder } from '@swissspidy/belay-learn';
import { schema } from '../src/schema.js';
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

Or, without a script: `npx belay seed --task ticket-triage --data data/labeled.jsonl` (see
[below](#try-it-on-your-data-first)).
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

### Your backend

`fetchAdapter()` POSTs the request as JSON: the task's ready-made `instruction`, a `jsonSchema`
for the answer, the (redacted) `input`, and the local attempt. Respond with the answer as JSON:
the bare value or `{ "value": … }`. A handler with the Anthropic SDK, for any Node framework:

```js
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic(); // ANTHROPIC_API_KEY stays on the server

/** The body of POST /api/belay, in whatever framework you use. */
export async function belay({ instruction, input, jsonSchema }) {
  const response = await client.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    system: instruction,
    messages: [{ role: 'user', content: input }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: jsonSchema } },
  });
  const text = response.content.find((block) => block.type === 'text')?.text;
  if (!text) throw new Error(`no answer (stop_reason: ${response.stop_reason})`);
  return JSON.parse(text); // send this back as the JSON response
}
```

Authenticate the route like the rest of your API: anyone who can call it spends your credits.
[`examples/shared/cloud.mjs`](../examples/shared/cloud.mjs) adds refusal fallbacks and reports
token usage, so `savingsMeter()` can price the calls.

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
import { schema } from './src/schema.js';
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
storage, IndexedDB included, of sites the user hasn't interacted with (clicked or tapped) in the
last 7 days of Safari use, unless the site runs as a Home Screen web app. To ask for *persistent*
storage:

```ts
import { persistStorage } from '@swissspidy/belay-learn';

const { persisted, usage, quota } = await persistStorage();
if (!persisted) showExportHint();   // keep a copy some other way
```

Chrome and Edge grant it without a prompt to sites the user engages with (bookmarked, installed,
visited often); Firefox asks the user; Safari decides by heuristics, such as being a Home Screen
web app. Ask after the user has used the feature, not on page load.

**Snapshots.** `exportState()` returns a JSON-serializable snapshot: the examples (int8
embeddings, no text), their labels and sources, and the calibration record. `importState()`
restores one. `exportState()` needs the task loaded: call it after `prepare()` or a run.

```ts
// Back up
const snapshot = await local.exportState('ticket-triage');
await fetch('/api/belay-state', { method: 'PUT', body: JSON.stringify(snapshot) });

// Restore, e.g. on a new device after sign-in
const saved = await fetch('/api/belay-state').then((r) => r.json());
const { examples } = await local.importState(saved);           // merges
await local.importState(saved, { replace: true });             // or replaces
```

A merge keeps both sides, each scored prediction once (re-importing your own backup changes
nothing); for the same input, a user's correction wins over a cloud answer, and `maxExamples`
still applies. A snapshot is rejected (`BelayError` code `invalid-task`) if it was made with
another embedding model, has malformed embeddings, or is for another version of the schema of a
task the page runs; one for another schema of a task not loaded yet lands in that schema's scope.
Runs that start during an import wait for it. The [quickstart](../examples/learned-quickstart/) has export, import and reset
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

The confidence is a calibrated probability, so the threshold can come from what mistakes cost
rather than from a dataset. Escalating costs a cloud call plus the cloud's own mistakes; answering
locally costs a mistake whenever the device is wrong. `costAwareThreshold()` (in core) returns the
threshold where the two break even:

```ts
import { costAwareThreshold } from '@swissspidy/belay-core';

const threshold = costAwareThreshold({
  errorCost: 0.5,      // what a misrouted ticket costs you, e.g. in support time (USD)
  cloudCost: 0.002,    // one cloud call (USD)
  cloudAccuracy: 0.97, // the cloud model's accuracy on this task
});
// 1 − 0.002 / (0.97 × 0.5) ≈ 0.996
```

The learned classifier's confidence is the probability of *agreeing with the cloud*: the cloud's
answers are all it has to check itself against. So it counts a local answer as right only when it
agrees with a right cloud, and a fallible cloud asks for a higher threshold, not a lower one. For a
runner calibrated on labeled data (`belay calibrate`), pass `calibratedAgainst: 'labels'`: then
the confidence is the probability of being right, and the threshold is `cloudAccuracy − cloudCost
/ errorCost` (0.966 here). With an always-right cloud the two agree.

Pass `calibration` (a `belay.calibration.json`) to read the cloud's cost and accuracy from it. The
cheaper a mistake relative to a call, the lower the threshold. This is Chow's reject rule; the
[ADR](adr/0005-choosing-what-to-ask-and-keeping-what-it-learns.md#3-a-cost-aware-threshold-as-a-helper)
has the derivation.

## Choosing what to spot-check

`explore` sends some confident runs to the cloud anyway, to keep the confidence honest and catch
drift. Two strategies:

- **`uniform`** (the default, `explore: 0.05`): every confident run has the same 5% chance. Simple,
  and the agreement rate on explored runs is an unbiased estimate of how often the device agrees
  with the cloud on the inputs it answers.
- **`informative`** (`explore: { rate: 0.05, strategy: 'informative' }`): runs where the
  classifier is least sure of its top label, or where its two heads disagree, are checked more
  often. The rate stays about 5% (a little more, because of the floor: 4.6–6.4% of confident runs
  in the simulations), and every confident run keeps at least `rate × floor` (default 20% of the
  rate) so that nothing goes unchecked. The cloud answers of rarely-checked runs carry a larger
  `explorationWeight` (rate / probability), so the calibration sees the same mix of explored runs
  as with uniform spot checks.

On this repository's three streams, `informative` was not consistently better than `uniform`
([ablation](../examples/README.md#learned-classifier)): it helped on some (intents: 97.5% → 98.4%
accurate on the device) and cost local share on others. Keep `uniform` unless `belay simulate`
shows that `informative` helps on your data.

**The distance gate.** Separately from exploration, an input far from everything the classifier
has stored goes to the cloud even if its neighbors agree. The gate scores an input by its
similarity to the 5th nearest stored example, and passes it when that is at least as close as
all but the 5% least typical stored examples are to their own neighbors. It is on by default once
there are 30 examples; `stats().gate` shows its threshold and how many inputs it sent to the cloud.
`distanceGate: false` turns it off.

In the simulations, with uniform spot checks, it cost 0.1–2.8 points of local share (1.1–8.6
with informative ones) and removed many of the device's confident mistakes where there were some
(intents: from 2.2% of all inputs to 1.2%). It catches
inputs unlike anything stored; a change of label among *similar* inputs is caught by the spot
checks instead.

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
| `teacherAccuracy` | unset | | see [a cloud that is often wrong](#a-cloud-that-is-often-wrong) |
| `minCloudConfidence` | 0 | skip cloud answers the cloud itself was unsure of (needs an adapter that reports confidence) | |
| `maxExamples` | 5,000 | | cap memory and IndexedDB use |

The threshold is a target probability, not a number fitted to a dataset. `belay calibrate` fits
thresholds for fixed local runners; for a learned classifier, [`belay
simulate`](#try-it-on-your-data-first) shows what a threshold does on your data.

### A cloud that is often wrong

The confidence is fitted on whether the classifier agreed with the cloud's answers (and users'
corrections), so by default it is the chance of *agreeing with the cloud*. That can never exceed
the cloud's own accuracy: against a teacher right 83.7% of the time, a threshold of 0.9 kept 1.3%
of comments on the device, however good the classifier got. Systematic cloud mistakes are learned
as if they were right; corrections are the way to fix them.

`teacherAccuracy` tells the classifier how often the cloud is right, e.g. `expected.cloudAccuracy`
from the task's `belay.calibration.json`. The confidence then estimates the chance of *being
right*, `(agreement − e) / (teacherAccuracy − e)` with `e = (1 − teacherAccuracy) / (labels − 1)`,
which is exact when the cloud's mistakes are independent of the classifier's and spread evenly
over the other labels:

```ts
const local = learnedClassifier({ embedder, teacherAccuracy: calibration.expected.cloudAccuracy });
```

It accepts values in (0, 1]. At or below chance, the confidence is left unchanged, as a fallback:
at exactly chance (`1 / labels`) the formula's denominator is zero, and below chance it is
negative. Calibration pairs scored against a reference label rather than the cloud (a seed's
examples, users' corrections) already measure being right; they are counted accordingly.

In the simulations (cold start; noisy teacher = wrong as often as the calibrated cloud model, at
random), it raised the local share on ticket triage from 54.7% to 77.5% at a threshold of 0.95
with no loss of accuracy on the device (overall accuracy 97.3% → 98.9%), and on content moderation
from 1.3% to 10.2% at 0.9 (24.1% with a seed, from 2.7%; overall 81.6% → 82.5%, and 83.6% with the
seed). The answers the classifier keeps are then *more* often right than the cloud's. All the
numbers are in [ADR 0006](adr/0006-a-cloud-that-is-often-wrong.md).

With `teacherAccuracy` set, the confidence is a probability of being right, so derive a threshold
from costs with `costAwareThreshold({ …, calibratedAgainst: 'labels' })`.

It is only as good as that independence assumption. Where the cloud errs mostly on ambiguous
inputs, and is better than its average on the clear ones the classifier is sure of, the corrected
confidence comes out too high. On the 300 moderation examples, Jev was right 92% of the time on
the half a leave-one-out kNN was surest of (83.7% overall), so the correction estimated 93% for
that half where the kNN was right 83% of the time. With a simulated teacher whose mistakes
concentrate on borderline comments, the device's answers were 80.7% right at a threshold of 0.9
(89.5% with a seed). On ticket triage the kNN made none of Claude's or Jev's real mistakes, and
the correction was exact. So:

- With a cloud right more often than your threshold, you don't need it to keep answers on the
  device, but it still lowers the agreement they need: with a 94%-accurate cloud, two labels and
  a threshold of 0.9, an agreement of 0.852 is enough. Turn it on only if you trust the
  independence assumption for your task.
- Set the threshold at or above `teacherAccuracy` to keep only answers likelier right than the
  cloud's ([Chow's rule](#choosing-the-threshold)); a lower one trades accuracy for local share.
- On subjective tasks (moderation, sentiment), watch the device's accuracy with users' corrections
  or a labeled sample before relying on it.

## Watching it in production

```ts
const stats = await local.stats('ticket-triage'); // null until the task's first prepare() or run()
// { examples, seedExamples, perLabel: { billing: 41, … }, head: 'knn', ready: true,
//   heads: { knn: { pairs, recentAccuracy, … }, softmax: { … } },
//   gate: { threshold: 0.61, samples: 146, gated: 10 }, pending, version }
```

The task's run events say what happened on each run, without the input text:

- `source` and `escalationReason` give you the local share over time.
- On `exploration` runs, `label` (the cloud's) and `localLabel` show whether the device agreed.
  A falling agreement rate means the inputs have drifted. Under `informative` exploration, weigh
  each run by its `explorationWeight` to estimate the agreement rate over all confident runs.
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
- **The page stutters while learning.** The softmax head retrains, and the distance gate refits, in
  short steps between frames. On slow devices, use `head: 'knn'`. With thousands of stored
  examples, the first run after a page load waits for the gate's first fit (about a second at
  5,000 examples on a laptop), without blocking the page.
- **`prepare()` fails with "Failed to resolve module specifier '@huggingface/transformers'".**
  The app is bundled: pass `transformers: () => import('@huggingface/transformers')` to
  `transformersEmbedder()` ([install](#1-install)).
- **`belay.config.ts` doesn't typecheck: "Cannot find module 'playwright-core'".** The config
  types mention Playwright for `belay calibrate`'s browser options. Install `playwright-core`,
  set `skipLibCheck`, or write the config as `belay.config.mjs`.
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
