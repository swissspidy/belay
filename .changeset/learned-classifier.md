---
"@swissspidy/belay-core": minor
"@swissspidy/belay-learn": minor
---

Add `@swissspidy/belay-learn`, a local runner that learns from the cloud's answers: on-device embeddings (transformers.js) with a k-nearest-neighbors or softmax head, calibrated by Platt scaling on its own record, stored in memory or IndexedDB, and optionally started from a seed file (`buildSeed()`).

Core: local runners can implement `learn()`, which the task calls with every validated cloud answer; `task.feedback(input, value)` passes a correction to it; `explore` sends a share of confident runs to the cloud anyway (escalation reason `exploration`); run events carry `localLabel`; `savingsMeter()` counts `explored` runs.
