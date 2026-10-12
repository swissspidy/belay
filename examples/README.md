# Belay examples

Four tasks, each with a labeled dataset (300 examples; 240 for event extraction) and a
calibration config: three classification tasks and one generation task.

| Example | Schema | Dataset (license) |
| --- | --- | --- |
| [`ticket-triage`](ticket-triage) | categorical, 5 teams | [Bitext customer support](https://huggingface.co/datasets/bitext/Bitext-customer-support-llm-chatbot-training-dataset) (CDLA-Sharing-1.0), categories mapped to teams |
| [`content-moderation`](content-moderation) | binary | [Civil Comments](https://huggingface.co/datasets/google/civil_comments) (CC0-1.0), toxic when ≥ 50% of raters said so, non-toxic when ≤ 10% did |
| [`intent-detection`](intent-detection) | categorical, 8 intents | [MASSIVE en-US](https://huggingface.co/datasets/AmazonScience/massive) (CC BY 4.0), 8 intents |
| [`event-extraction`](event-extraction) | structured (JSON), 5 fields | [MASSIVE en-US](https://github.com/alexa/massive) (CC BY 4.0), `calendar_set` slot annotations |

Data sources, licenses and changes: [DATA-LICENSES.md](DATA-LICENSES.md).

Each directory has:

- `task.mjs`: the schema and the `task()` an app would create. It is the same schema object
  the calibration uses, so the schema fingerprints match.
- `belay.config.mjs`: the calibration config.
- `examples.jsonl`: the labeled examples. `npm run fetch-datasets --workspace examples`
  regenerates them deterministically from the sources.

The content-moderation dataset contains offensive language. That's the point of the task.

Starting with the learned classifier? [`learned-quickstart`](learned-quickstart) is a complete app
(one page and a small server) that learns from Claude, or from you when there's no API key. See
[below](#learned-classifier) for how it does on these datasets.

`event-extraction` is the generation example: Gemini Nano (Chrome's Prompt API) writes the JSON,
and a Laya judge (the Classifier API) scores it. On this data the judge doesn't separate right
from wrong extractions, so the calibration keeps almost everything in the cloud. The
[report](event-extraction/belay-report.html) shows why.

## Running a calibration

```sh
npm install && npm run build      # from the repository root

# Local model: the WebAI Studio extension, which polyfills the Classifier API with Laya.
# Build it from https://github.com/etiennenoel/web-ai.studio/tree/master/extension (npm run package)
export WEBAI_EXTENSION=/path/to/web-ai.studio/extension/release

# Event extraction also uses Gemini Nano through Chrome's Prompt API (see "Gemini Nano" below).
export BELAY_FORCE_CPU=1          # no supported GPU: run it on the CPU (16 GB RAM, 4 cores)

# Cloud model: Claude, Gemini and/or Jev, if you have credentials…
export ANTHROPIC_API_KEY=…         # Claude
export GEMINI_API_KEY=…            # Gemini (GOOGLE_API_KEY works too)
export JEV_API_KEY=…               # TypeSafe AI's Jev (TYPESAFE_API_KEY works too)
# …otherwise the reference labels (a perfect cloud, an upper bound; see below):
export BELAY_CLOUD=reference

npm run calibrate:triage --workspace examples       # or calibrate:moderation, :intent, :extraction
npm run calibrate:all --workspace examples          # every task against every cloud
node scripts/calibrate-all.mjs --cloud gemini       # (in examples/) only one cloud
```

Each example uses the cloud that suited it best: Claude for ticket triage and event extraction
(Jev can't produce structured output), Jev for content moderation, and Jev → Claude
(`jevThenClaude()`: Claude only where Jev's confidence is below 0.8) for intent detection. Gemini
3.8 Flash is compared on every task; it is about 9× cheaper than Claude Opus 5.5 here and, for
extraction, within a point of its accuracy. `BELAY_CLOUD=claude|gemini|jev|jev-claude|reference` overrides it; without
credentials for an example's cloud, the reference labels stand in.

Each script runs `belay calibrate` inside the example's directory. That directory then holds
`belay.calibration.json`, `belay-report.html` and `.belay-cache/`. `calibrate:all` also calibrates
against the other clouds and writes those as `belay.calibration.<cloud>.json` and
`belay-report.<cloud>.html`. `node scripts/three-tier.mjs` simulates Laya → Jev → Claude and the
other combinations from the cached outputs, with cross-validated thresholds.

The configs use `target: 'max'` (the most accurate threshold; check the report's held-out
accuracy) and price every cloud call from its token usage with the tables in
[`shared/cloud.mjs`](shared/cloud.mjs), copied from [claude.com/pricing](https://claude.com/pricing#api)
[ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing) and
[docs.typesafe.ai/models](https://docs.typesafe.ai/models). Update them when prices change.

The results across all examples and clouds are on the [findings site](https://swissspidy.github.io/belay/),
built from these calibration files by [`site/build.mjs`](../site/build.mjs).

The first run downloads the models (about 680 MB)
and caches every output in `.belay-cache/`. Later runs replay the cache and write identical files.

### Gemini Nano (Prompt API) in automation

Belay's calibration browser is Google Chrome (Playwright's `channel: 'chrome'`). Chromium and
Chrome for Testing don't ship the component updater that downloads Gemini Nano. What it takes, as
verified with Chrome 154 on a CPU-only Linux VM (details in
[ADR 0002](../docs/adr/0002-calibration-in-a-real-browser.md#8-built-in-ai-under-playwright)):

- `belay calibrate` removes Playwright's default switches that disable the model download and
  the on-device model service, and loads extensions through the DevTools protocol, since Google
  Chrome ignores `--load-extension`.
- Without a supported GPU, set `BELAY_FORCE_CPU=1`; Chrome needs 16 GB of RAM and 4 cores.
- The first run downloads Gemini Nano (about 4 GB) into the profile. Run it with `--headed` (under
  `xvfb-run` on a server). Set `BELAY_CHROME_PROFILE` to keep the model in one place across examples.
- Behind a proxy, Chrome must trust its CA (below), and the component updater's plain-HTTP
  requests are pointed at the same service over HTTPS, since many proxies only tunnel HTTPS.
- **Gemma 4** (`chrome://flags/#gemma4-for-built-in-ai`) replaces Gemini Nano behind the same
  Prompt API. From automation, enable its features directly:
  `browser: { enableFeatures: ['OptimizationGuideManifestBroker', 'AIApiFoundationalModel:model_version/v4'] }`.
  Chrome then downloads `gemma4-2b-it` (2.4 GB). It needs a GPU: on the CPU-only VM above, the
  download worked but `LanguageModel.create()` failed with "The device is unable to create a
  session to run the model", also with SwiftShader's software Vulkan. The CPU backend switch only
  applies to Gemini Nano. Gemma 4 is the obvious next local model to calibrate event extraction
  with, on a machine with a GPU. Put the `enableFeatures` above in `event-extraction/belay.config.mjs`,
  and pass `--refresh local` with a copy of the cache (`--cache-dir`) and separate `--out` and
  `--report` files: the cache key doesn't include Chrome's feature flags, so without `--refresh`
  the calibration would replay Gemini Nano's outputs.

### Notes

- **Laya is an open, Jev-style model.** [convaiinnovations/laya](https://huggingface.co/convaiinnovations/laya)
  (Apache-2.0) takes the same typed choice / yes-no / score questions as Jev and returns
  probabilities. Its `laya-serve` exposes Jev's `POST /v1/systemone` API, so it can be self-hosted
  as a cloud tier too.
- **Gemini declines some moderation inputs.** One of the 300 Civil Comments examples came back
  with `PROHIBITED_CONTENT` and no answer; the calibration counts it as a cloud error.
- **Chrome and proxies:** `belay calibrate` passes `HTTPS_PROXY` to Chrome, which otherwise ignores
  it. Behind a TLS-intercepting proxy, Chrome must also trust the proxy's CA. On Linux that means
  the NSS store: `certutil -A -d sql:$HOME/.pki/nssdb -n proxy -t "C,," -i proxy-ca.crt`.
- **Extension model sizes:** the extension checks each downloaded file against a hard-coded byte
  count. When the model repository is re-exported, the counts go stale and the download fails with
  "Downloaded N bytes …, expected M". Update the counts in the extension's model registry.
- **The reference cloud is not a model.** With `BELAY_CLOUD=reference`, escalated examples are
  answered with the dataset's own labels, as if the cloud were always right. The local side of the
  report (confidence distribution, local accuracy by threshold, confusion) is real. The cascade
  accuracy is an upper bound, and so is the local share at the target. A real cloud model needs a
  higher threshold. Re-run with Claude (or your own cloud runner) before shipping a calibration;
  the local outputs are cached, so only the cloud side is queried again.

## Learned classifier

[`@swissspidy/belay-learn`](../packages/learn) learns from the cloud's answers instead of
throwing them away. [`scripts/learn-simulate.mjs`](scripts/learn-simulate.mjs) shows what that
does over time: each classification task's `stream.jsonl` (1,000–1,500 inputs, none of them in
`examples.jsonl`) goes through the real `task()` and `learnedClassifier()` one input at a time,
with real `bge-small-en-v1.5` embeddings, threshold 0.9, `explore: 0.05` and the distance gate
on (the package defaults). It runs through `simulateLearning()`, the function behind
`belay simulate`.

```sh
npm install && npm run build      # from the repository root
node examples/scripts/learn-simulate.mjs            # writes <task>/learn-simulation.json
node examples/scripts/build-seeds.mjs               # writes <task>/belay-seed.json
```

The embeddings are cached in `.belay-cache/<task>.embeddings.*.jsonl`, so neither script needs the
model or the network. To embed new inputs, install transformers.js first
(`npm install --no-save @huggingface/transformers`).

The script doesn't call a cloud model. The teacher is either the dataset's labels (`reference`,
always right) or those labels flipped as often as the task's calibrated cloud model was wrong
(`noisy`). Each starts cold or from a seed built from `examples.jsonl`. Accuracy is measured
against the dataset's labels:

| Task | Order | Teacher | Seed | On device | Accuracy on device | Accuracy | On device, last 300 | Accuracy on device, last 300 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ticket triage (1,500) | mixed | always right | – | 85.9% | 99.7% | 99.7% | 94.0% | 100.0% |
| Ticket triage (1,500) | mixed | always right | 300 | 91.7% | 99.7% | 99.7% | 92.0% | 99.6% |
| Ticket triage (1,500) | mixed | 94.3% right | – | 77.3% | 99.9% | 98.9% | 95.0% | 99.6% |
| Ticket triage (1,500) | mixed | 94.3% right | 300 | 89.1% | 99.9% | 99.3% | 91.3% | 100.0% |
| Content moderation (1,000) | by label | always right | – | 76.1% | 98.9% | 99.2% | 87.3% | 99.6% |
| Content moderation (1,000) | mixed | always right | – | 25.2% | 96.0% | 99.0% | 39.3% | 93.2% |
| Content moderation (1,000) | mixed | always right | 300 | 38.8% | 93.3% | 97.4% | 49.3% | 91.2% |
| Content moderation (1,000) | mixed | 83.7% right | – | 1.3% | 84.6% | 81.6% | 4.3% | 84.6% |
| Content moderation (1,000) | mixed | 83.7% right | 300 | 2.7% | 100.0% | 81.9% | 8.7% | 100.0% |
| Intent detection (1,467) | mixed | always right | – | 84.8% | 98.6% | 98.8% | 87.3% | 98.9% |
| Intent detection (1,467) | mixed | always right | 300 | 85.2% | 99.7% | 99.7% | 85.0% | 100.0% |
| Intent detection (1,467) | mixed | 99.7% right | – | 85.3% | 98.6% | 98.6% | 87.3% | 98.9% |
| Intent detection (1,467) | mixed | 99.7% right | 300 | 84.6% | 99.7% | 99.6% | 82.3% | 100.0% |

With the noisy teacher, the confidence measures agreement with a cloud that is itself wrong
16.3% (moderation) or 5.7% (triage) of the time, so it can't reach the threshold. Passing the
cloud's accuracy as `teacherAccuracy` corrects for that: on moderation, 10.2% on device (22.2%
seeded) at 93.1% (93.7%) accuracy, and 82.5% (83.4%) overall; on triage at a threshold of 0.95,
77.5% on device instead of 54.7%. It assumes the cloud's mistakes are independent of the
classifier's; see [a cloud that is often
wrong](../docs/learned-classifier.md#a-cloud-that-is-often-wrong) for when they are not.
[`scripts/learn-teacher.mjs`](scripts/learn-teacher.mjs) runs these experiments, and
[`scripts/teacher-independence.mjs`](scripts/teacher-independence.mjs) checks the assumption on
the real cloud answers cached by the calibration ([ADR 0006](../docs/adr/0006-a-cloud-that-is-often-wrong.md)).

The ablation for [ADR 0005](../docs/adr/0005-choosing-what-to-ask-and-keeping-what-it-learns.md)
reruns the cold start with each way of choosing spot checks, with and without the distance gate
(the rows with uniform spot checks and the gate are the ones above). The rows without the gate and
with uniform spot checks reproduce ADR 0004's results exactly.

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

"Last 300" is the end of the stream, after the classifier has learned. The
[demo](https://swissspidy.github.io/belay/learn/) runs the ticket-triage stream in your browser.
