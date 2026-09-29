import { defineConfig } from '@belay/calibrate';
import { exampleCloud } from '../shared/cloud.mjs';
import { webaiBrowser } from '../shared/extension.mjs';
import { context, moderationSchema } from './task.mjs';

// Jev: it agrees with these labels more than Claude, and costs about 1% as much.
const cloud = exampleCloud({ data: new URL('./examples.jsonl', import.meta.url) }, { prefer: 'jev' });

export default defineConfig({
  tasks: {
    'content-moderation': {
      schema: moderationSchema,
      context,
      local: { runner: 'classifier-api' },
      cloud: cloud.runner,
      models: { local: 'Laya multilingual, 256 tokens (WebAI Studio extension)', cloud: cloud.model },
      // The most accurate threshold. The report's held-out (cross-validated) accuracy checks that
      // the gain over the cloud is not just fitted to these examples.
      target: 'max',
      // Measured: every cloud call is priced from its token usage (see ../shared/cloud.mjs).
      ...(cloud.cost ? { cost: cloud.cost } : {}),
      perLabel: true,
    },
  },
  browser: webaiBrowser(),
});
