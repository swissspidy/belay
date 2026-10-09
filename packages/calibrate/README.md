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

## License

Apache-2.0
