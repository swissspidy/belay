# ADR 0003: Targets relative to the cloud, measured cost, held-out accuracy

- Status: Accepted
- Date: 2026-09-29
- Scope: `@swissspidy/belay-core`, `@swissspidy/belay-calibrate`, examples
- Amends: ADR 0001, Decision 4 (calibration file); ADR 0002, Decision 7 (reference cloud)

## Context

The first calibrations against a real cloud model (Claude Opus 5.5) exposed three problems.

1. **A fixed accuracy target can buy savings with accuracy.** Intent detection had a 95% target,
   but Claude alone reached 99.3%. The recommended threshold met 95% by keeping 87% of runs on a
   less accurate local model, so the cascade was cheaper and *worse* than the cloud alone. Users
   expect a cascade to save money without losing accuracy, and, where the local model knows
   something the cloud does not, to gain some.
2. **Cost was a guess.** `cost.cloudPerRun` was a hand-typed $0.003 per call. The measured cost
   of Opus 5.5 on these tasks was $0.0016–$0.0023, so every saving in the reports was wrong by up
   to half. Claude's server-side refusal fallback also means one call can be served, and billed, by
   two models.
3. **The recommended threshold flatters itself.** It is fitted and scored on the same examples.
   The more the target rewards accuracy, the more a lucky threshold inflates the numbers.

## Decisions

### 1. The target can be relative to the cloud, and `'cloud'` is the default

`target` is a number, `'cloud'` or `'max'`:

- `'cloud'` (default) resolves to the cloud-only accuracy on the dataset. The recommended
  threshold is the lowest one at least that accurate, so the cascade saves as much as it can
  without losing accuracy.
- `'max'` resolves to the best accuracy on the curve; ties go to the lowest threshold (most local
  share). It beats the cloud when, among the runs it keeps local, the local model is right more
  often where the cloud is wrong than the reverse.
- A number keeps the old behavior.

The file records the resolved accuracy and the mode: `target: { metric, value, mode }`. The
report and CLI show a head-to-head count for the runs kept local (local right where the cloud was
wrong, and the reverse), which is exactly the accuracy gained or lost against cloud only.

The default changed from 0.95 to `'cloud'`. A number below the cloud's accuracy is still allowed,
but it is no longer what you get without asking.

### 2. Cost is measured from token usage, per model

- `CloudOutput.usage` is the call's token usage: one part, or one part per model when several
  served the call. `cloudAdapter` functions report it with `reportUsage()`, since their return
  value may itself be a `{ value }` object. `fetchAdapter` takes a `usage(json)` extractor.
- `cost.prices` is a table of per-million-token prices keyed by the model id the provider
  reports. `costOf()` prices each part at its own model's rates. A model without a price throws:
  a guessed price would make every saving wrong.
- With `prices`, a cached cloud output without usage is fetched again, and a runner that reports
  no usage fails the run with a message pointing at `cloudPerRun`.
- Each escalated example is priced at its own measured cost; failed calls at the mean. The file
  records `cost.basis` (`measured` or `estimate`), the prices actually used, the mean tokens per
  call, `expected.cloudOnlyCostPer1k` and `expected.savingsPer1k`. `cloudPerRun` stays in the
  file as the mean measured cost, so older readers still work.
- The report adds a savings tile and a projection for an editable monthly volume
  (`cost.runsPerMonth`).

Price tables live with the runner that calls the model (the examples copy them from the
providers' pricing pages, with the date checked), not in `@swissspidy/belay-core`, because prices change
more often than the library.

### 3. Every calibration includes a held-out estimate

`crossValidate()` fits the thresholds on four fifths of the examples and routes the fifth with
them, over five interleaved folds. The file stores it as `expected.heldOut`; the report and CLI
show it next to the in-sample numbers. It is skipped for datasets under 50 examples.

### 4. Production savings come from telemetry

`RunEvent.cloudUsage` carries the usage of the cloud call. `savingsMeter()` consumes run events
and reports spend, calls avoided, and the share of the cloud-only bill saved. Only runs kept local
because the local answer was confident count as savings; runs kept local because escalation was
blocked are reported separately.

### 5. The examples compare two cloud models

The examples calibrate each task against Claude Opus 5.5 and against Jev 1.13 (TypeSafe AI), a
classification model that answers typed questions with probabilities. `jevCloud()` maps a
categorical or ordinal schema to one Choice question (option descriptions become its criteria)
and a binary schema to one Noul question, and pins `jev-1.13.0` rather than the `jev-latest`
alias so a calibration keeps matching the model that answers. The examples use `target: 'max'`,
justified by the held-out estimate.

Each example then uses the cloud that suited it best in that comparison (Claude for ticket
triage, Jev for moderation) or, for intent detection, `cloudCascade(jev, claude)`: Jev answers
when its own confidence is at least 0.8, Claude otherwise. That routing lives in the examples as a
cloud runner, not in `@swissspidy/belay-core`: the usage of both calls is reported, so the calibration prices
it correctly, and the library's cascade stays one local tier and one cloud tier.

## Consequences

- Calibration files gain optional fields (`target.mode`, `cost.basis`, `cost.prices`,
  `cost.tokensPerRun`, `cost.runsPerMonth`, `expected.cloudOnlyCostPer1k`,
  `expected.savingsPer1k`, `expected.heldOut`). The format version stays 1; `parseCalibration()`
  does not require them.
- Projects that relied on the implicit 0.95 target get a different threshold on their next
  calibration. Set `target: 0.95` to keep it.
- Switching to measured prices re-queries the cloud once for outputs cached before usage was
  recorded. The answers of a non-deterministic cloud model can change on that pass.
- The held-out estimate costs five extra analyses per calibration: negligible next to the model
  calls.
