---
"@swissspidy/belay-trace": patch
---

Trace: `tracedTask()` no longer drops run events when more than 256 runs finish at once. A dropped event could give a trace another run's cloud usage or exploration weight when the two runs had the same latency, source and threshold.
