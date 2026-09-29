import { defineConfig } from '@belay/calibrate';
import { exampleCloud } from '../shared/cloud.mjs';
import { webaiBrowser } from '../shared/extension.mjs';
import { context, intentSchema } from './task.mjs';

const cloud = exampleCloud({ data: new URL('./examples.jsonl', import.meta.url) });

export default defineConfig({
  tasks: {
    'intent-detection': {
      schema: intentSchema,
      context,
      local: { runner: 'classifier-api' },
      cloud: cloud.runner,
      models: { local: 'Laya multilingual, 256 tokens (WebAI Studio extension)', cloud: cloud.model },
      target: 0.95,
      cost: { currency: 'USD', cloudPerRun: 0.003 },
    },
  },
  browser: webaiBrowser(),
});
