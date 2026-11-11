# Belay Tune: ticket-triage, run m4-promote

**A candidate passed the gate.**

- Local runner: classifier-api, Chrome 157 built-in DecisionModel, CPU (Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36)
- Target: 95.0% cascade accuracy
- Data: 915 training, 284 validation (284 gold), 301 holdout (301 gold)
- Experiments: 1 run, 1 kept, 0 discarded (0 at screening), 0 errors; stopped: max-experiments
- Reflector spend: 0.0000 USD in 0 calls (cap 1 USD)
- Protected files (gate config, instructions, evaluator, holdout): unchanged (sha256:522deeaf7131…)

## On validation

| | Local share | Accuracy | Threshold | Against gold | Agrees with cloud | Prompt size |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline | 96.5% | 95.2% | 0.860 | 95.2% | – | 477 chars |
| Best (m4-promote.001, examples) | 100.0% | 95.8% | 0.403 | 95.8% | – | 808 chars |

Best candidate's hypothesis: Covering all three repeated error clusters—termination/withdrawal fees, compensation requests, and delivery city/address updates—with two examples each will fix high-confidence billing, account, and order confusions without shifting feedback priors.

## Gate, on the holdout

Accuracy is measured against gold labels.

| Check | Result | Detail |
| --- | --- | --- |
| accuracy | pass | 97.3% vs 97.1% (+0.2 points, 95% CI -1.5 points to +2.2 points); may not be lower by more than 2% |
| local-share | pass | 100.0% vs 96.0% (+4.0 points, 95% CI +2.0 points to +6.3 points); needs +3.0 points, or no loss with a smaller prompt |
| recall | pass | largest drop: "account" +0.0 points; no label may drop by more than 5% |
| calibration | pass | calibration error 0.017 vs 0.037; may rise by at most 0.01 |
| latency | pass | p95 2690 ms vs 2145 ms; may be at most 30% (plus 5 ms) slower |
| prompt-size | pass | 808 characters (baseline 477); at most 2000 |

Holdout: local share 100.0% (baseline 96.0%), accuracy 97.3% (baseline 97.1%).

## Notes

- The cloud's accuracy on 284 validation examples without a recorded cloud answer is assumed to be 94.3%.

## Experiments

| Id | Rung | Stage | Local share | Accuracy | Verdict | Hypothesis | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| m4-promote.000 | baseline | baseline | 96.5% | 95.2% | baseline | The config as committed. | The committed config, with the threshold fitted on validation. |
| m4-promote.001 | examples | validation | 100.0% | 95.8% | kept | Covering all three repeated error clusters—termination/withdrawal fees, compensation requests, and delivery city/address updates—with two examples each will fix high-confidence billing, account, and order confusions without shifting feedback priors. | Carried over from m3-acceptance.006, where the gate was inconclusive. Local share up 3.5 points on validation at the target accuracy. |
| m4-promote.002 | gate | gate | – | – | promoted | Covering all three repeated error clusters—termination/withdrawal fees, compensation requests, and delivery city/address updates—with two examples each will fix high-confidence billing, account, and order confusions without shifting feedback priors. | Passed the gate (m4-promote.001). |

Wrote `belay/ticket-triage/classifier-api.local.json` and `belay/ticket-triage/classifier-api.calibration.json`. Review them and merge to ship.
