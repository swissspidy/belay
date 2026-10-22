# @swissspidy/belay-learn

## 0.2.0

### Minor Changes

- [#12](https://github.com/swissspidy/belay/pull/12) [`4e79ec3`](https://github.com/swissspidy/belay/commit/4e79ec3f3d87b082a54c7d36ae308df63aa60870) Thanks [@swissspidy](https://github.com/swissspidy)! - Learned classifier, part two (ADR 0005).
  
  Core: `explore: { rate, strategy: 'informative', floor }` spot-checks the runs the local runner is least sure of (it may report `informativeness`), with an inverse-probability `explorationWeight` on the learn example and run event; `costAwareThreshold()` derives a threshold from the cost of a mistake and of a cloud call (for a confidence calibrated against the cloud's answers, or with `calibratedAgainst: 'labels'`, against labels).
  
  Learn: a distance gate (on by default; `distanceGate: false` to disable) escalates inputs far from the stored examples; `informativeness` from margin and head disagreement; `exportState()` / `importState()` snapshots (validated, merged without double counting, safe against concurrent runs); `persistStorage()`; `simulateLearning()` to evaluate it on labeled data.
  
  Calibrate: `belay seed` builds a seed file and `belay simulate` streams labeled data through a learned classifier, configured by a task's optional `learn` section.

- [#13](https://github.com/swissspidy/belay/pull/13) [`13cb21a`](https://github.com/swissspidy/belay/commit/13cb21a7931238f6ae14c9e0728934c65dd19996) Thanks [@swissspidy](https://github.com/swissspidy)! - Learn: `teacherAccuracy` (opt-in) maps the classifier's calibrated agreement with the cloud to an estimate of being right, assuming the cloud's mistakes are independent of the classifier's and spread evenly over the other labels (`correctForTeacher()`); calibration pairs scored against reference labels (seed examples, corrections) are mapped accordingly. Without it, the confidence can't exceed the cloud's own accuracy, so with a cloud right less often than the threshold nothing stays on the device. With it set, the confidence is a probability of being right: use `costAwareThreshold({ calibratedAgainst: 'labels' })`. See ADR 0006.

- [#10](https://github.com/swissspidy/belay/pull/10) [`39d3161`](https://github.com/swissspidy/belay/commit/39d31619a3595a6de5e4b3186b3fd24cff61ae2e) Thanks [@swissspidy](https://github.com/swissspidy)! - Add `@swissspidy/belay-learn`, a local runner that learns from the cloud's answers: on-device embeddings (transformers.js) with a k-nearest-neighbors or softmax head, calibrated by Platt scaling on its own record, stored in memory or IndexedDB, and optionally started from a seed file (`buildSeed()`).
  
  Core: local runners can implement `learn()`, which the task calls with every validated cloud answer; `task.feedback(input, value)` passes a correction to it; `explore` sends a share of confident runs to the cloud anyway (escalation reason `exploration`); run events carry `localLabel`; `savingsMeter()` counts `explored` runs.

### Patch Changes

- Updated dependencies [[`4e79ec3`](https://github.com/swissspidy/belay/commit/4e79ec3f3d87b082a54c7d36ae308df63aa60870), [`39d3161`](https://github.com/swissspidy/belay/commit/39d31619a3595a6de5e4b3186b3fd24cff61ae2e)]:
  - @swissspidy/belay-core@0.2.0
