# Belay Tune: ticket-triage, run m5-prompt-3

**A candidate passed the gate.**

- Local runner: prompt-api, Chrome 157 built-in Gemini Nano (Prompt API) with a DecisionModel judge, CPU (Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36)
- Target: 95.0% cascade accuracy
- Data: 915 training, 284 validation (284 gold), 301 holdout (301 gold)
- Experiments: 6 run, 4 kept, 2 discarded (0 at screening), 0 errors; stopped: max-experiments
- Reflector spend: 0.0918 USD in 2 calls (cap 3 USD)
- Protected files (gate config, instructions, evaluator, holdout): unchanged (sha256:bde81842cc41…)

## On validation

| | Local share | Accuracy | Threshold | Against gold | Agrees with cloud | Prompt size |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline | 52.5% | 95.2% | 0.964 | 95.2% | – | 477 chars |
| Best (m5-prompt-3.004, examples) | 100.0% | 96.5% | 0.232 | 96.5% | – | 892 chars |

Best candidate's hypothesis: Using a compact seven-example set covering account profiles, reimbursement timing, restitution status, termination penalties, acquiring articles, address updates, and reclamations should clarify uncommon domain terms without skewing label priors.

## Gate, on the holdout

Accuracy is measured against gold labels.

| Check | Result | Detail |
| --- | --- | --- |
| accuracy | pass | 97.3% vs 96.6% (+0.8 points, 95% CI -1.4 points to +3.0 points); may not be lower by more than 2% |
| local-share | pass | 100.0% vs 57.1% (+42.9 points, 95% CI +37.2 points to +48.5 points); needs +3.0 points, or no loss with a smaller prompt |
| recall | pass | largest drop: "order" -2.9 points; no label may drop by more than 5% |
| calibration | pass | calibration error 0.031 vs 0.052; may rise by at most 0.01 |
| latency | pass | p95 6490 ms vs 5852 ms; may be at most 30% (plus 5 ms) slower |
| prompt-size | pass | 892 characters (baseline 477); at most 2000 |

Holdout: local share 100.0% (baseline 57.1%), accuracy 97.3% (baseline 96.6%).

## Notes

- The cloud's accuracy on 284 validation examples without a recorded cloud answer is assumed to be 94.3%.

## Experiments

| Id | Rung | Stage | Local share | Accuracy | Verdict | Hypothesis | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| m5-prompt-3.000 | baseline | baseline | 52.5% | 95.2% | baseline | The config as committed. | The committed config, with the threshold fitted on validation. |
| m5-prompt-3.001 | examples | validation | 83.8% | 95.2% | kept | Providing balanced boundary examples for sign-up issues, profile usage, refund tracking, compensation status, early-exit charges, earning products, delivery-city availability, and reclamations should fix cross-label confusions while boosting confidence on company claims. | Local share up 31.3 points on validation at the target accuracy. |
| m5-prompt-3.002 | examples | validation | 97.5% | 95.3% | kept | Contrasting frustrated or error-reporting queries in account, payment, compensation, withdrawal penalties, and earning products against genuine company claims and opinions should prevent false feedback predictions on negative-tone support requests. | Local share up 45.1 points on validation at the target accuracy. |
| m5-prompt-3.003 | examples | validation | 87.0% | 95.7% | kept | Targeting misleading surface keywords—such as tracking a refund, restitution status, money-back guarantees, withdrawal fees, acquiring articles, and ordering from a delivery city—alongside standard account usage and reclamations should resolve high-confidence lexical confusions. | Local share up 34.5 points on validation at the target accuracy. |
| m5-prompt-3.004 | examples | validation | 100.0% | 96.5% | kept | Using a compact seven-example set covering account profiles, reimbursement timing, restitution status, termination penalties, acquiring articles, address updates, and reclamations should clarify uncommon domain terms without skewing label priors. | Local share up 47.5 points on validation at the target accuracy. |
| m5-prompt-3.005 | examples | validation | 88.0% | 95.8% | discarded | Preserving the current seven-example label balance while swapping in misclassified signup errors, compensation demands, early-exit charges, withdrawal penalties, and delivery-city orders should fix high-confidence cross-label confusions across all five teams. | Local share down 12.0 points on validation: not a gain. |
| m5-prompt-3.006 | examples | validation | 87.7% | 95.8% | discarded | Contrasting signup errors and compensation demands directly against both low-confidence company claims and reclamations, alongside withdrawal fees, withdrawal penalties, and delivery-city orders, should sharpen feedback boundaries while fixing order and shipping errors. | Local share down 12.3 points on validation: not a gain. |
| m5-prompt-3.007 | gate | gate | – | – | promoted | Using a compact seven-example set covering account profiles, reimbursement timing, restitution status, termination penalties, acquiring articles, address updates, and reclamations should clarify uncommon domain terms without skewing label priors. | Passed the gate (m5-prompt-3.004). |

Wrote `belay/ticket-triage/prompt-api.local.json` and `belay/ticket-triage/prompt-api.calibration.json`. Review them and merge to ship.
