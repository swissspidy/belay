# Belay

Belay is confidence-based escalation from on-device AI to cloud AI.

Browser built-in AI (the Classifier API, the Prompt API) is free, private and fast, but you can't
trust it blindly. Belay runs a task locally first. It escalates to your cloud model only when the
local model's confidence is below a threshold, and that threshold is calibrated on your own labeled
data.

> **Status:** Milestones 1–4 are done: the core cascade, the Classifier API and Prompt API
> runners, the classifier-as-judge, the `belay calibrate` CLI, and [three examples](examples)
> with real calibrations against Claude and Jev, with measured costs. Design decisions are in ADRs
> [0001](docs/adr/0001-public-api-confidence-and-calibration.md),
> [0002](docs/adr/0002-calibration-in-a-real-browser.md) and
> [0003](docs/adr/0003-targets-relative-to-the-cloud-and-measured-cost.md).

```ts
import { task, fetchAdapter } from '@belay/core';
import { classifierApi } from '@belay/web';

const triage = task({
  name: 'ticket-triage',
  schema: { type: 'categorical', options: ['bug', 'billing', 'feature', 'other'] as const },
  local: classifierApi(),
  cloud: fetchAdapter({ url: '/api/belay' }), // your backend calls the LLM
  threshold: 0.8, // or: calibration: '/belay.calibration.json'
});

const result = await triage.run(ticketText, { signal });
// {
//   value: 'billing',            // typed as 'bug' | 'billing' | 'feature' | 'other'
//   confidence: 0.93,
//   source: 'local',             // or 'cloud'
//   latencyMs: 31,
//   escalationReason: null,      // or 'low-confidence' | 'local-unavailable' | 'local-error' | 'local-timeout' | 'invalid-output'
//   escalationBlocked: null,     // or 'policy' | 'consent-denied' | 'cloud-error'
//   threshold: 0.8,
//   local: { value: 'billing', confidence: 0.93, latencyMs: 31, probabilities: [...] },
// }
```

**The rule:** the local answer is accepted if and only if `confidence >= threshold`. Otherwise the
task escalates, subject to your privacy policy.

## A real calibration

[![Calibration report for ticket triage](docs/images/ticket-triage-report.png)](examples/ticket-triage/belay-report.html)

[`examples/ticket-triage`](examples/ticket-triage) routes customer messages to one of five teams.
The data is 300 labeled messages from the public Bitext support dataset. The local model is Laya
(the WebAI Studio extension's Classifier API polyfill) running in headless Chromium through
`belay calibrate`. Every confidence in the report is a real model output, and all outputs are
committed in `.belay-cache/`, so re-running replays them and writes a byte-identical file.

Each task is calibrated against two cloud models: Claude Opus 5.5 (`claude-opus-5-5`, effort
`low`) and Jev 1.13 (`jev-1.13.0`, [TypeSafe AI](https://typesafe.ai)'s classification model,
which answers typed questions with probabilities instead of generating text). Every cloud call is
priced from the token usage it reported, at the list prices from
[claude.com/pricing](https://claude.com/pricing#api) ($4 / $20 per million input / output tokens)
and [docs.typesafe.ai/models](https://docs.typesafe.ai/models) ($0.042 per million input tokens,
output free). The target is `'max'`: the most accurate threshold.

| Task | Cloud | Local only | Cloud only | Cascade | Held out¹ | Local | Cloud cost per 1M runs | Saved |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [ticket triage](examples/ticket-triage/belay-report.html) (5 teams) | **Claude**² | 93.0% | 94.3% | **97.7%** | 97.3% | 47% | $1,086 (vs $2,005) | 46% |
| | [Jev](examples/ticket-triage/belay-report.jev.html) | | 92.3% | **95.7%** | 95.0% | 47% | $9.68 (vs $18.30) | 47% |
| [content moderation](examples/content-moderation/belay-report.html) (binary) | **Jev**² | 70.7% | 83.7% | **86.7%** | 86.0% | 78% | $3.18 (vs $14.55) | 78% |
| | [Claude](examples/content-moderation/belay-report.claude.html) | | 76.0% | **76.7%** | 76.7% | 83% | $281 (vs $1,582) | 82% |
| [intent detection](examples/intent-detection/belay-report.html) (8 intents) | **Jev → Claude**²³ | 88.0% | 99.7% | 99.7% | 99.3% | 32% | $65.06 (vs $71.42) | 9% |
| | [Claude](examples/intent-detection/belay-report.claude.html) | | 99.3% | 99.3% | 99.0% | 32% | $1,561 (vs $2,301) | 32% |
| | [Jev](examples/intent-detection/belay-report.jev.html) | | 99.0% | 99.0% | 98.7% | 32% | $13.51 (vs $19.87) | 32% |

¹ Five-fold cross-validation: thresholds fitted on four fifths of the examples, scored on the
fifth. The cascade column is fitted and scored on the same 300 examples, which flatters it.
² The cloud each example uses (its `belay.calibration.json`), chosen from the comparisons below.
³ `jevThenClaude()`: Jev answers when its confidence is at least 0.8, Claude otherwise (6 of 300
runs). As accurate as Claude alone for 3% of its cost, before Laya saves anything.

What the reports showed:

- **The cascade can be cheaper *and* more accurate than the cloud alone.** It gains accuracy when
  the local model is right where the cloud is wrong on the runs it keeps. In ticket triage, the
  141 runs Laya answered at confidence ≥ 0.984 included 10 that Claude got wrong and none that
  Claude got right and Laya didn't. The gain held up on held-out folds (+3.0 points over Claude,
  +2.7 over Jev). For intent detection Laya knows nothing the cloud doesn't, so the cascade can
  only match the cloud; it still answers a third of the runs on device.
- **`target: 'cloud'` trades none of the accuracy for savings.** It takes the lowest threshold
  that is still at least as accurate as the cloud alone. For ticket triage with Claude that is
  0.437: 94.3%, 94% of runs local, and 92% of the cloud bill saved.
- **Jev is about a hundred times cheaper than Claude on these tasks,** around $0.02 per 1,000
  classifications against $1.60–$2.30 for Claude, and it agreed with the moderation labels more
  often (83.7% vs 76.0%). Claude called 87 of the 300 moderation examples toxic; the labels say
  150. Civil Comments counts a comment as toxic when half its raters did, which includes sharp but
  civil criticism ("Trump is far too self-absorbed and ignorant…"), and Claude reads the task's
  question, "rude … enough to make someone leave the discussion", as a stricter bar.
- **The report told us how to fix the task.** The first ticket-triage calibration had 88.0% local
  accuracy. Its "confident local mistakes" table was mostly customer *claims* routed to
  `account`. Adding "claims against the company" to the `feedback` option's description raised
  local accuracy to 93.0%. (The change was chosen by looking at these same 300 examples, so treat
  that gain as optimistic.)
- **A third tier adds little; picking the right second tier matters more.** Jev reports its own
  confidence, so [`scripts/three-tier.mjs`](examples/scripts/three-tier.mjs) simulates Laya → Jev
  → Claude from the cached outputs, with both thresholds cross-validated. Per 1M runs, held out:
  - Ticket triage: Laya → Claude is the most accurate (97.3%, $967). Laya → Jev gets 95.0% for
    $8.28. Three tiers get 95.3% for $99: Jev's confidence doesn't pick out the runs where Claude
    would do better.
  - Moderation: Laya → Jev is best (85.3%, $7.34), since Jev agrees with these labels more.
  - Intent detection: Jev → Claude matches Claude alone (99.3%) for $53 instead of $2,301. Jev
    answers 98.7% of runs and hands the rest to Claude. Run for real (the table above), it sent 6
    of 300 runs to Claude, since Jev's confidence varies a little between calls near 0.8.

  So each example now uses the cloud that suited it best: Claude for ticket triage (accuracy),
  Jev for moderation, and Jev → Claude for intents.

  With 300 examples, one point is three examples, so small differences between rows are noise.
- **The local model is an open, Jev-style model too.** Laya
  ([convaiinnovations/laya](https://huggingface.co/convaiinnovations/laya), Apache-2.0) takes the
  same typed choice / yes-no / score questions as Jev and returns calibrated probabilities. Its
  `laya-serve` exposes Jev's `POST /v1/systemone` API, so it can also be self-hosted on a server.
- **The API's `confidence` field is not the label probability.** For the same decision, Laya
  reported `confidence: 0.964` next to `probability: 0.993` for the chosen label. Belay pins the
  signal to the probability (ADR 0001), and calibration fixes the threshold for it.

## Packages

| Package              | What                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------- |
| `@belay/core`        | Tasks, cascade, confidence combination, calibration file, cloud adapters. Zero runtime dependencies. |
| `@belay/web`         | Local runners for built-in AI: `classifierApi()`, `promptApi()`, and `classifierJudge()`. |
| `@belay/calibrate`   | `belay calibrate` CLI: runs your labeled data in a real Chrome, writes the calibration file and an HTML report. |

## Schemas

```ts
{ type: 'binary', prompt: 'Is this comment abusive?' }                  // value: boolean
{ type: 'categorical', options: ['bug', { label: 'billing', description: 'Invoices, refunds' }] }
{ type: 'ordinal', options: ['1', '2', '3', '4', '5'], prompt: 'How urgent is it?' }
{ type: 'structured', jsonSchema, validate }                            // generation tasks (M3)
```

Both runners' outputs are validated against the schema, so `result.value` is always one of your
options.

## Confidence

- **Classifier tasks**: the calibrated probability of the returned (top) label, as reported by the
  Classifier API. For binary tasks this is `max(P(true), P(false))`.
- **Generation tasks**: schema validation is a hard gate (an invalid output has confidence 0).
  After that, a judge (a Classifier API question such as "is this output correct?") supplies
  P(correct). When there are several signals, the lowest one wins.

The reasoning is in the [ADR](docs/adr/0001-public-api-confidence-and-calibration.md#decision-2-the-confidence-signal).

## Generation tasks (Prompt API)

```ts
import { promptApi, classifierJudge } from '@belay/web';

const summarize = task({
  name: 'ticket-summary',
  schema: { type: 'structured', jsonSchema, validate: isSummary }, // validate: Ajv, Zod, a type guard…
  local: promptApi(),         // LanguageModel with responseConstraint = jsonSchema
  judge: classifierJudge(),   // Classifier API: "is this answer correct and complete?" → P(true)
  cloud: fetchAdapter({ url: '/api/summarize' }),
  threshold: 0.8,
});
```

Each run prompts a fresh clone of a base session, so runs don't share history. An output that
fails `validate` escalates with `invalid-output` and the judge never sees it. Otherwise the judge's
calibrated P(true) is the confidence.

## Model downloads

`run()` never downloads a model. While the Classifier model is `downloadable` or `downloading`,
runs escalate with `escalationReason: 'local-unavailable'`. To download it, call `prepare()` from a
user gesture:

```ts
button.onclick = () => triage.prepare({ onProgress: (p) => (progress.value = p) });
```

Chrome exposes the Classifier API behind `chrome://flags/#classifier-api`. The
[WebAI Studio extension](https://web-ai.studio/playgrounds/classifier) polyfills it with a local
model. `classifierApi()` uses `globalThis.Classifier`, so it works with both. You can also pass
your own implementation: `classifierApi({ classifier })`.

## Cloud adapters

```ts
// Any async function: return the bare value, { value }, or a JSON string of either.
cloudAdapter(async ({ instruction, input, jsonSchema, local }, { signal, reportUsage }) => {
  const res = await callMyBackend(...);
  reportUsage({ model: res.model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens });
  return res.output;
});

// POST the request as JSON to your endpoint.
fetchAdapter({
  url: '/api/belay',
  headers: { 'x-csrf': token },
  select: (json) => json.output,
  usage: (json) => ({ model: json.model, inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens }),
});
```

The request includes a ready-made `instruction`, a `jsonSchema` for structured output, the
(redacted) `input`, and the local attempt. Keep provider API keys on your server. Reporting token
usage is optional; it lets calibration and `savingsMeter()` measure what the cloud costs.
[`examples/shared/cloud.mjs`](examples/shared/cloud.mjs) has runners for Claude (including
refusal fallbacks, priced per model) and for Jev.

## Privacy

```ts
task({
  ...,
  privacy: {
    escalation: 'consent',             // 'auto' (default) | 'never' | 'consent'
    consent: ({ reason, input }) => confirm(`Send to the cloud for a better answer?\n\n${input}`),
    redact: (text) => text.replace(/\S+@\S+/g, '[email]'),
  },
});

await triage.run(text, { escalation: 'never' }); // per call: can only make the policy stricter
```

- `redact` runs before `consent` and before every cloud call. If it throws, nothing is sent.
- If escalation is blocked, you get the local answer with `escalationBlocked` set. If there is no
  local answer either, `run()` throws `BelayError('no-result')`.

## Calibration

Calibrate a task on labeled examples, in a real Chrome:

```sh
npm install --save-dev @belay/calibrate playwright-core
npx belay calibrate --task ticket-triage --data examples.jsonl --extension ./webai-extension
```

```js
// belay.config.mjs
import { defineConfig } from '@belay/calibrate';
import { cloudAdapter } from '@belay/core';
import { triageSchema } from './src/tasks.js'; // the same schema object your app uses

export default defineConfig({
  tasks: {
    'ticket-triage': {
      schema: triageSchema,
      local: { runner: 'classifier-api' },           // runs in Chrome, through @belay/web
      cloud: cloudAdapter(async (req) => callYourModel(req)), // runs in Node
      target: 'cloud',                               // default: never less accurate than cloud only
      cost: {                                        // optional: cost and savings
        currency: 'USD',
        prices: { 'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } }, // per 1M tokens
        runsPerMonth: 1_000_000,                     // for the report's projection
      },
    },
  },
  browser: { extension: './webai-extension' },       // or args to enable the native API
});
```

- **Where it runs:** the local runner runs inside Chrome through the same `@belay/web` code your
  app ships, via Playwright with a persistent profile. The first run downloads the model with a
  real click, and later runs reuse it. The cloud runner runs in Node.
- **Output:** `belay.calibration.json` and a self-contained `belay-report.html`. The report has the
  accuracy / local-share / cost curves, the savings against sending everything to the cloud (with
  a monthly projection you can edit), a held-out accuracy estimate, the confidence distribution, a
  confusion matrix, per-option stats, and the confident local mistakes.
- **Cost:** with `prices`, every cloud call is priced from the token usage its runner reported,
  per model (so a refusal fallback is priced at the fallback model's rates). A model without a
  price fails the run instead of guessing. Without usage, `cloudPerRun` is a flat estimate, and
  the report says so.
- **Reproducibility:** every model output is cached in `.belay-cache/`, so a re-run replays it and
  writes the same file. Use `--refresh local|cloud|all` to re-query, and `--created-at` or
  `SOURCE_DATE_EPOCH` to pin the timestamp.
- **Threshold choice:** the recommended threshold is the lowest one whose cascade accuracy meets
  the target, which maximizes the local share. The target (`--target`) is one of:
  - `'cloud'` (default): the cloud-only accuracy, so the cascade saves money without losing any
    accuracy;
  - `'max'`: the most accurate threshold. When the local model is right where the cloud is wrong,
    this beats the cloud alone, at a smaller saving;
  - a number, e.g. `0.95`, which may be below the cloud's accuracy.

  `--per-label` also fits per-label thresholds. Because the threshold is fitted on the same examples
  it is scored on, the report and file also give a five-fold cross-validated (held-out) accuracy.

The task then loads the file instead of a hand-picked threshold:

```ts
task({ ..., calibration: '/belay.calibration.json', threshold: 0.8 /* fallback */ });
```

The file stores the recommended threshold (and optional per-label thresholds), the whole
accuracy / local-share / cost curve, and a confidence histogram for drift detection. It also stores
a fingerprint of the task schema, so a calibration made for different options or prompts is
rejected. See the [format](docs/adr/0001-public-api-confidence-and-calibration.md#decision-4-calibration-file-format-belaycalibrationjson-v1).


## Telemetry

```ts
task({ ..., onEvent: (e) => { if (e.type === 'run') metrics.record(e); } });
```

Each run emits one event with `source`, `label`, `confidence`, `localConfidence`, `threshold`,
`escalationReason`, `escalationBlocked`, the total, local and cloud latencies, and the cloud call's
token usage (`cloudUsage`) when its runner reports it. Events never contain the input text. Track
local share over time and compare it with the calibration's `expected.localShare` to detect drift.

`savingsMeter()` counts what the cascade saves in production:

```ts
import { savingsMeter } from '@belay/core';

const meter = savingsMeter({ prices, cloudPerRun: calibration.cost?.cloudPerRun, currency: 'USD' });
const triage = task({ ..., onEvent: meter.onEvent });

meter.summary();
// { runs: 1000, local: 470, cloud: 528, blocked: 2, cloudSpend: 1.06, costPerCloudRun: 0.002,
//   saved: 0.94, savedShare: 0.47, measuredCalls: 528, currency: 'USD' }
```

Only runs kept local because the local answer was confident count as saved, each valued at the
mean measured cost of a cloud call. Runs answered locally because escalation was blocked
(privacy policy, consent, cloud error) are counted separately as `blocked`.

## Roadmap

1. ✅ Core + Classifier runner + cloud adapter; escalates exactly when confidence < threshold.
2. ✅ Calibration CLI (Playwright + real Chrome, WebAI Studio polyfill), HTML report, `belay.calibration.json`.
3. ✅ Prompt API runner with structured output and classifier-as-judge confidence.
4. ✅ Examples (ticket triage, content moderation, intent detection) and real calibration reports.
5. ✅ Targets relative to the cloud, measured cost and savings, held-out accuracy, Jev as a cloud model.

Non-goals for now: routing between cloud models in the library (a cloud runner can do it, like
the examples' `cloudCascade()`), training or fine-tuning, server-side use.

## Development

```sh
npm install
npm run check   # typecheck, build, test
```

## License

Apache-2.0
