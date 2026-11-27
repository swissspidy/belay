# @swissspidy/belay-tune

## 0.2.0

### Minor Changes

- [#27](https://github.com/swissspidy/belay/pull/27) [`b34a250`](https://github.com/swissspidy/belay/commit/b34a250dbc2e85e6731bcb18368976c2518f5f46) Thanks [@swissspidy](https://github.com/swissspidy)! - New package `@swissspidy/belay-trace`: `tracedTask()` records runs to your own sink (opt-in; by default only inputs that were sent to the cloud anyway, redacted before storage), and `buildDatasets()` turns traces into training, validation and holdout splits with a frozen holdout. `belay datasets` builds them from the command line.
  
  New package `@swissspidy/belay-tune`: `belay tune --dry-run` scores a task's local side on a split, in a real Chrome and without cloud calls: the local share at a target accuracy, with a bootstrap interval and a check that repeated runs agree.
  
  Calibrate: `evaluateLocal()` runs only the local runner over a dataset, and `createBackend()` builds a task's local backend. See ADR 0007.

- [#27](https://github.com/swissspidy/belay/pull/27) [`b34a250`](https://github.com/swissspidy/belay/commit/b34a250dbc2e85e6731bcb18368976c2518f5f46) Thanks [@swissspidy](https://github.com/swissspidy)! - Tune: `belay tune` runs the loop. It fits the threshold again, then asks a reflecting model (`tune.reflector` in the config, your function and your key) for few-shot examples and rules, scores each candidate on validation in a real Chrome, and runs the best one once through a gate on the holdout. A candidate that passes is written as `belay/<task>/<backend>.local.json` with its calibration file; apps apply it with `withLocalConfig()` from `@swissspidy/belay-tune/config`. Every experiment goes to `.belay/ledger.jsonl` (`belay ledger` prints it), spend is capped with `--budget`, and `belay tune --lock` records the gate, the evaluator and the holdout so that the loop cannot change what it is measured by. When the holdout is too small for the gate's accuracy check to tell, the result is "inconclusive" instead of a failure: the report says how many examples would settle it, the candidate is tried again first on the next run, and `belay tune` warns about it before the night starts.
  
  Tune: a promoted config now comes with a gate record (`belay/<task>/<backend>.gate.json`) and the text of a pull request, and `templates/belay-tune.yml` is a GitHub Action that runs the loop nightly and opens it. `belay verify` is the CI check: it fails when the protected files no longer match the lock, when a config was changed without passing the gate, or when the config does worse on the holdout in the current browser than it did at the gate. When a committed config no longer holds its target, `belay tune` repairs it: a candidate that restores the target passes the gate without gaining local share.
  
  Tune: a fourth rung rewords the question and the labels' descriptions for the local model (never the labels themselves). A task can have more than one local backend: name the others in `tune.backends`, tune each with `belay tune --backend <name>`, and each gets its own config, calibration file, gate record and reports; `belay verify` checks them all. The reports of a run are now named after the backend (`.belay/tune/<task>/<backend>.report.md`).
  
  Calibrate: local records carry `latencyMs`, a backend can `derive()` a variant for another schema and context, and the config accepts a `tune` section, with `tune.backends` for further local backends. See ADR 0007.

### Patch Changes

- [#28](https://github.com/swissspidy/belay/pull/28) [`2c29de4`](https://github.com/swissspidy/belay/commit/2c29de4d2e9d21ccfaebbb057b6dc4cb8f532449) Thanks [@swissspidy](https://github.com/swissspidy)! - Tune: the loop fits a candidate's threshold so that no label's recall falls more than half of the gate's `maxRecallDrop` below the baseline's on validation. Before, a candidate could reach a high local share by giving up one label, and was then rejected by the gate's recall check on the holdout. `score()` takes the floors as `recallFloor`.
- Updated dependencies [[`b34a250`](https://github.com/swissspidy/belay/commit/b34a250dbc2e85e6731bcb18368976c2518f5f46), [`b34a250`](https://github.com/swissspidy/belay/commit/b34a250dbc2e85e6731bcb18368976c2518f5f46), [`b34a250`](https://github.com/swissspidy/belay/commit/b34a250dbc2e85e6731bcb18368976c2518f5f46), [`4e79ec3`](https://github.com/swissspidy/belay/commit/4e79ec3f3d87b082a54c7d36ae308df63aa60870), [`39d3161`](https://github.com/swissspidy/belay/commit/39d31619a3595a6de5e4b3186b3fd24cff61ae2e), [`2c29de4`](https://github.com/swissspidy/belay/commit/2c29de4d2e9d21ccfaebbb057b6dc4cb8f532449)]:
  - @swissspidy/belay-trace@0.2.0
  - @swissspidy/belay-calibrate@0.2.0
  - @swissspidy/belay-core@0.2.0
