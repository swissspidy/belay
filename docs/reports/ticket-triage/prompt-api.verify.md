# Belay verify: ticket-triage (prompt-api)

**The tuned config still holds.**

- At the gate: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36
- Now: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36

| Check | Result | Detail |
| --- | --- | --- |
| lock | pass | gate config, instructions, evaluator and holdout match the lock |
| ledger | pass | 49 entries, chain intact |
| files | pass | config, calibration file and gate record belong together |
| prompt-size | pass | 892 characters; at most 2000 |
| accuracy | pass | 97.3% now vs 97.3% at the gate (+0.0 points, 95% CI -1.7 points to +1.7 points); may not be lower by more than 2% |
| local-share | pass | 100.0% now vs 100.0% at the gate (+0.0 points); may not be lower by more than 3% |
| recall | pass | largest drop: "account" +0.0 points; no label may drop by more than 5% |
| calibration | pass | calibration error 0.032 now vs 0.031; may rise by at most 0.01 |
| latency | info | p95 6677 ms now, 6490 ms at the gate (for information: machines differ) |

- 8 of 301 holdout inputs are answered differently than at the gate, in what reports itself as the same browser.
