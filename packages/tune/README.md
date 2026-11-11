# @swissspidy/belay-tune

Belay Tune makes a [Belay](https://github.com/swissspidy/belay#readme) task need the cloud less.
One run reads what the task got wrong, lets a frontier model propose changes to what the local
model is given (few-shot examples, short rules), measures every candidate with the task's own local
runner in a real Chrome, and puts the best one through a gate on data it has never seen. If it
passes, you get a pull request to review and merge. If not, a report says why. `belay verify`
then checks in CI that a merged config still holds when Chrome updates its model.

Its one metric is **local share at a target accuracy**: how much the device can answer while the
cascade stays as accurate as you require.

> **Status:** experimental (0.x). Built so far: the score, the loop on the first three rungs
> (threshold, examples, rules), the ledger, the gate and the lock, the pull request text,
> `belay verify` and the repair of a config that drifted. Not yet: rewording and decomposition,
> weights. The GitHub Action templates have not been run on GitHub's runners yet. See
> [ADR 0007](https://github.com/swissspidy/belay/blob/main/docs/adr/0007-belay-tune-foundations.md).

## Use

```sh
npm install --save-dev @swissspidy/belay-calibrate @swissspidy/belay-tune playwright-core

npx belay datasets --task ticket-triage --traces ./traces --seed 7   # splits from your traces
npx belay tune --dry-run --task ticket-triage --target 0.95 --repeat 2   # is the score stable?
npx belay tune --lock --task ticket-triage                           # then review and commit the lock
npx belay tune --task ticket-triage --budget 5usd --max-experiments 20
npx belay ledger --task ticket-triage                                # what was tried, and why it was kept or not
```

The task comes from your `belay.config.mjs`, as for `belay calibrate`, with a `tune` section:

```js
import { reflectorAdapter } from '@swissspidy/belay-tune';

export default defineConfig({
  tasks: {
    'ticket-triage': {
      schema: triageSchema,
      local: { runner: 'classifier-api' },
      tune: {
        target: 0.95,
        // The model that proposes changes. Your function, your key. Use a frontier model.
        reflector: reflectorAdapter(async ({ system, prompt, jsonSchema }, { signal, reportUsage }) => {
          const res = await callYourModel({ system, prompt, jsonSchema, signal });
          reportUsage({ model: res.model, inputTokens: res.usage.input, outputTokens: res.usage.output });
          return res.output; // an object matching jsonSchema, or its JSON
        }),
        prices: { input: 2, output: 10 }, // per million tokens, to enforce --budget
      },
    },
  },
});
```

Only the reflecting model costs money. Every evaluation runs on the device, and the cloud's side
of the cascade is read from your traces, not called again.

## One run

1. **Baseline.** The committed config runs on the validation split; the threshold that holds the
   target is fitted.
2. **Diagnose and propose.** The reflecting model is shown training inputs the local model got
   wrong, got right without being sure, and got right confidently, plus the ledger. It proposes
   candidates: first few-shot examples, then rules. The loop only moves to rules when examples
   stopped helping.
3. **Screen, then validate.** Each candidate runs on 60 validation examples; the ones that are not
   clearly worse run on all of them, and their threshold is fitted again, because a changed prompt
   shifts the confidences.
4. **Gate.** The best candidate and the baseline run on the holdout, once. All checks must pass:

   | Check | Default |
   | --- | --- |
   | Accuracy | Not lower than the baseline by more than 1 point (lower bound of a paired 95% bootstrap interval) |
   | Local share | Up by at least 3 points, or no lower with a smaller prompt |
   | Per-label recall | No label drops by more than 5 points |
   | Calibration error | Up by at most 0.01 |
   | Latency (p95) | At most 10% (plus 5 ms) slower |
   | Prompt size | At most 2,000 characters of context, rules and examples |

5. **Ship or stop.** On a pass it writes `belay/<task>/<backend>.local.json` and
   `belay/<task>/<backend>.calibration.json`. Otherwise nothing changes. Either way,
   `.belay/tune/<task>/report.md` has the numbers and the reasons, and `.belay/ledger.jsonl`
   has every experiment.

The gate is strict on purpose. With a few hundred holdout examples, the interval on an accuracy
difference is several points wide, so a candidate must be clearly no worse to pass. More labeled
traces make it pass more often for real gains; a looser `accuracyMargin` makes it pass more often
for noise, and because each promotion is the next baseline, that allowance can be spent night
after night.

So a holdout that is too small gets its own answer, **inconclusive**, when accuracy is the only
check that failed and its interval lies on both sides of the margin:

- Nothing is written, as with a failure, and the command exits with 2.
- The report says about how many holdout examples would settle it.
- The candidate is kept in `.belay/tune/<task>/<backend>.pending.json` and is the first
  experiment of the next run, so it is gated again as the holdout grows.
- `belay tune` also warns at the start when the holdout is probably too small, before the night
  is spent. That is an estimate from the baseline's accuracy.

To accept a wider margin for a small task, a person sets `accuracyMargin` in `belay.gate.json`
and runs `belay tune --lock` again. The loop cannot do either.

## The pull request

On a pass, the run also writes:

- `belay/<task>/<backend>.gate.json`: the gate record. What the config did on the holdout, input
  by input (the confidence and whether the answer was right), without input text. Commit it with
  the config: it is what `belay verify` compares later browsers with.
- `.belay/tune/<task>/pull-request.md` and `pull-request-title.txt`: the change and its
  hypothesis, the numbers before and after on validation and on the holdout, the gate's checks,
  the experiments that led there, and a checklist for the reviewer. The examples in a config are
  real inputs from your traces, so the first item is to read them.

[`templates/belay-tune.yml`](./templates/belay-tune.yml) is a GitHub Action that runs the loop
every night and opens that pull request with `gh`. It keeps the ledger, the output cache and
Chrome's downloaded model between nights in the Actions cache. You fill in one step: fetching
your traces.

## `belay verify`

A browser update can change the built-in model without any change to your repository.
`belay verify` is the check for that, for CI:

```sh
npx belay verify                 # every task that has a lock
npx belay verify --task ticket-triage
```

1. The gate config, the instructions, the evaluator and the holdout match the lock, and the
   ledger is intact.
2. The config, its calibration file and its gate record belong together. A config edited by hand
   has not passed the gate, and fails here before any model runs.
3. The config runs on the holdout in the current browser, without the output cache, and is
   compared input by input with the gate record. It fails when accuracy is lower by more than
   `accuracyMargin`, local share by more than `minLocalShareGain`, a label's recall by more than
   `maxRecallDrop`, or the calibration error is higher by more than `calibrationErrorMargin`.
   Latency is shown but not judged: the CI machine is not the machine the config was tuned on.

It makes no cloud call and exits with 1 on a failure. Unlike the gate it judges the measured
difference, not the lower end of an interval: the same browser gives the same answers, so a
difference means that something changed.
[`templates/belay-verify.yml`](./templates/belay-verify.yml) runs it on pull requests that touch
a config or a protected file, and weekly.

### When verify fails: repair

Run `belay tune` again in the new browser. When the committed config no longer holds the target
accuracy on validation, the run is a **repair**:

- the threshold is fitted again first, and a threshold that holds the target is kept even though
  it keeps less local;
- the other rungs then look for a config that wins the local share back;
- at the gate, a candidate that restores the target does not have to gain local share. Every
  other check applies.

The result is a pull request titled "restore … accuracy", with a new gate record for the new
browser. Until it is merged the cascade may be less accurate than its target, which is why
verify fails loudly.

## Using a tuned config

A local config is data. `withLocalConfig()` hands it to the local runner; the task's schema, its
values and the cloud's prompt do not change.

```ts
import { withLocalConfig } from '@swissspidy/belay-tune/config'; // browser-safe, no Node code
import config from './belay/ticket-triage/classifier-api.local.json' with { type: 'json' };

const triage = task({
  name: 'ticket-triage',
  schema,
  local: withLocalConfig(classifierApi(), config),
  cloud,
  calibration: '/belay/ticket-triage/classifier-api.calibration.json',
});
```

A config is tuned for one runner and model. Tune again for another backend.

## What the loop cannot do

The loop is ordinary code and the reflecting model only returns JSON, so nothing it proposes can
write a file. On top of that:

- **A lock.** `belay tune --lock` records hashes of the gate config (`belay.gate.json`, or the
  defaults), your instructions (`belay.tune.md`), the installed evaluator packages and the
  holdout's inputs in `belay.tune.lock.json`. A person commits it. The loop checks it before it
  starts, before the gate and before it writes, and stops on any difference. The holdout may grow;
  inputs may not leave it.
- **An allowlist.** The loop writes only the config, its calibration file and gate record, the
  ledger, and the report and pull request text.
- **The holdout stays out of prompts.** The reflecting model sees training inputs only, and the
  ledger records a gate result as pass or fail, without holdout numbers.
- **A ledger you can check.** Each line carries the hash of the line before it. `belay ledger`
  and the next run report a file that was edited.

Put what the reflecting model should and should not do in `belay.tune.md` ("never mention order
numbers in a rule"). It is passed to the model and covered by the lock.

## `belay tune --dry-run`

Scores the current config and stops. Use it to check that the score is stable before you trust a
run:

```
Target          95.0% accuracy met
Threshold       0.959
Local share     91.0% (95% CI 54.0%–98.7%)
Accuracy        95.2% (95% CI 95.0%–95.9%), 94.3% cloud only
Runs            91.0%, 91.0% local: agree (spread 0.0 points)
```

(Chrome 157's built-in classifier on 300 labeled ticket-triage examples, two runs without the
cache. The interval is wide because the accuracy sits just above the target.)

- **Local share** is measured at the lowest threshold whose cascade accuracy holds the target.
  Examples count by their `weight`: a confident run that exploration sent to the cloud stands for
  the confident runs that were not checked.
- **The interval** is a 95% bootstrap interval, with the threshold fitted again on every resample.
- **Against gold** and **agrees with cloud** are reported separately. With few gold labels,
  "accuracy" mostly means agreement with the cloud.
- **The cloud's side** comes from the traces: for a silver label the cloud's answer is the label;
  for a gold label it is the answer the cloud gave in that run. A gold example without one counts
  at the cloud's accuracy on the others (or `--cloud-accuracy`).
- `--repeat` runs the examples again without the cache and exits with 2 when the local share
  differs by more than one point.

## In code

`tune()`, `verify()`, `dryRun()`, `score()`, `scoreAt()`, `pairedBootstrap()`, `runGate()`, `readLedger()`,
`reflectorAdapter()`, `renderPullRequest()` and the local config functions are exported for use without the CLI.
