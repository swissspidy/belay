---
"@swissspidy/belay-tune": minor
"@swissspidy/belay-calibrate": minor
---

Tune: `belay tune` runs the loop on rungs 1 to 3. It fits the threshold again, then asks a reflecting model (`tune.reflector` in the config, your function and your key) for few-shot examples and rules, scores each candidate on validation in a real Chrome, and runs the best one once through a gate on the holdout. A candidate that passes is written as `belay/<task>/<backend>.local.json` with its calibration file; apps apply it with `withLocalConfig()` from `@swissspidy/belay-tune/config`. Every experiment goes to `.belay/ledger.jsonl` (`belay ledger` prints it), spend is capped with `--budget`, and `belay tune --lock` records the gate, the evaluator and the holdout so that the loop cannot change what it is measured by.

Calibrate: local records carry `latencyMs`, a backend can `derive()` a variant for another schema and context, and the config accepts a `tune` section. See ADR 0007.
