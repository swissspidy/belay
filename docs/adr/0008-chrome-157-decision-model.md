# ADR 0008: Chrome 157's DecisionModel replaces the Classifier API

- Status: Accepted
- Date: 2026-11-10
- Scope: `@swissspidy/belay-web` (`classifierApi()`, `classifierJudge()`), the browser harness of `@swissspidy/belay-calibrate`
- Amends: ADR 0001 ("What the Classifier API looks like today"), ADR 0002 §8

## Context

ADR 0001 built `classifierApi()` on the proposed Classifier API: `globalThis.Classifier`, behind
`chrome://flags/#classifier-api`. Google Chrome 157.0.8103.50 ships it under another name, and the
current WebAI Studio extension polyfills the new name and no longer defines `window.Classifier`.
On Chrome 157, `classifierApi()` reported "unavailable" and every run escalated.

What Chrome 157 has, as observed in the browser:

| | Classifier API (ADR 0001) | Chrome 157 |
| --- | --- | --- |
| Global | `Classifier` | `DecisionModel` |
| Feature | `#classifier-api` flag | `AIDecisionModelAPI`, off by default |
| Run | `classify(input, options)` | `decide(input, options)` |
| Question types | `binary`, `categorical`, `ordinal` | `boolean`, `choice`, `score` |
| Options | `{ label, description }` | the same; not allowed on `boolean` |
| `probabilities` | array of `{ label, probability }` | object keyed by label |
| Yes/no result | `probability` = P(true) | `label` "true" or "false", `probabilities.true` and `.false` |
| Score result | `expectedScore` | the same |

Unchanged: `availability()` and `create()` with `questions`, `context`, `expectedInputs`, `monitor`
and `signal`; the result keyed by question id; `confidence` as the probability of the label; a user
gesture for the download.

## Decision

Belay supports Chrome 157 and later, and nothing older.

- `classifierApi()` uses `globalThis.DecisionModel`, calls `decide()`, sends `boolean`, `choice` and
  `score` for binary, categorical and ordinal schemas, and reads `probabilities` as an object. The
  old shapes are not read any more.
- **Belay's own names stay.** `classifierApi()`, `classifierJudge()`, the runner id
  `classifier-api`, the `classifier` option and the `Classifier*` types keep their names, so apps,
  calibration files and output caches are unaffected. "Classifier" is what the runner does;
  DecisionModel is the API it runs on.
- **The harness enables the feature.** `belay calibrate` and `belay tune` add
  `AIDecisionModelAPI` to `--enable-features` when a task uses `classifier-api` or
  `classifier-judge` and no extension is loaded. An extension brings its own implementation.
- Task schemas do not change: `binary`, `categorical` and `ordinal` are Belay's terms.

## Verification

Google Chrome 157.0.8103.50, 4-core Linux VM without a GPU (`forceCpu`, headful under Xvfb):

- `boolean`, `choice` and `score` questions, with option descriptions, a context at `create()` and
  at `decide()`, download progress events and an aborted signal behave as the table says.
- `belay tune --dry-run` on 40 ticket-triage examples with a plain config (no init script) gave,
  for every example, the same label and confidence as the earlier run through a hand-written
  bridge (ADR 0007 §8).

Not verified: the WebAI Studio extension's polyfill. Its source defines `DecisionModel`, but it was
not built and run here. The example calibrations in `examples/` were made with its older
`Classifier` build and have not been made again.

## Consequences

- With Chrome 156 or older, or an old build of the extension, `classifierApi()` reports
  "unavailable" and tasks escalate (`local-unavailable`), as on any browser without the API.
- An implementation passed as `classifierApi({ classifier })` must have the new shape.
- Model-specific notes in earlier ADRs (a 256-token window, Laya's variants) describe the
  extension's model, not Chrome's.

## Addendum: constrained prompts fail after a session is destroyed

Found while tuning a second backend (ADR 0007 §11), on Chrome 157.0.8103.50 with the CPU backend.
With the Prompt API, a `prompt()` with a `responseConstraint` fails with
`UnknownError: … kErrorUnknown` when another session that had made a constrained prompt was
destroyed shortly before. `promptApi()` clones a base session per run and destroys the clone, so
exactly every third run failed, whatever the input. Measured directly in the page, seven runs
each:

| Variant | Result |
| --- | --- |
| clone, constrained prompt, destroy | fails on runs 3 and 6 |
| the same with a 1.5 s pause after destroy | fails on runs 3 and 6 |
| clone, constrained prompt, never destroy | all pass |
| clone, unconstrained prompt, destroy | all pass |
| new session per run, constrained prompt, destroy | fails on run 2 |

The failed prompt succeeds when asked again on a fresh clone. Not destroying sessions would leak
them, so `promptApi()` now tries once more on `UnknownError` and passes on a second failure or
any other error. Whether the GPU backend or later versions behave the same is not known.
