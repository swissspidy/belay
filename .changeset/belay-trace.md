---
"@swissspidy/belay-trace": minor
"@swissspidy/belay-calibrate": minor
---

New package `@swissspidy/belay-trace`: `tracedTask()` records runs to your own sink (opt-in; by default only inputs that were sent to the cloud anyway, redacted before storage), and `buildDatasets()` turns traces into training, validation and holdout splits with a frozen holdout. `belay datasets` builds them from the command line. See ADR 0007.
