# @swissspidy/belay-web

## 0.2.0

### Minor Changes

- [#27](https://github.com/swissspidy/belay/pull/27) [`b34a250`](https://github.com/swissspidy/belay/commit/b34a250dbc2e85e6731bcb18368976c2518f5f46) Thanks [@swissspidy](https://github.com/swissspidy)! - `classifierApi()` and `classifierJudge()` now run on Chrome 157's DecisionModel API (`globalThis.DecisionModel`, `decide()`, question types `boolean` / `choice` / `score`, probabilities keyed by label), which replaced the proposed Classifier API. Chrome 157 or later is required; older versions and the old `globalThis.Classifier` shape are no longer supported. An implementation passed as `classifierApi({ classifier })` must have the new shape. `belay calibrate` and `belay tune` enable the `AIDecisionModelAPI` feature themselves. See ADR 0008.

### Patch Changes

- [#27](https://github.com/swissspidy/belay/pull/27) [`b34a250`](https://github.com/swissspidy/belay/commit/b34a250dbc2e85e6731bcb18368976c2518f5f46) Thanks [@swissspidy](https://github.com/swissspidy)! - `promptApi()` tries a prompt once more when the browser fails it with `UnknownError`. Chrome 157 does this to a constrained prompt shortly after another constrained session was destroyed, which made every third run escalate.
- Updated dependencies [[`4e79ec3`](https://github.com/swissspidy/belay/commit/4e79ec3f3d87b082a54c7d36ae308df63aa60870), [`39d3161`](https://github.com/swissspidy/belay/commit/39d31619a3595a6de5e4b3186b3fd24cff61ae2e)]:
  - @swissspidy/belay-core@0.2.0

## 0.1.1

### Patch Changes

- [#7](https://github.com/swissspidy/belay/pull/7) [`33b2d4e`](https://github.com/swissspidy/belay/commit/33b2d4e23a357cf6a8b01bd5810ef21e5eb6bae8) Thanks [@swissspidy](https://github.com/swissspidy)! - Include the build output. 0.1.0 was published without `dist/`, so its entry points and the `belay` command were missing.
- Updated dependencies [[`33b2d4e`](https://github.com/swissspidy/belay/commit/33b2d4e23a357cf6a8b01bd5810ef21e5eb6bae8)]:
  - @swissspidy/belay-core@0.1.1
