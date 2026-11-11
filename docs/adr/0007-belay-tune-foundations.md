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

### 3. Local config (implemented)

Everything tunable about the local side of one task on one backend, as one JSON file:
`belay/<task>/<backend>.local.json`, where `<backend>` names the runner, e.g. `classifier-api`.

```json
{
  "version": 1,
  "task": "ticket-triage",
  "backend": { "runner": "classifier-api" },
  "wording": {
    "prompt": "Which team should handle this ticket?",
    "options": { "billing": "Invoices, refunds, charges, payment methods" }
  },
  "context": "Support tickets for a SaaS billing product.",
  "rules": ["A refund request is billing, even when it mentions a bug."],
  "examples": [{ "input": "I was charged twice", "label": "billing" }]
}
```

- **Applied by a wrapper, not by the core.** `withLocalConfig(runner, config)`, from the
  browser-safe entry `@swissspidy/belay-tune/config`, is a `LocalRunner` that hands the wrapped
  runner the reworded schema and the rendered context. The task's own schema, the cloud's
  instruction and the `schemaFingerprint` do not change, and `@swissspidy/belay-core` gains no
  code. Option labels cannot be reworded: they are the task's values. The evaluator applies a
  candidate with the same function (`applyLocalConfig()`) through the backend's `derive()`.
- **Rules and examples are rendered** into the context by one function. Its size is counted in
  characters (`contextSize()`), not tokens: a token count needs a session per candidate, and the
  character count orders candidates the same way.
- **The threshold stays in the calibration file**, one per backend. The loop writes the config's
  fingerprint into it as an extra `localConfig` field, and reads a committed threshold only when
  that field and the `schemaFingerprint` match. The core does not check the field yet; that
  check is the one change this work will ask of the core.
- **A candidate is a JSON Patch** (RFC 6902: `add`, `remove`, `replace`) to this file plus a
  one-sentence hypothesis. A patch may only touch the roots of its rung, and the patched config
  is parsed again, so a label outside the schema or an unknown field is refused before anything
  runs.
- `runner`, `judge` and `steps` (rungs 4 and 5) are not in the format yet. They are decided in
  M5; the version number is there for that.

### 4. Ledger (implemented)

`.belay/ledger.jsonl`, append-only, one line per experiment:

```json
{
  "version": 1, "id": "m3-acceptance.004", "run": "m3-acceptance", "seq": 4, "timestamp": "2026-11-10T22:05:41Z",
  "task": "ticket-triage", "backend": "classifier-api", "rung": "examples",
  "hypothesis": "Focusing on the order-shipping and order-feedback boundaries will resolve the most frequent misclassifications.",
  "parent": "fnv1a:bf0dbdb0", "candidate": "fnv1a:d38fa892",
  "patch": [{ "op": "add", "path": "/examples", "value": [] }],
  "stage": "validation",
  "scores": { "localShare": 0.982, "accuracy": 0.953, "threshold": 0.727, "targetMet": true, "goldAccuracy": 0.953, "cloudAgreement": null, "contextChars": 786, "examples": 284 },
  "cost": { "currency": "USD", "reflector": 0.0063, "usage": [] },
  "verdict": "kept", "reason": "Local share up 1.8 points on validation at the target accuracy.",
  "environment": { "runner": "classifier-api", "userAgent": "…" },
  "protected": "sha256:…", "seed": "0", "previous": "sha256:…"
}
```

`rung` is `baseline`, `threshold`, `examples`, `rules` or `gate`; `stage` is `baseline`, `screen`,
`validation` or `gate`; `verdict` is `baseline`, `kept`, `discarded`, `promoted`, `rejected`,
`inconclusive` or `error`. `previous` is the SHA-256 of the line before, so an edited history is detectable, and
`readLedger()` refuses a broken chain. `protected` is the lock hash of §5. `scores` are always
validation numbers. A gate entry carries only whether it passed and the names of the failed
checks, so the reflecting model, which is given the ledger, cannot learn the holdout from one
night to the next. `belay ledger` prints the file as a table.

### 5. Protected evaluator (implemented)

The loop is ordinary code, not an agent with a shell, which is the first protection: the
reflecting model returns JSON and never writes a file. On top of that:

1. **A lock file.** `belay.tune.lock.json`, written by `belay tune --lock` and committed by a
   person, holds per task the SHA-256 of the gate config (`belay.gate.json`), of `belay.tune.md`,
   of the built JavaScript of the installed evaluator packages (`-core`, `-web`, `-trace`,
   `-calibrate`, `-tune`), and the ids of the holdout. The loop checks it at the start, before
   the gate and before it writes its outputs, and stops on a mismatch. The holdout may grow
   between nights: the check is that every locked id is still in it. Without a lock file the loop
   does not start.
2. **A path allowlist.** All of the loop's writes go through one workspace object, which only
   accepts `belay/<task>/`, the ledger and `.belay/tune/<task>/`, and refuses a path that leaves
   the project.
3. **Patches are validated** against the roots of their rung (§3) before anything runs.
4. **The holdout is never in a prompt.** The reflecting model is given examples from train and
   validation only; the holdout file is first read when the gate starts.
5. **One gate run per night**, on the best candidate only, recorded in the ledger.

`belay verify` and the pull request are §10. A consequence of hashing the built packages: updating Belay, or
rebuilding it in a checkout, needs a new `belay tune --lock`.

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
in the cache key (closed in M2); per-example latency and a paired bootstrap (closed in M3). web-ai-evals remains the right tool for the gate's support-matrix check across
browsers and backends (M5), through `BrowserSession`.

### 7. Reflector adapter (implemented)

```ts
const reflector = reflectorAdapter(async ({ system, prompt, jsonSchema }, { signal, reportUsage }) => {
  const res = await callYourModel({ system, prompt, jsonSchema, signal });
  reportUsage({ model: res.model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens });
  return res.output; // an object matching jsonSchema, or its JSON
}, 'your-model-id');
```

It mirrors `cloudAdapter()`: the developer's function and key, and usage in the same `CloudUsage`
shape, priced with the same `PriceTable`. It is set as `tune.reflector` in `belay.config.mjs`,
next to `tune.prices`. The budget is enforced from the reported usage; a reflector that reports
none is charged a flat `tune.costPerCall` (0.25 by default). The request
holds the task, the current config, the local model's mistakes and uncertain answers on a sample
of the training split, the ledger's history and `belay.tune.md`. The answer is a list of
candidates, each a hypothesis and a full replacement list for the rung (examples, by training
id, or rules). Examples are referenced by id so that the model cannot invent an input or a
label. Answers are cached, so `--resume` does not pay twice, and a request identical to an
earlier one of the same run is not sent again.

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

**Verified with a built-in model.** Google Chrome 157.0.8103.50 on a 4-core, 16 GB Linux VM
without a GPU (`forceCpu`, headful under Xvfb), with Chrome's built-in classifier, on the 300
labeled ticket-triage examples (`examples/ticket-triage/examples.jsonl`), target 95%, cloud
accuracy set to the calibrated 94.3%, `--repeat 2 --refresh`:

| Run | Threshold | Local share | Accuracy | Kept local |
| --- | --- | --- | --- | --- |
| 1 | 0.959 | 91.0% (95% CI 54.0% to 98.7%) | 95.2% | 95.2% accurate |
| 2 | 0.959 | 91.0% | 95.2% | 95.2% accurate |

The two runs gave identical outputs (spread 0.0 points), with no local failures; 600 runs took 26
minutes including the model load. The interval is wide because the accuracy sits just above the
target: a few examples decide whether a much higher threshold is needed. The loop should not read
a change of a few points on 300 examples as a gain.

Chrome 157 no longer exposes this API as `Classifier` but as `DecisionModel`, and
`classifierApi()` reported "unavailable" there. That run bridged the two with an init script.
ADR 0008 moves `@swissspidy/belay-web` to the new API; 40 of the examples, run again without the
bridge, gave the same outputs.

### 9. The loop and the gate (implemented)

`belay tune --task <name> --budget <amount>` runs one night:

1. **Check the lock** (§5), load train and validation, and score the committed config on
   validation. That is the baseline, entry 0 of the run.
2. **Rung 1, threshold.** If a calibration file for this config exists and its threshold is no
   longer the best one on validation, the refitted threshold is a candidate like any other.
3. **Rungs 2 and 3, examples and rules.** Each round, the local model's outputs on a sample of
   the training split (150) are diagnosed, the reflecting model is asked for four candidates, and
   each is screened on 60 validation examples before it is scored on all of them. A candidate is
   kept when it beats its parent's local share by half a point at the target accuracy; the best
   three form the population the next round starts from. Two rounds without a kept candidate
   move the loop from examples to rules, and then end it.
4. **The gate**, once, for the best candidate if it beats the baseline: baseline and candidate
   both run on the holdout, each with the threshold it was given on validation.
5. **Outputs.** A promoted candidate is written as the local config and its calibration file.
   In every case the ledger and `.belay/tune/<task>/report.md` and `.json` are written.

The loop stops early on `--budget` (reflector spend), `--max-experiments`, `--max-minutes` or a
reflector error, and then still gates the best candidate it has. `--resume` continues a run from
the output cache and the cached reflector answers.

**The gate's checks**, with the defaults of `belay.gate.json`:

| Check | Passes when |
| --- | --- |
| accuracy | the lower bound of a paired 95% bootstrap interval of the accuracy difference is above −1 point |
| local-share | local share is up by 3 points, or not down with a smaller prompt |
| recall | no label's recall drops by more than 5 points |
| calibration | the expected calibration error rises by at most 0.01 |
| latency | the 95th percentile is at most 10% (plus 5 ms) slower |
| prompt-size | prompt, context, rules and examples are at most 2,000 characters |

With fewer than 100 gold labels on the holdout the gate measures agreement with the cloud and
says so. Against the brief: the size limit is in characters, not tokens (§3); the latency check
has a 5 ms allowance, because on fast runners 10% is below the timer's noise; and the report is
Markdown and JSON, with no HTML.

**Verified with a built-in model.** Same machine and Chrome as §8, ticket triage with the
1,500-input stream as gold-labeled traces (915 train, 284 validation, 301 holdout), target 95%,
Gemini as the reflecting model, `--budget 5usd --max-experiments 20`:

| | Validation | Holdout |
| --- | --- | --- |
| Baseline | 96.5% local at 95.2% | 96.0% local at 97.1% |
| Best candidate (six few-shot examples) | 100.0% local at 95.8% | 100.0% local at 97.3% |

- 20 experiments in about three hours: 5 kept, 15 discarded (11 at screening), no
  errors. All four rule candidates were screened out: rules made this model less confident.
- The reflecting model cost 0.19 USD in 5 calls, against a cap of 5.
- The gate **rejected** the candidate, and nothing was written. Local share passed (+4.0 points,
  interval +2.0 to +6.3), as did recall, calibration (0.017 against 0.037) and prompt size.
  Accuracy failed: +0.2 points, but the interval reached −1.5. Latency failed: the 95th
  percentile rose from 2,145 ms to 2,690 ms (+25%).
- The lock hash was the same at the start and the end.

What this run says about the design:

- **The accuracy check cannot pass at this size.** On 300 examples the paired interval is about
  ±2 points wide, so a candidate that is in fact slightly better is still refused by a 1-point
  margin. The check needs about 900 holdout examples, or a wider margin. See "Inconclusive"
  below for what was decided.
- **Few-shot examples cost latency on a CPU.** 330 more characters of context made each run
  about a quarter slower. Whether that is worth four points of local share is a product
  decision; the gate's default says no.
- **This task has little headroom.** The baseline already keeps 96% local, so the largest
  possible gain is barely above the gate's minimum. Content moderation is the better task to
  show a promotion on.
- **Rebuilding Belay during a run stops it at the gate**, because the evaluator hash changes.
  That is the protection working, and worth a line in the docs.

**Inconclusive (decided after that run).** The margin does not widen with a small holdout. A
margin that follows the uncertainty is weakest where the evidence is weakest, and since each
promotion is the next baseline, the allowance could be spent every night: a ratchet. Instead:

- The gate has a third result. It is **inconclusive** when accuracy is the only check that
  failed and the interval lies on both sides of the margin: the candidate is neither shown to
  be safe nor shown to be worse. Nothing is written. The ledger entry's verdict is
  `inconclusive`, and the report gives the holdout size that would settle it, from the width of
  the interval (it narrows with the square root of the size). For the run above that is about
  900; that run would still have been rejected, on latency.
- The candidate is kept in `.belay/tune/<task>/<backend>.pending.json` and is the first
  experiment of the next run: scored on the then-current validation split and, if it is still
  the best, gated again on the larger holdout. Any other end of a run removes the file.
- `belay tune` warns at the start when the locked holdout is probably too small
  (`holdoutPower()`). The estimate assumes a candidate as accurate as the baseline that changes
  the outcome of half as many inputs as the baseline gets wrong, which is what the few-shot
  candidate did above. It is a warning, not a stop: the other rungs' findings are still worth
  a night.
- Widening stays a person's choice: `accuracyMargin` in `belay.gate.json`, then
  `belay tune --lock`.

### 10. Pull request, verify and drift (implemented)

**The gate record.** A promoted config is written with a third file,
`belay/<task>/<backend>.gate.json`: for every holdout input, the local confidence and whether the
local answer was right, with the threshold, the environment and the aggregate scores. It holds
ids, not input text. It is the only place holdout results are kept, and the loop never reads it,
so the rule of §4 stands: the reflecting model cannot learn the holdout.

**The pull request.** A promotion also writes `.belay/tune/<task>/pull-request.md` and
`pull-request-title.txt`: the hypothesis, the numbers on validation and on the holdout, the
gate's checks, the kept experiments and a reviewer's checklist. `templates/belay-tune.yml` runs
the loop nightly and opens the pull request with `gh`, from the workflow's own token. The
ledger, a pending candidate and the output cache live in the Actions cache between nights, since
most nights end without a merge; the pull request carries the ledger as it stood. The traces
are the developer's to fetch: the template has an empty step for it.

**`belay verify`.** The brief's "re-run the gate on current browser versions" cannot be taken
literally: the gate compares a candidate with the config before it, and after a merge there is
no candidate. What CI needs to know is whether the merged config still does what it was promoted
for. So verify:

1. checks the lock and the ledger's chain;
2. checks that config, calibration file and gate record carry the same config fingerprint and
   threshold, so a hand-edited config fails without a model run;
3. runs the config on the holdout in the current browser, without the output cache, and pairs
   each input with its line in the gate record. It fails on a drop beyond the gate's margins:
   accuracy (`accuracyMargin`), local share (`minLocalShareGain`: the gain the gate asked for is
   gone), a label's recall, the calibration error.

Two differences from the gate, both deliberate. Verify judges the measured difference, not the
lower end of its interval: runs in one browser are repeatable (§8), so a difference is a change
of the model or the runner, and a CI check that could never fail on a small holdout would be no
check. And latency is reported but not judged, because the CI machine is not the tuning machine.
Verify needs the holdout, so CI must be able to build the datasets: the same traces and the
committed manifest.

**Drift.** When verify fails, the remedy is `belay tune` in the new browser. A run whose
committed config no longer holds the target on validation is a repair:

- rung 1 keeps a refitted threshold that holds the target although it keeps less local, and on
  the other rungs a candidate that holds the target beats a parent that does not;
- the gate is run with the local-share check not required, since the comparison is with a config
  that is broken. Accuracy, recall, calibration, latency and prompt size apply as always.

The alternative, a `verify --update` that records today's behaviour as the new reference, was
rejected: it would let a config through that never passed a gate in the browser it runs in.

**Verified.** Tests with a stub model cover a promotion with its record and pull request text,
verify passing on the same model, failing after a simulated model update, on an edited config and
on a changed gate config, and a repair run that ends in a "restore" pull request which then
verifies. On Chrome 157 (the setup of §9), the rejected candidate of §9 was carried over as a
pending candidate and promoted under a scratch gate widened to 2 points of accuracy and 30% of
latency, from cached outputs, which produced the three files and the pull request text. `belay verify` then ran the 301 holdout
inputs again in that Chrome without the cache and passed with no difference: 97.3% accuracy and
100.0% local share, as at the gate, and no note of an input answered differently. That is the
repeatability the point-estimate rule relies on. A failing verify was only shown with the stub
model: there was no second Chrome version to drift to.

Not verified: the two workflow templates have not run on GitHub's runners. They parse as YAML, and
the `belay` commands in them were run here; the cache, push and `gh` steps were not. Whether a hosted runner can load Chrome's built-in
model (it needs about 4 GB of download and, without a GPU, 16 GB of memory) is also untested.

## Open questions

- Should the core check the calibration file's `localConfig` fingerprint (§3)? Today only the
  loop reads it.
- Should `BelayResult` carry `explorationWeight`? It would replace the event matching of §1.
- Whether built-in models accept adapters (rung 5) is still unconfirmed.
- Can a GitHub-hosted runner load Chrome's built-in model (§10)? If not, the nightly loop needs a
  self-hosted runner.

## Consequences

- Two packages join the fixed release group. `@swissspidy/belay-calibrate` depends on
  `@swissspidy/belay-trace` for `belay datasets`, and `@swissspidy/belay-tune` depends on both.
- Apps that turn tracing on send inputs to their own server that they already sent to the cloud.
  Anything more is an explicit `content: 'all'`.
- The holdout's stability now depends on a committed manifest. Without it, a split is still
  reproducible from the seed, but near-duplicate clusters can shift as traces arrive.
- Near-duplicate detection is approximate below a similarity of 0.8 (about 1% of pairs at 0.5 are
  not proposed), and is the slowest step on large sets with much shared boilerplate.
