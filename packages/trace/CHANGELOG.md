# @swissspidy/belay-trace

## 0.2.0

### Minor Changes

- [#27](https://github.com/swissspidy/belay/pull/27) [`b34a250`](https://github.com/swissspidy/belay/commit/b34a250dbc2e85e6731bcb18368976c2518f5f46) Thanks [@swissspidy](https://github.com/swissspidy)! - New package `@swissspidy/belay-trace`: `tracedTask()` records runs to your own sink (opt-in; by default only inputs that were sent to the cloud anyway, redacted before storage), and `buildDatasets()` turns traces into training, validation and holdout splits with a frozen holdout. `belay datasets` builds them from the command line.
  
  New package `@swissspidy/belay-tune`: `belay tune --dry-run` scores a task's local side on a split, in a real Chrome and without cloud calls: the local share at a target accuracy, with a bootstrap interval and a check that repeated runs agree.
  
  Calibrate: `evaluateLocal()` runs only the local runner over a dataset, and `createBackend()` builds a task's local backend. See ADR 0007.

### Patch Changes

- [#28](https://github.com/swissspidy/belay/pull/28) [`2c29de4`](https://github.com/swissspidy/belay/commit/2c29de4d2e9d21ccfaebbb057b6dc4cb8f532449) Thanks [@swissspidy](https://github.com/swissspidy)! - Trace: `tracedTask()` no longer drops run events when more than 256 runs finish at once. A dropped event could give a trace another run's cloud usage or exploration weight when the two runs had the same latency, source and threshold.
- Updated dependencies [[`4e79ec3`](https://github.com/swissspidy/belay/commit/4e79ec3f3d87b082a54c7d36ae308df63aa60870), [`39d3161`](https://github.com/swissspidy/belay/commit/39d31619a3595a6de5e4b3186b3fd24cff61ae2e)]:
  - @swissspidy/belay-core@0.2.0
