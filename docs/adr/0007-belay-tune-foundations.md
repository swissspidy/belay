# ADR 0007: Belay Tune foundations: traces, local configs, the ledger and a protected evaluator

- Status: Accepted. §1 and §2 (milestone M1) and §8 (M2) are implemented; §3 to §5 and §7 are the design for M3 and M4.
- Date: 2026-11-10
- Scope: new `@swissspidy/belay-trace` and `@swissspidy/belay-tune`; `belay datasets`, `evaluateLocal()` and `createBackend()` in `@swissspidy/belay-calibrate`
- Builds on: ADR 0001 (telemetry, privacy, calibration file), ADR 0002 (real-browser evaluation), ADR 0004 §3 and ADR 0005 §1 (`explore`)

## Context

Belay Tune is a planned overnight loop that makes a task need the cloud less: it reads what the
task escalated, proposes changes to the local side, measures them in a real browser, and opens a
pull request with the best one. Its one metric is **local share at a fixed target accuracy**.

Its brief was written before reading this repository. This ADR first records where the code
contradicts the brief, then decides the five formats and mechanisms the loop rests on.

## What the code says, against the brief

| The brief assumes | The repository has | Consequence |
| --- | --- | --- |
| Packages `@belay/trace` and `@belay/tune` | Everything is `@swissspidy/belay-*`, released together | `@swissspidy/belay-trace`, `@swissspidy/belay-tune` |
| Both new packages are Node-side | A trace is captured where the task runs: in the page | The trace package has a browser entry with no dependencies, and a Node entry (`/node`) for storage and datasets |
| Traces can be built from telemetry hooks | `onEvent` events never hold the input or structured outputs (ADR 0001) | Capture wraps `task()`; telemetry stays free of content (§1) |
| Shadow sampling is new | `explore` is in the core (ADR 0004 §3), with an `informative` strategy and importance weights (ADR 0005 §1). It only runs under the `auto` policy | Nothing new to build. Traces record the weight (§1) |
| A never-escalate task must be made to produce no labels | The core already guarantees it, and per-run options can only be stricter | Tested again for tracing: no cloud call, no stored content |
| The redaction hook exists for storage | `privacy.redact` runs before cloud calls only; `learn()` gets the raw input by design | Tracing applies it before storage, and fails closed (§1) |
| A task's local side lives in a config file | It lives in code: `task({ schema, context, local: classifierApi(options), judge })`. The nearest thing to a file is the JSON-serializable `{ runner, options }` spec in `belay.config.mjs` | A local config file is new, applied by a wrapper runner (§3). This answers the brief's open question on config location |
| Instructions, rules and few-shot examples are tunable | `classifierApi()` takes option descriptions and a `context`; the polyfill's model has a 256-token window. `promptApi()` takes a `systemPrompt`. Neither has a slot for examples | Rules and examples are rendered into `context` or `systemPrompt`, inside a measured token budget (§3) |
| Option wording can change freely | The schema's prompt and descriptions also build the cloud's instruction, and are part of the `schemaFingerprint` that a calibration file is checked against | Wording changes apply to the local runner only; the task's schema and the cloud prompt stay as they are (§3) |
| One calibration file, re-fitted by rung 1 | `belay.calibration.json` is one file per task, fitted and scored on the same examples (plus five-fold cross-validation), with `target: 'cloud' \| 'max' \| number` | The brief's metric is `target: <number>`. Per-backend files and a config fingerprint in the file are new (§3) |
| web-ai-evals is the execution backend | It is not a dependency. `belay calibrate` has its own harness, which runs the shipped `@swissspidy/belay-web` runners in Chrome (ADR 0002 §1), with an output cache and cost measurement | The evaluator is that harness (§6) |
| `belay tune`, `belay verify`, `belay ledger` are free names | The `belay` binary belongs to `@swissspidy/belay-calibrate`, which already hosts the commands of `@swissspidy/belay-learn` | New commands are added there, as `belay datasets` is |
| The reflecting model has the shape of the cloud runner | A `CloudRunner` answers one task input and its output is validated against the task's schema | Same pattern (your function, your key, reported usage), a different type (§7) |
| Gold labels come from a person or a public dataset | `task.feedback()` already takes users' corrections | Corrections are recorded as gold labels |
| Latency (p95) and a paired bootstrap are available for the gate | The evaluator records no latency, and the only interval is Wilson's | Both are M2 and M3 work |
| "Two runs agree within 1 point" tests stability | A second run replays `.belay-cache/` and agrees exactly | M2 must compare runs made with `--refresh local` |
| Ticket triage goes from 60% to 80% local at 95% | Calibrated today: 53% local at 97.3% (Laya, then Claude Opus 5.5) | The illustration needs real numbers before a write-up |

One finding argues against part of the plan. On event extraction, 11% of runs stay local, and the
findings say why: no judge could tell Gemini Nano's right answers from its wrong ones. For
generation tasks the judge's question and context are tunables as important as the prompt (§3).

## Decisions

### 1. Traces (implemented)

`tracedTask(options, { sink })` takes the options of `task()` and returns the same task, which
also writes one trace per run to the developer's sink. Tracing is off unless this function is
used, and Belay stores nothing.

A trace (v1) holds: `id`, `kind` (`run` or `label`), `task`, `schemaFingerprint`, `timestamp`,
`input`, `redacted`, `label` (`value`, `kind`: `gold` or `silver`, `origin`: `cloud`, `feedback`,
`dataset` or `synthetic`), `environment` (runner ids, user agent, model names the app supplies,
`calibratedAt`), and for runs `source`, `local` (value, confidence, latency, probabilities),
`cloud` (value, confidence, latency, token usage), `threshold`, `escalationReason`,
`escalationBlocked`, `policy`, `latencyMs` and `weight`.

**Content.** A run answered on the device has, until now, never left it. Tracing must not change
that silently, so `content` decides which traces hold text:

- `sent` (default): only runs whose input went to the cloud anyway (escalated or explored, also
  when the cloud call then failed). Every other run is recorded without its input, and for
  structured tasks without its outputs. Such a trace is as private as a telemetry event and still
  counts towards local share and the confidence distribution.
- `all`: also runs the device answered, and corrections passed to `task.feedback()`. Only under
  the `auto` policy.

Under `never` (the task's policy, a per-run override, or a task without a cloud runner) and when
consent was denied, a trace never holds content, whatever `content` says.

**Redaction.** `redact` defaults to the task's `privacy.redact` and runs before the sink sees
anything: over the input, and over every string of a structured output (a local output is
computed from the raw input and can repeat what the hook removes). If it throws, the content is
withheld.

**Labels.** The cloud's answer is a silver label. A correction is a gold label (`kind: 'label'`).
`labelTrace()` imports a row of an existing dataset (gold) or a synthetic example (silver, origin
`synthetic`).

**Weights.** Escalated runs are the hard cases, and a confident local mistake is only seen when
exploration happens to pick the run. An explored run therefore stands for `explorationWeight /
rate` confident runs, and the trace records that as `weight`. The exploration weight exists only
in the run event, not in the result, so the wrapper matches each result to its event (by the
latency both hold as the same number).

**Sinks.** A sink is `{ write(trace), flush?() }` or a plain function. `run()` does not wait for
it, and a failing sink never breaks a run (`onError`). `jsonlSink(path)` in
`@swissspidy/belay-trace/node` is the reference: one JSON line per trace.

### 2. Datasets (implemented)

`buildDatasets(traces, { task, schema, seed, previous })`, and `belay datasets` around it, turn
traces into `train.jsonl`, `validation.jsonl`, `holdout.jsonl` and `manifest.json`. A split file
is what `belay calibrate --data` reads (`id`, `input`, `label`), plus `labelKind`, `origin` and
`weight`.

- **One label per input.** Gold wins over silver; then the majority; then the latest.
- **Identity.** An input's id is the SHA-256 of its normalized text (Unicode NFKC, lower case,
  collapsed whitespace), so no input is in two splits.
- **Near-duplicates share a split.** Inputs whose word 3-grams overlap by a Jaccard similarity of
  0.8 or more form a cluster. MinHash bands propose the pairs, the exact similarity decides.
- **The split follows from the seed and the hash**, never from the order of traces: 60% train, 20%
  validation, 20% holdout by default.
- **The holdout is frozen and only grows.** The manifest maps every input id to its split and
  holds no text. With the previous manifest, every input keeps its split. A new input joins the
  split of its near-duplicates; one that is close to inputs of two splits is left out. A different
  seed or schema is refused.
- **Synthetic examples never enter the holdout.**
- Traces of another schema fingerprint are skipped and counted.

The manifest is the file to commit. The split files hold input text and belong wherever the traces
may be kept.

### 3. Local config (proposed)

Everything tunable about the local side of one task on one backend, as one JSON file:
`belay/<task>/<backend>.local.json`, where `<backend>` names the runner and model, e.g.
`classifier-api.laya-multilingual` or `prompt-api.gemini-nano-v3`.

```json
{
  "version": 1,
  "task": "ticket-triage",
  "backend": { "runner": "classifier-api", "model": "laya-multilingual", "modelVersion": "2026.09" },
  "wording": {
    "prompt": "Which team should handle this ticket?",
    "options": { "billing": "Invoices, refunds, charges, payment methods" }
  },
  "context": "Support tickets for a SaaS billing product.",
  "rules": ["A refund request is billing, even when it mentions a bug."],
  "examples": [{ "input": "I was charged twice", "label": "billing" }],
  "runner": { "confidence": "label-probability" },
  "judge": { "question": "Is this answer correct and complete?", "context": "" },
  "steps": null,
  "calibration": "classifier-api.laya-multilingual.calibration.json"
}
```

- **Applied by a wrapper, not by the core.** `withLocalConfig(runner, config)` is a `LocalRunner`
  that hands the wrapped runner the reworded schema and the rendered context. The task's own
  schema, the cloud's instruction and the `schemaFingerprint` do not change, and
  `@swissspidy/belay-core` gains no code. Option labels cannot be reworded: they are the task's
  values.
- **Rules and examples are rendered** into the context (Classifier API) or the system prompt
  (Prompt API) by one function, whose output is counted with the browser's own token accounting.
- **The threshold stays in the calibration file**, one per backend. A config's fingerprint (a hash
  of the canonical JSON) is recorded in that file, so a threshold fitted for another config is
  rejected like one fitted for another schema. This adds an optional field to the v1 file format:
  the one change this work asks of the core's types.
- **A candidate is an RFC 6902 JSON Patch** to this file plus a one-sentence hypothesis. A patch
  may only touch `wording`, `context`, `rules`, `examples`, `runner`, `judge` and `steps`.
- `steps` (decomposition, rung 4) is reserved, and its format is decided in M5.

### 4. Ledger (proposed)

`.belay/ledger.jsonl`, append-only, one line per experiment:

```json
{
  "version": 1, "id": "2026-11-10.014", "run": "2026-11-10", "seq": 14, "timestamp": "2026-11-10T02:41:07Z",
  "task": "ticket-triage", "backend": "classifier-api.laya-multilingual", "rung": "rules",
  "hypothesis": "Refund requests that mention a bug are sent to the cloud; a rule settles them.",
  "parent": "sha256:…", "candidate": "sha256:…", "patch": [{ "op": "add", "path": "/rules/-", "value": "…" }],
  "stage": "validation",
  "scores": { "accuracy": 0.951, "localShare": 0.64, "goldAccuracy": 0.948, "cloudAgreement": 0.953, "promptTokens": 212, "latencyP95Ms": 41 },
  "baseline": { "accuracy": 0.95, "localShare": 0.6 },
  "cost": { "currency": "USD", "reflector": 0.031, "usage": [] },
  "verdict": "kept", "reason": "Local share up 4 points at equal accuracy.",
  "environment": { "userAgent": "…", "modelVersion": "…" },
  "protected": "sha256:…", "seed": "7", "previous": "sha256:…"
}
```

`stage` is `screen`, `validation` or `gate`; `verdict` is `kept`, `discarded`, `promoted` or
`error`. `previous` is the hash of the line before, so an edited history is detectable.
`protected` is the lock hash of §5. The reflecting model reads the ledger, with gate scores
reduced to pass or fail, so that the holdout cannot be learned from one night to the next.

### 5. Protected evaluator (proposed)

The loop is ordinary code, not an agent with a shell, which is the first protection: the
reflecting model returns JSON and never writes a file. On top of that:

1. **A lock file.** `belay.tune.lock.json`, written by `belay tune --lock` and committed by a
   person, holds SHA-256 hashes of the gate config (`belay.gate.json`), of `belay.tune.md`, of the
   installed evaluator packages (`@swissspidy/belay-calibrate`, `-web`, `-core`, `-trace`), and the
   dataset manifest's `holdoutFingerprint`. The loop checks it at the start, before the gate and
   before it writes its outputs, and stops on a mismatch. The holdout may grow between nights: the
   check is that every id of the locked holdout is still in it.
2. **A path allowlist.** All of the loop's writes go through one function, which only accepts the
   local config, the calibration file, the ledger, the report and `.belay-cache/`.
3. **Patches are validated** against the tunable paths of §3 before anything runs.
4. **The holdout is never in a prompt.** The reflecting model is given samples from train and
   validation only, built by a function that cannot read the holdout file.
5. **One gate run per night**, recorded in the ledger. `belay verify` in CI re-checks the lock and
   re-runs the gate, and the pull request template asks for a code owner on the lock and gate files.

### 6. Evaluator and web-ai-evals (finding)

web-ai-evals can be driven as a library. It exports `runEvals()`, `runCell()` and a
`BrowserSession` class documented as the API for integrations, and its Classifier adapter returns
the confidence and probabilities. It is on npm as `0.0.0`.

It should not be the evaluator for the gate, for three reasons:

- It runs its own page adapters, not `@swissspidy/belay-web`. The number that matters is the
  shipped runner's confidence under the shipped session options (ADR 0002 §1), and a local config
  must be applied by the same wrapper the app uses.
- It needs Node 24; Belay supports Node 22.12.
- `evaluate()`, `analyze()`, the output cache and the cost measurement of
  `@swissspidy/belay-calibrate` already do what the gate needs.

So the evaluator is the calibration harness with `browserBackend()` (§8). The gaps it had:
example weights, an interval for the local share, and a place for the local config's fingerprint
in the cache key (closed in M2); per-example latency and a paired bootstrap (open, for the gate). web-ai-evals remains the right tool for the gate's support-matrix check across
browsers and backends (M5), through `BrowserSession`.

### 7. Reflector adapter (proposed)

```ts
const reflector = reflectorAdapter(async ({ system, prompt, jsonSchema }, { signal, reportUsage }) => {
  const res = await callYourModel({ system, prompt, jsonSchema, signal });
  reportUsage({ model: res.model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens });
  return res.output; // an object matching jsonSchema, or its JSON
});
```

It mirrors `cloudAdapter()`: the developer's function and key, and usage in the same `CloudUsage`
shape, priced with the same `PriceTable`. The budget is enforced from that usage; a reflector that
reports none is charged a configured flat price per call. The request holds redacted traces only.

### 8. The evaluator and the metric (implemented)

`belay tune --dry-run --task <name> --target <accuracy>` scores the current local side on a split
(by default the validation split) and writes `.belay/tune/<task>/baseline.json`.

- **No cloud call.** `evaluateLocal()`, the local half of `evaluate()`, runs the examples through
  the task's backend: a real Chrome for browser runner specs. The cloud's half of the cascade
  comes from the labels. For a silver label the cloud's answer is the label. For a gold label it
  is the cloud's recorded answer, which the dataset builder now keeps as `cloud`; a gold example
  without one counts at the cloud's accuracy on the gold examples that have one (or
  `--cloud-accuracy`). A night's evaluations therefore cost nothing.
- **The metric.** Of the thresholds between distinct confidences, the lowest whose cascade
  accuracy holds the target; the local share there is the score. Examples count by their `weight`,
  so explored runs stand for the confident runs that were not checked. If no threshold holds the
  target, the most accurate one is reported and the command exits with 2.
- **Interval.** A 95% percentile bootstrap over examples (1,000 resamples, seeded), with the
  threshold fitted again on every resample, so the interval includes the uncertainty of the
  threshold.
- **Two numbers, not one.** Accuracy on gold labels and agreement with the cloud on silver labels
  are reported separately, with a note when the split has fewer than 100 gold labels.
- **Stability.** `--repeat <n>` runs the examples again without the output cache. Runs agree when
  their local shares differ by at most one point; otherwise the command exits with 2. A real
  model is not deterministic, so this is the check that the score can be trusted as a baseline.
- The threshold is fitted on the examples it is scored on, as in `belay calibrate`. The gate (M3)
  fits on validation and scores on the holdout.

`@swissspidy/belay-tune` builds on `@swissspidy/belay-calibrate`, which owns the `belay` binary,
so the binary loads it by name when `belay tune` is run.

Verified with a stub Classifier in Chromium under Playwright, not yet with a built-in model: this
environment has none.

## Open questions

- May the v1 calibration file gain an optional `local.config` fingerprint (§3)? It is a type and a
  check in the core, against the brief's "the core gains no code".
- Should `BelayResult` carry `explorationWeight`? It would replace the event matching of §1.
- Which public dataset anchors M3? The four example tasks already have 300 labeled examples and a
  1,500-input stream each; ticket triage and content moderation are the ones with headroom.
- Whether built-in models accept adapters (rung 5) is still unconfirmed.

## Consequences

- Two packages join the fixed release group. `@swissspidy/belay-calibrate` depends on
  `@swissspidy/belay-trace` for `belay datasets`, and `@swissspidy/belay-tune` depends on both.
- Apps that turn tracing on send inputs to their own server that they already sent to the cloud.
  Anything more is an explicit `content: 'all'`.
- The holdout's stability now depends on a committed manifest. Without it, a split is still
  reproducible from the seed, but near-duplicate clusters can shift as traces arrive.
- Near-duplicate detection is approximate below a similarity of 0.8 (about 1% of pairs at 0.5 are
  not proposed), and is the slowest step on large sets with much shared boilerplate.
