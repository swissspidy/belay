---
"@swissspidy/belay-core": minor
"@swissspidy/belay-learn": minor
"@swissspidy/belay-calibrate": minor
---

Learned classifier, part two (ADR 0005).

Core: `explore: { rate, strategy: 'informative', floor }` spot-checks the runs the local runner is least sure of (it may report `informativeness`), with an `explorationWeight` on the learn example and run event that keeps estimates unbiased; `costAwareThreshold()` derives a threshold from the cost of a mistake and of a cloud call.

Learn: a distance gate (on by default; `distanceGate: false` to disable) escalates inputs far from the stored examples; `informativeness` from margin and head disagreement; `exportState()` / `importState()` snapshots; `persistStorage()`; `simulateLearning()` to evaluate it on labeled data.

Calibrate: `belay seed` builds a seed file and `belay simulate` streams labeled data through a learned classifier, configured by a task's optional `learn` section.
