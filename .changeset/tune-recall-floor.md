---
"@swissspidy/belay-tune": patch
---

Tune: the loop fits a candidate's threshold so that no label's recall falls more than half of the gate's `maxRecallDrop` below the baseline's on validation. Before, a candidate could reach a high local share by giving up one label, and was then rejected by the gate's recall check on the holdout. `score()` takes the floors as `recallFloor`.
