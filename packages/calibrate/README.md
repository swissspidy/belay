# @swissspidy/belay-calibrate

The `belay calibrate` CLI for [Belay](https://github.com/swissspidy/belay#readme). It runs your
labeled examples through a task's on-device model (in a real Chrome, through the same
`@swissspidy/belay-web` code your app ships) and its cloud model, then picks the confidence threshold. It
writes:

- `belay.calibration.json`, which the task loads instead of a hand-picked threshold;
- `belay-report.html`, a self-contained report with accuracy, local share and cost curves,
  savings, a cross-validated accuracy estimate, a confusion matrix, and the confident local
  mistakes to fix.

> **Status:** experimental (0.x). The CLI and config format may change between minor versions.

## Install

```sh
npm install --save-dev @swissspidy/belay-calibrate playwright-core
```

`playwright-core` drives Chrome. It uses your installed Chrome, or the browser in `--browser` /
`BELAY_CHROME`. Requires Node.js 22.12 or later.

## Usage

```js
// belay.config.mjs
import { defineConfig } from '@swissspidy/belay-calibrate';
import { cloudAdapter } from '@swissspidy/belay-core';
import { triageSchema } from './src/tasks.js'; // the same schema object your app uses

export default defineConfig({
  tasks: {
    'ticket-triage': {
      schema: triageSchema,
      local: { runner: 'classifier-api' },
      cloud: cloudAdapter(async (req) => callYourModel(req)),
      target: 'cloud', // never less accurate than the cloud alone
    },
  },
  browser: { extension: './webai-extension' }, // or args to enable the native API
});
```

```sh
npx belay calibrate --task ticket-triage --data examples.jsonl
```

`examples.jsonl` has one `{"input": "...", "label": "..."}` per line. Every model output is cached
in `.belay-cache/`, so re-running replays them and reproduces the same calibration. Run
`npx belay calibrate --help` for all options, and see the
[project README](https://github.com/swissspidy/belay#calibration) for targets, cost and the file
format.

## Learned classifiers: `belay seed` and `belay simulate`

For a [`@swissspidy/belay-learn`](https://www.npmjs.com/package/@swissspidy/belay-learn) local
runner, which learns as the app runs, there is no fixed model to calibrate. Two commands help
instead. Both read the task's schema from the same config, plus an optional `learn` section in
the task:

```js
// belay.config.mjs: the task from above, with
    'ticket-triage': {
      schema: triageSchema,
      // …local, cloud: only `belay calibrate` uses them
      learn: { threshold: 0.9, explore: 0.05 }, // optional: embedder, classifier options
    },
```

```sh
npm install --save-dev @huggingface/transformers
npx belay simulate --task ticket-triage --data stream.jsonl   # how much it would answer on device, how accurately
npx belay seed --task ticket-triage --data examples.jsonl     # writes belay-seed.json for the page
```

`belay simulate` streams the examples in order, with their labels standing in for the cloud, and
prints a learning curve; `--teacher-accuracy`, `--threshold`, `--explore`, `--strategy` and
`--seed` show what each changes. `belay seed` embeds labeled examples (no text is stored) so the
classifier answers from its first run. The page must use the same embedder options. See the
[guide](https://github.com/swissspidy/belay/blob/main/docs/learned-classifier.md#try-it-on-your-data-first).

## License

Apache-2.0
