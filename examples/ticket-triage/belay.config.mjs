import { defineConfig } from '@belay/calibrate';
import { exampleCloud } from '../shared/cloud.mjs';
import { webaiBrowser } from '../shared/extension.mjs';
import { context, redactEmails, triageSchema } from './task.mjs';

const cloud = exampleCloud({ data: new URL('./examples.jsonl', import.meta.url), redact: redactEmails });

export default defineConfig({
  tasks: {
    'ticket-triage': {
      schema: triageSchema,
      context,
      local: { runner: 'classifier-api' },
      cloud: cloud.runner,
      redact: redactEmails,
      models: { local: 'Laya multilingual, 256 tokens (WebAI Studio extension)', cloud: cloud.model },
      target: 0.95,
      // Rough per-request price of a small classification call to a frontier model; adjust to yours.
      cost: { currency: 'USD', cloudPerRun: 0.003 },
    },
  },
  browser: webaiBrowser(),
});
