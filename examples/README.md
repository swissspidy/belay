# Belay examples

Three tasks, each with a labeled dataset of 300 examples and a calibration config.

| Example | Schema | Dataset (license) |
| --- | --- | --- |
| [`ticket-triage`](ticket-triage) | categorical, 5 teams | [Bitext customer support](https://huggingface.co/datasets/bitext/Bitext-customer-support-llm-chatbot-training-dataset) (CDLA-Sharing-1.0), categories mapped to teams |
| [`content-moderation`](content-moderation) | binary | [Civil Comments](https://huggingface.co/datasets/google/civil_comments) (CC0-1.0), toxic when ≥ 50% of raters said so, non-toxic when ≤ 10% did |
| [`intent-detection`](intent-detection) | categorical, 8 intents | [MASSIVE en-US](https://huggingface.co/datasets/AmazonScience/massive) (CC BY 4.0), 8 intents |

Data sources, licenses and changes: [DATA-LICENSES.md](DATA-LICENSES.md).

Each directory has:

- `task.mjs`: the schema and the `task()` an app would create. It is the same schema object
  the calibration uses, so the schema fingerprints match.
- `belay.config.mjs`: the calibration config.
- `examples.jsonl`: the labeled examples. `npm run fetch-datasets --workspace examples`
  regenerates them deterministically from the sources.

The content-moderation dataset contains offensive language. That's the point of the task.

## Running a calibration

```sh
npm install && npm run build      # from the repository root

# Local model: the WebAI Studio extension, which polyfills the Classifier API with Laya.
# Build it from https://github.com/etiennenoel/web-ai.studio/tree/master/extension (npm run package)
export WEBAI_EXTENSION=/path/to/web-ai.studio/extension/release
# Or use Chrome's native API (chrome://flags/#classifier-api) and leave WEBAI_EXTENSION unset.

# Cloud model: Claude and/or Jev, if you have credentials…
export ANTHROPIC_API_KEY=…         # Claude
export JEV_API_KEY=…               # TypeSafe AI's Jev (TYPESAFE_API_KEY works too)
# …otherwise the reference labels (a perfect cloud, an upper bound; see below):
export BELAY_CLOUD=reference

npm run calibrate:triage --workspace examples       # or calibrate:moderation, calibrate:intent
npm run calibrate:all --workspace examples          # every task against Claude and Jev
```

Each example uses the cloud that suited it best: Claude for ticket triage, Jev for content
moderation, and Jev → Claude (`jevThenClaude()`: Claude only where Jev's confidence is below 0.8)
for intent detection. `BELAY_CLOUD=claude|jev|jev-claude|reference` overrides it; without
credentials for an example's cloud, the reference labels stand in.

Each script runs `belay calibrate` inside the example's directory. That directory then holds
`belay.calibration.json`, `belay-report.html` and `.belay-cache/`. `calibrate:all` also calibrates
against the other clouds and writes those as `belay.calibration.<cloud>.json` and
`belay-report.<cloud>.html`. `node scripts/three-tier.mjs` simulates Laya → Jev → Claude and the
other combinations from the cached outputs, with cross-validated thresholds.

The configs use `target: 'max'` (the most accurate threshold; check the report's held-out
accuracy) and price every cloud call from its token usage with the tables in
[`shared/cloud.mjs`](shared/cloud.mjs), copied from [claude.com/pricing](https://claude.com/pricing#api)
and [docs.typesafe.ai/models](https://docs.typesafe.ai/models). Update them when prices change.

The first run downloads the models (about 680 MB)
and caches every output in `.belay-cache/`. Later runs replay the cache and write identical files.

### Notes

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
