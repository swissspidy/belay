# Quickstart: a classifier that learns

A page that triages customer messages with [`@swissspidy/belay-learn`](../../packages/learn), and
the backend endpoint its cloud runner calls. It shows the whole loop in about 200 lines:

- **Embedding in the page.** Each message is embedded and classified in the browser.
- **Escalation.** When the classifier is unsure, the message goes to the cloud, and the
  classifier learns from the cloud's answer.
- **Spot checks.** 5% of confident answers still go to the cloud as a check.
- **Corrections.** A "Wrong?" button sends `task.feedback()`.
- **Persistence.** What it learned stays in IndexedDB, and you can export, import or reset it.

## Run it

```sh
npm install && npm run build                     # once, from the repository root
node examples/learned-quickstart/server.mjs      # then open http://127.0.0.1:8787
```

- **With Anthropic credentials** (`ANTHROPIC_API_KEY`, or `QUICKSTART_CLOUD=claude` after
  `ant auth login`), escalations go to Claude Opus 5.5 through the server. The key never reaches
  the page.
- **Without credentials, you are the cloud.** When the classifier is unsure, the page asks you
  for the team, and it learns from your answer. It starts answering on its own after 40 to 70
  messages. That is the cold start: it needs 30 predictions it can check against an answer
  before it trusts itself.
- **Start from the seed** loads 300 labeled examples (embeddings only), so it answers from the
  first message.

## What to look at

[`index.html`](index.html) is the app side. The numbered comments follow the
[guide](../../docs/learned-classifier.md):

1. **The cloud:** `fetchAdapter()` to your backend.
2. **The local runner:** `learnedClassifier()` with `transformersEmbedder()` and `indexedDbStore()`.
3. **The task:** threshold 0.9 and informative exploration.
4. **`prepare()`:** loads the model from a click the first time, and without one afterwards.
5. **`feedback()`:** sends corrections.
6. **Snapshots:** `exportState()` and `importState()` keep or move what it learned.

[`server.mjs`](server.mjs) serves the page and the built packages, and runs the cloud runner
from [`../shared/cloud.mjs`](../shared/cloud.mjs).
