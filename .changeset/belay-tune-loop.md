---
"@swissspidy/belay-tune": minor
"@swissspidy/belay-calibrate": minor
---

Tune: `belay tune` runs the loop on rungs 1 to 3. It fits the threshold again, then asks a reflecting model (`tune.reflector` in the config, your function and your key) for few-shot examples and rules, scores each candidate on validation in a real Chrome, and runs the best one once through a gate on the holdout. A candidate that passes is written as `belay/<task>/<backend>.local.json` with its calibration file; apps apply it with `withLocalConfig()` from `@swissspidy/belay-tune/config`. Every experiment goes to `.belay/ledger.jsonl` (`belay ledger` prints it), spend is capped with `--budget`, and `belay tune --lock` records the gate, the evaluator and the holdout so that the loop cannot change what it is measured by. When the holdout is too small for the gate's accuracy check to tell, the result is "inconclusive" instead of a failure: the report says how many examples would settle it, the candidate is tried again first on the next run, and `belay tune` warns about it before the night starts.

Tune: a promoted config now comes with a gate record (`belay/<task>/<backend>.gate.json`) and the text of a pull request, and `templates/belay-tune.yml` is a GitHub Action that runs the loop nightly and opens it. `belay verify` is the CI check: it fails when the protected files no longer match the lock, when a config was changed without passing the gate, or when the config does worse on the holdout in the current browser than it did at the gate. When a committed config no longer holds its target, `belay tune` repairs it: a candidate that restores the target passes the gate without gaining local share.

Calibrate: local records carry `latencyMs`, a backend can `derive()` a variant for another schema and context, and the config accepts a `tune` section. See ADR 0007.
