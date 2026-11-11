---
"@swissspidy/belay-web": minor
"@swissspidy/belay-calibrate": minor
---

`classifierApi()` and `classifierJudge()` now run on Chrome 157's DecisionModel API (`globalThis.DecisionModel`, `decide()`, question types `boolean` / `choice` / `score`, probabilities keyed by label), which replaced the proposed Classifier API. Chrome 157 or later is required; older versions and the old `globalThis.Classifier` shape are no longer supported. An implementation passed as `classifierApi({ classifier })` must have the new shape. `belay calibrate` and `belay tune` enable the `AIDecisionModelAPI` feature themselves. See ADR 0008.
