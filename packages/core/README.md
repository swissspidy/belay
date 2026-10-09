# @swissspidy/belay-core

Answer AI tasks with a small on-device model, and call a cloud model only for the inputs it is
unsure about. `@swissspidy/belay-core` has the task, the cascade, confidence handling, calibration files,
cloud adapters and savings telemetry. It has no runtime dependencies.

Pair it with [`@swissspidy/belay-web`](https://www.npmjs.com/package/@swissspidy/belay-web) for the on-device runners
(Chrome's Classifier and Prompt APIs), and calibrate the threshold on your own data with
[`@swissspidy/belay-calibrate`](https://www.npmjs.com/package/@swissspidy/belay-calibrate).

> **Status:** experimental (0.x). The API may change between minor versions.

## Install

```sh
npm install @swissspidy/belay-core @swissspidy/belay-web
```

## Usage

```ts
import { task, fetchAdapter } from '@swissspidy/belay-core';
import { classifierApi } from '@swissspidy/belay-web';

const triage = task({
  name: 'ticket-triage',
  schema: { type: 'categorical', options: ['bug', 'billing', 'feature', 'other'] as const },
  local: classifierApi(),
  cloud: fetchAdapter({ url: '/api/belay' }), // your backend calls the LLM
  threshold: 0.8, // or: calibration: '/belay.calibration.json'
});

const result = await triage.run(ticketText, { signal });
// { value: 'billing', confidence: 0.93, source: 'local', escalationReason: null, ... }
```

The local answer is accepted if and only if `confidence >= threshold`. Otherwise the task
escalates to the cloud, subject to your privacy policy (`redact`, `consent`, or `never`).

## Documentation

See the [project README](https://github.com/swissspidy/belay#readme) for schemas, confidence,
privacy, cloud adapters, calibration and telemetry, and the
[ADRs](https://github.com/swissspidy/belay/tree/main/docs/adr) for the design decisions.

## License

Apache-2.0
