---
"@swissspidy/belay-trace": minor
"@swissspidy/belay-calibrate": minor
"@swissspidy/belay-tune": minor
---

New package `@swissspidy/belay-trace`: `tracedTask()` records runs to your own sink (opt-in; by default only inputs that were sent to the cloud anyway, redacted before storage), and `buildDatasets()` turns traces into training, validation and holdout splits with a frozen holdout. `belay datasets` builds them from the command line.

New package `@swissspidy/belay-tune`: `belay tune --dry-run` scores a task's local side on a split, in a real Chrome and without cloud calls: the local share at a target accuracy, with a bootstrap interval and a check that repeated runs agree.

Calibrate: `evaluateLocal()` runs only the local runner over a dataset, and `createBackend()` builds a task's local backend. See ADR 0007.
