import { defineConfig } from '@swissspidy/belay-calibrate';
import { exampleCloud } from '../shared/cloud.mjs';
import { webaiBrowser } from '../shared/extension.mjs';
import { context, intentSchema } from './task.mjs';

// Jev, then Claude where Jev is unsure: as accurate as Claude alone for about 2% of the cost.
const cloud = exampleCloud({ data: new URL('./examples.jsonl', import.meta.url) }, { prefer: 'jev-claude' });

export default defineConfig({
  tasks: {
    'intent-detection': {
      schema: intentSchema,
      context,
      local: { runner: 'classifier-api' },
      cloud: cloud.runner,
      models: { local: 'Laya multilingual, 256 tokens (WebAI Studio extension)', cloud: cloud.model },
      // The most accurate threshold. The report's held-out (cross-validated) accuracy checks that
      // the gain over the cloud is not just fitted to these examples.
      target: 'max',
      // Measured: every cloud call is priced from its token usage (see ../shared/cloud.mjs).
      ...(cloud.cost ? { cost: cloud.cost } : {}),
    },
  },
  browser: webaiBrowser(),
});
