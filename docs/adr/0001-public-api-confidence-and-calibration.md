# ADR 0001: Public API, confidence signal, and calibration file format

- Status: Accepted
- Date: 2026-09-29
- Scope: `@belay/core`, `@belay/web`, `@belay/calibrate` (file format only)

## Context

Belay runs a task on the browser's built-in AI first and escalates to a cloud model only when
the local answer is not trustworthy enough. For that to work, three things need to be fixed early
because every package and every calibration file depends on them:

1. the **public API**: how a developer declares a task and what a run returns;
2. the **confidence signal**: the single number compared against the threshold, for classifier
   tasks and for generation tasks;
3. the **calibration file**: what `belay calibrate` writes and what a task reads.

### What the Classifier API looks like today

The brief warned that the Classifier API is a proposal. Its current shape, checked on 2026-09-29:

- The original explainer at
  [explainers-by-googlers/classifier-api](https://github.com/explainers-by-googlers/classifier-api)
  describes a fixed-taxonomy API (`classifier.classify(text)` returning IAB taxonomy IDs). Its
  README says: "No longer pursued due to insufficient signals of interest" (May 18, 2026).
- The current explainer revision
  ([michaelwasserman/classifier-api](https://github.com/michaelwasserman/classifier-api), last
  updated Sep 23, 2026) and the [WebAI Studio docs](https://web-ai.studio/docs/classifier) /
  [playground](https://web-ai.studio/playgrounds/classifier) describe a question-schema API
  instead. Chrome has it behind `#classifier-api`, and the WebAI Studio extension polyfills it
  with a local model (LiteRT.js).

```js
await Classifier.availability(schema); // "available" | "downloadable" | "downloading" | "unavailable"
const classifier = await Classifier.create({
  context: 'Enterprise customer support ticket router.',
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  questions: [
    { id: 'category', type: 'categorical', prompt: 'Select the primary support department.',
      options: [{ label: 'bug', description: '…' }, { label: 'billing', description: '…' }] },
  ],
});
const result = await classifier.classify(input, { signal });
// result.category = { id, label, confidence, probabilities: [{ label, probability }, …] }
// binary questions also carry `probability` (calibrated P(true)); ordinal ones `expectedScore`.
classifier.destroy();
```

The explainer says the probabilities are calibrated ("RLCD and post-hoc calibration") and that
`confidence` is a separate normalized certainty score. It does not say how `confidence` is derived
from the distribution.

**Consequence:** Belay builds on the question-schema shape. It treats every result field as
optional at runtime, keeps all knowledge of the API inside `@belay/web`'s `classifierApi()` runner,
and accepts an injected implementation (`classifierApi({ classifier })`) so a renamed or
polyfilled API needs no core change.

## Decision 1: Public API

### Tasks

```ts
import { task, fetchAdapter } from '@belay/core';
import { classifierApi } from '@belay/web';

const triage = task({
  name: 'ticket-triage',
  schema: { type: 'categorical', options: ['bug', 'billing', 'feature', 'other'] },
  local: classifierApi(),
  cloud: fetchAdapter({ url: '/api/belay' }),
  threshold: 0.8,                              // and/or: calibration: '/belay.calibration.json'
  context: 'Support tickets for a SaaS product', // optional, shared by both runners
  privacy: { escalation: 'auto', redact },     // optional
  onEvent: (e) => metrics.push(e),             // optional telemetry
});

const result = await triage.run(text, { signal });
```

`task()` is a plain function (`import * as belay from '@belay/core'` gives the `belay.task(...)`
spelling from the brief). There is no global registry and no client object. A task is just a
value, so tree-shaking works and tests need no setup.

**Schemas** (`schema.type`):

| type          | value type        | shape                                                          |
| ------------- | ----------------- | -------------------------------------------------------------- |
| `binary`      | `boolean`         | `{ prompt }` (the yes/no question is required)                 |
| `categorical` | union of labels   | `{ options: (string \| { label, description })[], prompt? }`   |
| `ordinal`     | union of labels   | same as categorical, options ordered low → high                |
| `structured`  | `T`               | `{ jsonSchema, validate: (v) => v is T, prompt? }`             |

The value type is inferred (`ValueOf<S>`), so `options: ['bug', 'billing'] as const` makes
`result.value` typed as `'bug' | 'billing'`. `structured` takes a user-supplied `validate`
function because `@belay/core` has zero runtime dependencies and therefore no JSON Schema
validator. The `jsonSchema` is passed to the Prompt API (`responseConstraint`) and to the cloud.

**Task methods:** `run(input, { signal, escalation, context })`, `availability()`,
`prepare({ onProgress, signal })`, `threshold()`, `destroy()`.

### Runners

Runners are plain objects implementing small interfaces. Nothing in core is Chrome-specific.

```ts
interface LocalRunner<S> {
  id: string;                                   // "classifier-api", "prompt-api", …
  availability(ctx): Promise<Availability>;     // must never trigger a download
  run(input, ctx): Promise<{ value, confidence?, probabilities?, raw? }>;
  prepare?(ctx, { onProgress, signal }): Promise<void>; // the only path that may download
  destroy?(): void;
}

interface CloudRunner<S> {
  id: string;
  run(request: CloudRequest, { signal }): Promise<{ value, confidence?, raw? }>;
}
```

`CloudRequest` carries `input` (already redacted), `instruction` (a ready-made prompt describing
the task and the output format), `jsonSchema` (for providers with structured output; non-structured
values are wrapped as `{ "value": … }`), `schema`, `context`, and the local attempt
(`local: { value, confidence }`). Two adapters ship in core:

- `cloudAdapter(fn)`: wraps any `async (request, { signal }) => rawOutput` function;
- `fetchAdapter({ url, headers?, body?, select? })`: POSTs the request as JSON to the app's own
  backend. Provider API keys never belong in the browser, so there is no direct-to-provider
  adapter in core. A Vercel AI SDK adapter (`generateObject` with `jsonSchema`) is planned as a
  separate optional package, so core stays dependency-free.

The task validates and normalizes every output against the schema with `parseValue()`: bare value,
`{ value }` wrapper or a JSON string of either; case-insensitive label match. A runner cannot
return an out-of-schema value to the application.

**Model downloads.** `run()` never downloads a model. If `availability()` is not `"available"`,
the run escalates with reason `local-unavailable`. The only way to download is `task.prepare()`,
which the app calls from a user gesture (a click handler), with `onProgress` for a progress bar.
This matches Chrome's user-activation requirement for model downloads and keeps first-run costs
visible to the user.

### Result

```ts
interface BelayResult<V> {
  value: V;
  confidence: number | null;   // local confidence if source is "local"; the cloud's own confidence or null otherwise
  source: 'local' | 'cloud';
  latencyMs: number;           // wall clock of run()
  escalationReason: null | 'low-confidence' | 'local-unavailable' | 'local-error' | 'local-timeout' | 'invalid-output';
  escalationBlocked: null | 'policy' | 'consent-denied' | 'cloud-error';
  threshold: number;           // threshold in effect for this run
  local: { value, confidence, latencyMs, probabilities? } | null; // the local attempt, if any
}
```

`escalationReason` records why the cascade *wanted* to escalate. `escalationBlocked` records why
that did not produce a cloud answer, in which case the local result is returned anyway. An app can
therefore tell "confident local" (`reason === null`) from "unconfident local, cloud not allowed"
(`reason === 'low-confidence' && blocked === 'policy'`) and, for example, ask the user.

`confidence` is `null` for cloud results unless the cloud adapter reports one. Belay does not
invent a confidence for the cloud model. The local attempt stays available in `result.local`.

### The cascade (normative)

1. Resolve the threshold (the calibration is loaded once and memoized).
2. `local.availability()`. If not `"available"`, the reason is `local-unavailable`.
3. `local.run()`, optionally racing `localTimeoutMs`. On timeout, abort the local signal; the
   reason is `local-timeout`. Other throws give `local-error`, and `LocalUnavailableError` gives
   `local-unavailable`.
4. Parse the output. If it fails, the reason is `invalid-output` and the confidence is 0.
5. Compute the confidence (Decision 2) and the threshold for the local label (Decision 3).
   **Accept iff `confidence >= threshold`**; otherwise the reason is `low-confidence`.
6. If a reason is set, pass the escalation gate: the policy, then `redact`, then `consent`.
7. Call the cloud and parse its output. If it fails, return the local result with
   `escalationBlocked: 'cloud-error'`. If there is no local result either, throw.

Errors: `BelayError` with `code` in `no-result | cloud-error | cloud-invalid-output |
invalid-task | invalid-calibration`. An abort always rejects with the signal's reason and never
falls back.

### Privacy

`privacy.escalation`:

- `auto` (default): escalate whenever the cascade decides to. This is the brief's "escalate
  always": escalation is always permitted, not forced. Forcing cloud-only is out of scope because
  a cloud-only app does not need Belay.
- `never`: never call the cloud runner. A task without a `cloud` runner behaves the same way.
- `consent`: call `privacy.consent({ task, reason, input, local })` before each escalation. `input`
  is the redacted text that would be sent. A `false` return or a throw means denied.

`privacy.redact(input)` runs before `consent` and before every cloud call. If `redact` throws,
Belay fails closed: nothing is sent, and the local result (or a `no-result` error) is returned.

A per-run `run(input, { escalation })` may only make the policy **stricter**
(`auto < consent < never`). A call site can opt a sensitive input out of escalation, but it can
never opt a `never` task in.

### Telemetry

`onEvent` receives one `run` event per run and `error` events for swallowed failures (local,
cloud, calibration, consent, redact). A `run` event holds `source`, `label` (not for structured
tasks), `confidence`, `localConfidence`, `threshold`, `thresholdSource`, `calibratedAt`,
`escalationReason`, `escalationBlocked`, and the total, local and cloud latencies, plus the runner
ids. **Events never contain the input text or structured outputs.** A throwing listener cannot
break a run. Local share over time and the `localConfidence` distribution, compared with the
calibration's `expected.localShare` and `confidenceHistogram`, are the drift signals (see Decision
4).

## Decision 2: The confidence signal

One number in [0, 1] per run, interpreted as "the probability that the local answer is correct".
The threshold is compared against it and nothing else.

### Classifier tasks (binary, categorical, ordinal)

**Confidence = the calibrated probability of the returned label**, read from
`decision.probabilities` (for binary: `max(P(true), 1 − P(true))` from `decision.probability`).
This is the top-option probability, because the returned label is the argmax.

Why not the API's `confidence` field?

- The probability has a defined meaning: for a calibrated model, P(label) ≈ P(correct), which is
  exactly what the threshold is about. The explainer does not define how `confidence` is derived,
  and it may change as the proposal evolves (entropy, margin, sample agreement, …).
- It is comparable across local runners (a WebLLM or Transformers.js classifier can produce the
  same number), so a calibration file keeps its meaning.
- Calibration makes the choice mostly harmless anyway. Any monotone score works once the threshold
  is fitted on data. But mixing the two would silently invalidate a calibration file, so the
  choice is pinned.

`classifierApi({ confidence: 'model' })` opts into the API's `confidence` field. The runner falls
back to it only when a decision has no probabilities. Calibration records the runner id, so a
calibration and the runner it was made with are paired.

For **ordinal** tasks the value is the top label and the confidence is its probability.
`expectedScore` is kept in `raw` but not used for escalation (a future `ordinal` tolerance, i.e.
"within ±1 level", is a calibration metric, not a runtime change).

### Generation tasks (structured output via the Prompt API)

The Prompt API has no calibrated probabilities, so confidence is built from two signals:

1. **Schema validation (hard gate).** An output that fails `parseValue` / `validate` has
   confidence 0 and escalates with reason `invalid-output`. The judge is not called.
2. **Classifier as judge.** The task's `judge({ input, value })` returns P(correct). The planned
   `@belay/web` judge is a binary Classifier API question over the input and the serialized
   output (for example, "Is this output a correct and complete answer for the input?"). It uses
   the Classifier's calibrated `P(true)`, costs one forward pass (tens of ms) and needs no second
   LLM call.

Combination (`combineConfidence`):

```
valid = false                    → 0
only runner confidence           → runner
only judge                       → judge
both                             → min(runner, judge)   // the more pessimistic signal wins
neither                          → configuration error (BelayError 'invalid-task')
```

`min` over a product: the two signals are not independent (both look at the same output), so a
product would double-count and push every score down. `min` keeps the result on the same scale as
its inputs, so thresholds stay interpretable, and calibration refits the threshold anyway.
"Neither" is an error rather than confidence 0, because silently escalating 100% of traffic is a
bug that is worse to discover in production than at the first run.

## Decision 3: Thresholds

- A task has a global threshold from `threshold` or from a calibration file. When both are given,
  the calibration wins and `threshold` becomes the fallback if the calibration fails to load or
  does not match the schema.
- A calibration may add **per-label thresholds** (`thresholds: { billing: 0.9 }`), looked up by
  the local top label. Models are often well calibrated on some classes and overconfident on
  others. Per-label thresholds cost one map lookup and let `belay calibrate` fix that without API
  changes.
- **Ties stay local** (`confidence >= threshold` is accepted). So `threshold: 0` means "never
  escalate on confidence" and `threshold: 1` means "escalate unless certain".

## Decision 4: Calibration file format (`belay.calibration.json`, v1)

```jsonc
{
  "version": 1,
  "task": "ticket-triage",
  "schemaFingerprint": "fnv1a:3f9c01b2",   // schemaFingerprint(schema): type, prompt, options (+descriptions), jsonSchema
  "createdAt": "2026-09-29T12:00:00.000Z",
  "local": { "runner": "classifier-api", "model": "laya-…", "userAgent": "Mozilla/5.0 … Chrome/142…" },
  "cloud": { "runner": "fetch", "model": "claude-sonnet-5-5" },
  "dataset": { "size": 300, "fingerprint": "fnv1a:9a0e44c1" }, // over canonical JSON of the examples
  "target": { "metric": "accuracy", "value": 0.95 },
  "threshold": 0.82,                        // recommended global threshold
  "thresholds": { "billing": 0.9 },         // optional per-label overrides
  "expected": {                             // at the recommended threshold(s)
    "accuracy": 0.953, "localShare": 0.71, "localAccuracy": 0.981, "cloudAccuracy": 0.94, "costPer1k": 0.87
  },
  "cost": { "currency": "USD", "cloudPerRun": 0.003 }, // optional; enables costPer1k
  "curve": [                                // one point per candidate threshold, ascending
    { "threshold": 0.0,  "accuracy": 0.861, "localShare": 1.0,  "localAccuracy": 0.861, "costPer1k": 0 },
    { "threshold": 0.82, "accuracy": 0.953, "localShare": 0.71, "localAccuracy": 0.981, "costPer1k": 0.87 },
    { "threshold": 1.0,  "accuracy": 0.94,  "localShare": 0.02, "localAccuracy": 1.0,   "costPer1k": 2.94 }
  ],
  "confidenceHistogram": {                  // local confidences over the dataset; edges.length = counts.length + 1
    "edges": [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
    "counts": [0, 0, 2, 9, 14, 17, 21, 24, 61, 152]
  },
  "confusion": {                            // optional; local predictions only
    "labels": ["bug", "billing", "feature", "other"],
    "local": [[88, 3, 1, 2], [4, 61, 0, 5], [2, 0, 70, 3], [5, 9, 4, 43]]
  }
}
```

### Semantics

- For each example, the calibrator records the local `(value, confidence)` and the cloud value.
  At threshold *t*, an example is answered locally iff `confidence >= t` (the same rule as at
  runtime). Cascade accuracy is then computed from the local answers above *t* and the cloud
  answers below it. Because the cloud runs on every example, a single pass produces the whole
  curve.
- **Candidate thresholds** are 0 plus every distinct local confidence in the dataset, sorted.
  Between two consecutive observed confidences the cascade behaves identically, so this set is
  exact. It is also deterministic, which is what "reproducible" means for M2: the same dataset
  and the same model outputs give byte-identical curves.
- **Recommended threshold** is the *smallest* candidate whose cascade accuracy is
  `>= target.value`. Local share is non-increasing in *t*, so this maximizes local share subject
  to the accuracy target. If no candidate meets the target, the candidate with the highest
  accuracy is recommended and `expected.accuracy < target.value` shows it. Per-label thresholds,
  when requested, are fitted greedily in schema option order: each label's threshold is lowered
  to the smallest candidate (among that label's own confidences) that keeps the cascade at or
  above the target, given the thresholds already chosen. Overrides therefore only ever lower a
  threshold and the combined result still meets the target.
- **Threshold values** are the shortest decimal inside the gap between two consecutive observed
  confidences (0.82 rather than 0.8123456), which routes the dataset identically but does not
  sit exactly on one example's score.
- **Staleness.** A task refuses a calibration whose `task` or `schemaFingerprint` differs from its
  own (changing a prompt, an option or a description changes model behavior). It then falls back
  to `threshold` if given and emits an `error` event, and otherwise throws `invalid-calibration`.
- **Drift.** At runtime the observed local share and `localConfidence` histogram (from telemetry)
  can be compared with `expected.localShare` and `confidenceHistogram`. A shift means the input
  distribution or the local model changed, and it is time to recalibrate. `calibratedAt` on each
  event ties metrics to the calibration in use.
- **Loading.** `calibration` accepts the object (a JSON import, bundled), a URL (fetched once,
  lazily, on first `run()`/`threshold()`), or an async loader. `parseCalibration()` validates the
  structure. Unknown fields are ignored, so v1 can grow additively; breaking changes bump
  `version`.
- Fingerprints are 32-bit FNV-1a over canonical JSON. They detect accidental mismatches and are
  not a security feature, which keeps core dependency-free and synchronous.

## Alternatives considered

- **A client object** (`const belay = createBelay({ cloud }); belay.task(…)`). It shares defaults
  but adds a lifecycle and hides dependencies. It can be added later as sugar over `task()`.
- **Escalating on the API's `confidence` field.** Rejected for the default (see Decision 2) but
  kept as an option.
- **Self-consistency sampling for generation confidence** (run the Prompt API N times, measure
  agreement). It costs N× local latency and battery, while a classifier judge costs one fast pass.
  It may come back as an additional signal for devices without the Classifier API.
- **Returning the local answer when the cloud fails, silently.** Rejected: `escalationBlocked:
  'cloud-error'` makes the degraded answer visible.
- **Hashing with SHA-256 via WebCrypto.** Async, and unnecessary for mismatch detection.

## Consequences

- Core is small, synchronous where it can be, and has zero runtime dependencies. All Chrome-API
  knowledge lives in `@belay/web`.
- The calibration file is self-describing enough to render the M2 HTML report on its own
  (the curve, the target, confusion) and to detect staleness and drift at runtime.
- If the Classifier API changes shape again, only `toClassifierSchema()` and `readDecision()`
  change. If it disappears, the runner reports `unavailable` and every run escalates. That is safe,
  but it removes the benefit, which is why local runners are pluggable.
