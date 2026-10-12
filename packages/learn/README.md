# @swissspidy/belay-learn

A [Belay](https://github.com/swissspidy/belay#readme) local runner that learns. It embeds each
input with a small model in the page (transformers.js, WebGPU or WebAssembly) and classifies it
with a head trained on the cloud's answers to earlier escalations and on your users' corrections.
The more the cloud answers, the less it needs to.

- **Starts from nothing, or from a seed.** With no examples it escalates everything. Each cloud
  answer becomes a training example. A seed file ships labeled embeddings with your app, so it
  starts useful.
- **The threshold keeps its meaning.** The confidence is the head's score mapped to P(correct)
  (Platt scaling), fitted on how the head did on inputs it had not seen yet. A task with
  `threshold: 0.9` accepts a local answer when it is at least 90% likely right, at the start
  and after a thousand examples. Until there is enough evidence (10 examples, 3 for the label,
  30 scored predictions), the confidence is 0.
- **Two heads.** k-nearest neighbors from the first example; a softmax layer once there are 50.
  In `auto` mode the one that was right more often on recent inputs answers.
- **On the device.** Examples are stored as embeddings, in memory or IndexedDB, never as text.
  The model downloads once (about 34 MB) and is then read from the browser cache.

On a stream of 1,500 support messages, it answered 85% of them on its own with 99.6% accuracy,
starting from nothing; see the [simulation](https://github.com/swissspidy/belay/tree/main/examples#learned-classifier)
and the [demo](https://swissspidy.github.io/belay/learn/).

> **Status:** experimental (0.x). The API may change between minor versions.

## Install

```sh
npm install @swissspidy/belay-core @swissspidy/belay-learn @huggingface/transformers
```

`@huggingface/transformers` is an optional peer dependency: it is only loaded by
`transformersEmbedder()`, and you can pass your own `Embedder` instead.

## Usage

```ts
import { task, fetchAdapter } from '@swissspidy/belay-core';
import { indexedDbStore, learnedClassifier, transformersEmbedder } from '@swissspidy/belay-learn';

const local = learnedClassifier({
  embedder: transformersEmbedder(),   // Xenova/bge-small-en-v1.5 by default
  store: indexedDbStore(),            // keep what it learns across reloads
  seed: '/belay-seed.json',           // optional: start from labeled examples
});

const triage = task({
  name: 'ticket-triage',
  schema: { type: 'categorical', options: ['account', 'billing', 'order', 'shipping', 'feedback'] },
  local,
  cloud: fetchAdapter({ url: '/api/belay' }),
  threshold: 0.9,
  explore: 0.05, // also send 5% of confident runs to the cloud: checks the local answers and teaches it
});

// The first time: download the model from a user gesture. Later visits load it from the cache.
button.onclick = () => triage.prepare({ onProgress: (p) => (progress.value = p) });

const result = await triage.run(message);

// A user says the answer was wrong: teach it (counts 3× a cloud answer, and wins over one).
await triage.feedback(message, 'billing');

await local.stats(); // { examples, perLabel, head, ready, heads: { knn, softmax }, ... }
```

Learning needs the cloud's answers, so it only happens for runs that escalate: under the `never`
policy, or when consent is denied, nothing is learned (but `feedback()` still is).

## Seed files

Build one at build time, in Node, with the same embedder the page uses:

```ts
import { writeFile } from 'node:fs/promises';
import { buildSeed, transformersEmbedder } from '@swissspidy/belay-learn';

const seed = await buildSeed({
  task: 'ticket-triage',
  schema: triageSchema,        // the same schema object the task uses
  embedder: transformersEmbedder(),
  examples: labeled.map((e) => ({ input: e.text, value: e.label })),
});
await writeFile('public/belay-seed.json', JSON.stringify(seed));
```

A seed holds int8 embeddings (about 0.5 KB per example), not text, and leave-one-out calibration
pairs, so the classifier can answer from the first run. A seed made with another embedder or for
another schema is rejected. `local.exportSeed()` turns what a classifier learned into a seed.

## Options

| Option | Default | |
| --- | --- | --- |
| `embedder` | required | `transformersEmbedder({ model, dtype, device, pooling, prefix })` or your own `Embedder` |
| `store` | `memoryStore()` | `indexedDbStore({ name })`, or your own `ExampleStore` |
| `seed` | none | a seed file, its URL, or a loader |
| `head` | `'auto'` | `'knn'` or `'softmax'` |
| `knn` | `{ k: 7, temperature: 0.1 }` | |
| `softmax` | `{ minExamples: 50, epochs: 150, warmEpochs: 40, retrainDelayMs: 200 }` | retrained in the background after new examples |
| `minExamples`, `minPerLabel` | 10, 3 | cold start: confidence 0 below these |
| `calibration` | `{ minPairs: 30, window: 150 }` | Platt scaling on the most recent scored predictions |
| `feedbackWeight` | 3 | |
| `minCloudConfidence` | 0 | ignore cloud answers whose reported confidence is lower |
| `maxExamples` | 5,000 | the oldest cloud answers are dropped first |

The design and its trade-offs are in
[ADR 0004](https://github.com/swissspidy/belay/blob/main/docs/adr/0004-learning-from-escalations.md).

## License

Apache-2.0
