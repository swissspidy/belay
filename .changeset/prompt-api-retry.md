---
"@swissspidy/belay-web": patch
---

`promptApi()` tries a prompt once more when the browser fails it with `UnknownError`. Chrome 157 does this to a constrained prompt shortly after another constrained session was destroyed, which made every third run escalate.
