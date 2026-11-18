# @swissspidy/belay-calibrate

## 0.2.0

### Minor Changes

- [#27](https://github.com/swissspidy/belay/pull/27) [`b34a250`](https://github.com/swissspidy/belay/commit/b34a250dbc2e85e6731bcb18368976c2518f5f46) Thanks [@swissspidy](https://github.com/swissspidy)! - New package `@swissspidy/belay-trace`: `tracedTask()` records runs to your own sink (opt-in; by default only inputs that were sent to the cloud anyway, redacted before storage), and `buildDatasets()` turns traces into training, validation and holdout splits with a frozen holdout. `belay datasets` builds them from the command line.
  
  New package `@swissspidy/belay-tune`: `belay tune --dry-run` scores a task's local side on a split, in a real Chrome and without cloud calls: the local share at a target accuracy, with a bootstrap interval and a check that repeated runs agree.
  
  Calibrate: `evaluateLocal()` runs only the local runner over a dataset, and `createBackend()` builds a task's local backend. See ADR 0007.

- [#27](https://github.com/swissspidy/belay/pull/27) [`b34a250`](https://github.com/swissspidy/belay/commit/b34a250dbc2e85e6731bcb18368976c2518f5f46) Thanks [@swissspidy](https://github.com/swissspidy)! - Tune: `belay tune` runs the loop. It fits the threshold again, then asks a reflecting model (`tune.reflector` in the config, your function and your key) for few-shot examples and rules, scores each candidate on validation in a real Chrome, and runs the best one once through a gate on the holdout. A candidate that passes is written as `belay/<task>/<backend>.local.json` with its calibration file; apps apply it with `withLocalConfig()` from `@swissspidy/belay-tune/config`. Every experiment goes to `.belay/ledger.jsonl` (`belay ledger` prints it), spend is capped with `--budget`, and `belay tune --lock` records the gate, the evaluator and the holdout so that the loop cannot change what it is measured by. When the holdout is too small for the gate's accuracy check to tell, the result is "inconclusive" instead of a failure: the report says how many examples would settle it, the candidate is tried again first on the next run, and `belay tune` warns about it before the night starts.
  
  Tune: a promoted config now comes with a gate record (`belay/<task>/<backend>.gate.json`) and the text of a pull request, and `templates/belay-tune.yml` is a GitHub Action that runs the loop nightly and opens it. `belay verify` is the CI check: it fails when the protected files no longer match the lock, when a config was changed without passing the gate, or when the config does worse on the holdout in the current browser than it did at the gate. When a committed config no longer holds its target, `belay tune` repairs it: a candidate that restores the target passes the gate without gaining local share.
  
  Tune: a fourth rung rewords the question and the labels' descriptions for the local model (never the labels themselves). A task can have more than one local backend: name the others in `tune.backends`, tune each with `belay tune --backend <name>`, and each gets its own config, calibration file, gate record and reports; `belay verify` checks them all. The reports of a run are now named after the backend (`.belay/tune/<task>/<backend>.report.md`).
  
  Calibrate: local records carry `latencyMs`, a backend can `derive()` a variant for another schema and context, and the config accepts a `tune` section, with `tune.backends` for further local backends. See ADR 0007.

- [#27](https://github.com/swissspidy/belay/pull/27) [`b34a250`](https://github.com/swissspidy/belay/commit/b34a250dbc2e85e6731bcb18368976c2518f5f46) Thanks [@swissspidy](https://github.com/swissspidy)! - `classifierApi()` and `classifierJudge()` now run on Chrome 157's DecisionModel API (`globalThis.DecisionModel`, `decide()`, question types `boolean` / `choice` / `score`, probabilities keyed by label), which replaced the proposed Classifier API. Chrome 157 or later is required; older versions and the old `globalThis.Classifier` shape are no longer supported. An implementation passed as `classifierApi({ classifier })` must have the new shape. `belay calibrate` and `belay tune` enable the `AIDecisionModelAPI` feature themselves. See ADR 0008.

- [#12](https://github.com/swissspidy/belay/pull/12) [`4e79ec3`](https://github.com/swissspidy/belay/commit/4e79ec3f3d87b082a54c7d36ae308df63aa60870) Thanks [@swissspidy](https://github.com/swissspidy)! - Learned classifier, part two (ADR 0005).
  
  Core: `explore: { rate, strategy: 'informative', floor }` spot-checks the runs the local runner is least sure of (it may report `informativeness`), with an inverse-probability `explorationWeight` on the learn example and run event; `costAwareThreshold()` derives a threshold from the cost of a mistake and of a cloud call (for a confidence calibrated against the cloud's answers, or with `calibratedAgainst: 'labels'`, against labels).
  
  Learn: a distance gate (on by default; `distanceGate: false` to disable) escalates inputs far from the stored examples; `informativeness` from margin and head disagreement; `exportState()` / `importState()` snapshots (validated, merged without double counting, safe against concurrent runs); `persistStorage()`; `simulateLearning()` to evaluate it on labeled data.
  
  Calibrate: `belay seed` builds a seed file and `belay simulate` streams labeled data through a learned classifier, configured by a task's optional `learn` section.

### Patch Changes

- Updated dependencies [[`b34a250`](https://github.com/swissspidy/belay/commit/b34a250dbc2e85e6731bcb18368976c2518f5f46), [`b34a250`](https://github.com/swissspidy/belay/commit/b34a250dbc2e85e6731bcb18368976c2518f5f46), [`4e79ec3`](https://github.com/swissspidy/belay/commit/4e79ec3f3d87b082a54c7d36ae308df63aa60870), [`13cb21a`](https://github.com/swissspidy/belay/commit/13cb21a7931238f6ae14c9e0728934c65dd19996), [`39d3161`](https://github.com/swissspidy/belay/commit/39d31619a3595a6de5e4b3186b3fd24cff61ae2e), [`b34a250`](https://github.com/swissspidy/belay/commit/b34a250dbc2e85e6731bcb18368976c2518f5f46), [`2c29de4`](https://github.com/swissspidy/belay/commit/2c29de4d2e9d21ccfaebbb057b6dc4cb8f532449)]:
  - @swissspidy/belay-trace@0.2.0
  - @swissspidy/belay-web@0.2.0
  - @swissspidy/belay-core@0.2.0
  - @swissspidy/belay-learn@0.2.0

## 0.1.1

### Patch Changes

- [#7](https://github.com/swissspidy/belay/pull/7) [`33b2d4e`](https://github.com/swissspidy/belay/commit/33b2d4e23a357cf6a8b01bd5810ef21e5eb6bae8) Thanks [@swissspidy](https://github.com/swissspidy)! - Include the build output. 0.1.0 was published without `dist/`, so its entry points and the `belay` command were missing.
- Updated dependencies [[`33b2d4e`](https://github.com/swissspidy/belay/commit/33b2d4e23a357cf6a8b01bd5810ef21e5eb6bae8)]:
  - @swissspidy/belay-core@0.1.1
  - @swissspidy/belay-web@0.1.1
