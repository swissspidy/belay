# @swissspidy/belay-tune

The start of Belay Tune, a loop that makes a [Belay](https://github.com/swissspidy/belay#readme)
task need the cloud less. So far it has the part everything else rests on: a trusted score.

`belay tune --dry-run` answers one question about a task's local side as it is today: **how much
can the device answer while the cascade holds a target accuracy?** It runs your recorded examples
through the local runner in a real Chrome and compares the answers with their labels. It makes no
cloud call.

> **Status:** experimental (0.x). The tuning loop itself is not built yet; see
> [ADR 0007](https://github.com/swissspidy/belay/blob/main/docs/adr/0007-belay-tune-foundations.md).

## Use

```sh
npm install --save-dev @swissspidy/belay-calibrate @swissspidy/belay-tune playwright-core

npx belay datasets --task ticket-triage --traces ./traces --seed 7   # splits from your traces
npx belay tune --dry-run --task ticket-triage --target 0.95 --repeat 2
```

It uses the task from your `belay.config.mjs`, as `belay calibrate` does, and scores
`.belay/datasets/<task>/validation.jsonl` unless you pass `--data`. A plain labeled dataset
(`{"input": "...", "label": "..."}` per line) works too.

```
Task            ticket-triage
Local           classifier-api, Laya multilingual
Examples        172 (0 gold, 172 silver; 0 cached)
Target          95.0% accuracy met
Threshold       0.71
Local share     58.1% (95% CI 49.4%–66.3%)
Accuracy        95.3% (95% CI 95.0%–97.7%), 100.0% cloud only
Against gold    no gold labels
Agrees w/ cloud 95.3%
Kept local      92.0% accurate; 74.2% of local mistakes escalated
Note            fewer than 100 gold labels: the accuracy mostly measures agreement with the cloud
Runs            58.1%, 57.6% local: agree (spread 0.5 points)
```

(The numbers above are an illustration of the output, not a measurement.)

It writes the score, the dataset's fingerprint and the browser it ran in to
`.belay/tune/<task>/baseline.json`, and exits with 2 when the target is not met or the runs
disagree.

## What the numbers mean

- **Local share** is the share of runs the device answers at the lowest threshold whose cascade
  accuracy holds the target. Examples count by their `weight`: a confident run that exploration
  sent to the cloud stands for the confident runs that were not checked.
- **The interval** is a 95% bootstrap interval. The threshold is fitted again on every resample,
  so it includes the uncertainty of the threshold.
- **Against gold** is the cascade's accuracy on examples a person or a dataset labeled.
  **Agrees with cloud** is its agreement with the cloud's answers on the rest. With few gold
  labels, "accuracy" mostly means agreement.
- **The cloud's side** comes from the traces, not from new calls: for a silver label the cloud's
  answer is the label; for a gold label it is the answer the cloud gave in that run. A gold
  example without one counts at the cloud's accuracy on the others (or `--cloud-accuracy`).
- **Runs** (`--repeat`): later runs skip the output cache. A model in a browser is not
  deterministic; runs that differ by more than one point of local share mean the score is not a
  baseline you can compare a change against.
- The threshold is fitted on the examples it is scored on, so expect a little less on new data.

## In code

```ts
import { createBackend, OutputCache } from '@swissspidy/belay-calibrate';
import { dryRun, loadSplit, score } from '@swissspidy/belay-tune';

const split = await loadSplit('.belay/datasets/ticket-triage/validation.jsonl', schema);
const baseline = await dryRun({ name: 'ticket-triage', config, split, backend, cache, target: 0.95, repeat: 2 });
baseline.score.localShare; // and .localShareInterval, .threshold, .goldAccuracy, .cloudAgreement
```

`score(examples, { target })` is the metric alone, for examples you scored yourself.
