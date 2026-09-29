# Belay

Belay is confidence-based escalation from on-device AI to cloud AI.

Browser built-in AI (the Classifier API, the Prompt API) is free, private and fast, but you can't
trust it blindly. Belay runs a task locally first. It escalates to your cloud model only when the
local model's confidence is below a threshold, and that threshold is calibrated on your own labeled
data.

> **Status:** Milestones 1–3 are done: the core cascade, the Classifier API and Prompt API
> runners, the classifier-as-judge, and the `belay calibrate` CLI. Examples are next (see
> [Roadmap](#roadmap)).
> Design decisions are in [ADR 0001](docs/adr/0001-public-api-confidence-and-calibration.md).

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
cloudAdapter(async ({ instruction, input, jsonSchema, local }, { signal }) => callMyBackend(...));

// POST the request as JSON to your endpoint.
fetchAdapter({ url: '/api/belay', headers: { 'x-csrf': token }, select: (json) => json.output });
```

The request includes a ready-made `instruction`, a `jsonSchema` for structured output, the
(redacted) `input`, and the local attempt. Keep provider API keys on your server.

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
      target: 0.95,                                  // cascade accuracy to reach
      cost: { currency: 'USD', cloudPerRun: 0.0024 }, // optional: cost columns
    },
  },
  browser: { extension: './webai-extension' },       // or args to enable the native API
});
```

- **Where it runs:** the local runner runs inside Chrome through the same `@belay/web` code your
  app ships, via Playwright with a persistent profile. The first run downloads the model with a
  real click, and later runs reuse it. The cloud runner runs in Node.
- **Output:** `belay.calibration.json` and a self-contained `belay-report.html`. The report has the
  accuracy / local-share / cost curves, the confidence distribution, a confusion matrix, per-option
  stats, and the confident local mistakes.
- **Reproducibility:** every model output is cached in `.belay-cache/`, so a re-run replays it and
  writes the same file. Use `--refresh local|cloud|all` to re-query, and `--created-at` or
  `SOURCE_DATE_EPOCH` to pin the timestamp.
- **Threshold choice:** the recommended threshold is the lowest one whose cascade accuracy meets
  the target, which maximizes the local share. `--per-label` also fits per-label thresholds.

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
`escalationReason`, `escalationBlocked`, and the total, local and cloud latencies. Events never
contain the input text. Track local share over time and compare it with the calibration's
`expected.localShare` to detect drift.

## Roadmap

1. ✅ Core + Classifier runner + cloud adapter; escalates exactly when confidence < threshold.
2. ✅ Calibration CLI (Playwright + real Chrome, WebAI Studio polyfill), HTML report, `belay.calibration.json`.
3. ✅ Prompt API runner with structured output and classifier-as-judge confidence.
4. Examples (ticket triage, content moderation, intent detection) and a real calibration report.

Non-goals for now: routing between cloud models, training or fine-tuning, server-side use.

## Development

```sh
npm install
npm run check   # typecheck, build, test
```

## License

Apache-2.0
