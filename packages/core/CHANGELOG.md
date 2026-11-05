# @swissspidy/belay-core

## 0.2.0

### Minor Changes

- [#12](https://github.com/swissspidy/belay/pull/12) [`4e79ec3`](https://github.com/swissspidy/belay/commit/4e79ec3f3d87b082a54c7d36ae308df63aa60870) Thanks [@swissspidy](https://github.com/swissspidy)! - Learned classifier, part two (ADR 0005).
  
  Core: `explore: { rate, strategy: 'informative', floor }` spot-checks the runs the local runner is least sure of (it may report `informativeness`), with an inverse-probability `explorationWeight` on the learn example and run event; `costAwareThreshold()` derives a threshold from the cost of a mistake and of a cloud call (for a confidence calibrated against the cloud's answers, or with `calibratedAgainst: 'labels'`, against labels).
  
  Learn: a distance gate (on by default; `distanceGate: false` to disable) escalates inputs far from the stored examples; `informativeness` from margin and head disagreement; `exportState()` / `importState()` snapshots (validated, merged without double counting, safe against concurrent runs); `persistStorage()`; `simulateLearning()` to evaluate it on labeled data.
  
  Calibrate: `belay seed` builds a seed file and `belay simulate` streams labeled data through a learned classifier, configured by a task's optional `learn` section.

- [#10](https://github.com/swissspidy/belay/pull/10) [`39d3161`](https://github.com/swissspidy/belay/commit/39d31619a3595a6de5e4b3186b3fd24cff61ae2e) Thanks [@swissspidy](https://github.com/swissspidy)! - Add `@swissspidy/belay-learn`, a local runner that learns from the cloud's answers: on-device embeddings (transformers.js) with a k-nearest-neighbors or softmax head, calibrated by Platt scaling on its own record, stored in memory or IndexedDB, and optionally started from a seed file (`buildSeed()`).
  
  Core: local runners can implement `learn()`, which the task calls with every validated cloud answer; `task.feedback(input, value)` passes a correction to it; `explore` sends a share of confident runs to the cloud anyway (escalation reason `exploration`); run events carry `localLabel`; `savingsMeter()` counts `explored` runs.

## 0.1.1

### Patch Changes

- [#7](https://github.com/swissspidy/belay/pull/7) [`33b2d4e`](https://github.com/swissspidy/belay/commit/33b2d4e23a357cf6a8b01bd5810ef21e5eb6bae8) Thanks [@swissspidy](https://github.com/swissspidy)! - Include the build output. 0.1.0 was published without `dist/`, so its entry points and the `belay` command were missing.
