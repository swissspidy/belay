---
"@swissspidy/belay-core": minor
"@swissspidy/belay-learn": minor
"@swissspidy/belay-calibrate": minor
---

Learned classifier, part two (ADR 0005).

Core: `explore: { rate, strategy: 'informative', floor }` spot-checks the runs the local runner is least sure of (it may report `informativeness`), with an inverse-probability `explorationWeight` on the learn example and run event; `costAwareThreshold()` derives a threshold from the cost of a mistake and of a cloud call (for a confidence calibrated against the cloud's answers, or with `calibratedAgainst: 'labels'`, against labels).

Learn: a distance gate (on by default; `distanceGate: false` to disable) escalates inputs far from the stored examples; `informativeness` from margin and head disagreement; `exportState()` / `importState()` snapshots (validated, merged without double counting, safe against concurrent runs); `persistStorage()`; `simulateLearning()` to evaluate it on labeled data.

Calibrate: `belay seed` builds a seed file and `belay simulate` streams labeled data through a learned classifier, configured by a task's optional `learn` section.
