# @swissspidy/belay-trace

Opt-in traces of [Belay](https://github.com/swissspidy/belay#readme) runs, written to your own
storage, and the labeled datasets built from them. Every escalation pays for a cloud answer; a
trace keeps it as a label, so you can measure and improve the local side later.

> **Status:** experimental (0.x). The API and the trace format may change between minor versions.

## Install

```sh
npm install @swissspidy/belay-core @swissspidy/belay-trace
```

## Record

`tracedTask()` takes the options of `task()` and returns the same task. It also writes one trace
per run to your sink.

```ts
import { fetchAdapter } from '@swissspidy/belay-core';
import { classifierApi } from '@swissspidy/belay-web';
import { tracedTask } from '@swissspidy/belay-trace';

const triage = tracedTask(
  {
    name: 'ticket-triage',
    schema,
    local: classifierApi(),
    cloud: fetchAdapter({ url: '/api/belay' }),
    calibration: '/belay.calibration.json',
    explore: 0.05, // check 5% of confident runs too, or confident mistakes are never seen
    privacy: { redact: (text) => text.replace(/\S+@\S+/g, '[email]') },
  },
  {
    sink: async (trace) => {
      await fetch('/api/traces', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify(trace) });
    },
  },
);
```

On your server, append what arrives to a file:

```ts
import { parseTrace } from '@swissspidy/belay-trace';
import { jsonlSink } from '@swissspidy/belay-trace/node';

const sink = jsonlSink('./traces/ticket-triage.jsonl');
app.post('/api/traces', async (req, res) => {
  await sink.write(parseTrace(req.body));
  res.sendStatus(204);
});
```

A trace holds the input, the local answer and its confidence, the cloud's answer when there was
one, the label and its kind, the threshold, why the run escalated, and where it ran (runner ids,
user agent, and the model names you pass in `environment`).

## What leaves the device

Tracing is off unless you use `tracedTask()`, and Belay hosts nothing: traces only go to your sink.

- **By default (`content: 'sent'`), a trace holds text only for runs whose input was sent to the
  cloud anyway.** A run the device answered is recorded without its input, like a telemetry event.
- `content: 'all'` also stores the inputs of runs the device answered, and the corrections passed
  to `task.feedback()` as gold labels, under the `auto` escalation policy. This sends text to your server that the cascade kept on the
  device: say so in your privacy notice.
- Under `escalation: 'never'` (the task's policy, a per-run override, or a task without a cloud
  runner) and when consent was denied, a trace never holds content.
- `redact` runs before your sink sees anything: over the input, and over every string of a
  structured output. It defaults to the task's `privacy.redact`. If it throws, the content is
  withheld.

## Labels

| Kind | Origin | From |
| --- | --- | --- |
| silver | `cloud` | The cloud's answer on an escalated or explored run |
| gold | `feedback` | `task.feedback(input, value)`, under `content: 'all'` |
| gold | `dataset` | `labelTrace({ task, schema, input, value })`, for rows of a labeled dataset |
| silver | `synthetic` | `labelTrace({ …, origin: 'synthetic' })`, for examples a model wrote |

Escalated runs are the hard cases. Use `explore` so that confident runs are checked too; an
explored run's trace has a `weight` (1 / rate) for the confident runs it stands for.

## Build datasets

```sh
npx belay datasets --task ticket-triage --traces ./traces --seed 7
```

writes `train.jsonl`, `validation.jsonl`, `holdout.jsonl` and `manifest.json` to
`.belay/datasets/ticket-triage/`. `--gold examples.jsonl` adds labeled examples as gold labels.
Or in code:

```ts
import { buildDatasets, readManifest, readTraces, writeDatasets } from '@swissspidy/belay-trace/node';

const { traces } = await readTraces('./traces');
const datasets = buildDatasets(traces, { task: 'ticket-triage', schema, seed: 7, previous: await readManifest(dir) });
await writeDatasets(dir, datasets);
```

- An input is identified by a hash of its normalized text, so **no input is in two splits**, and
  near-duplicates (word 3-gram overlap of 0.8 or more) share a split.
- Gold labels win over silver ones; then the majority; then the latest.
- **The same seed and traces give the same splits**, in any trace order.
- **The holdout is frozen and only grows.** The manifest lists every input's split as hashes, with
  no text. Commit it: with it, a later build keeps every input where it was.
- Synthetic examples never enter the holdout.
- The split files are in the format `belay calibrate --data` reads.

The design is in [ADR 0007](https://github.com/swissspidy/belay/blob/main/docs/adr/0007-belay-tune-foundations.md).
