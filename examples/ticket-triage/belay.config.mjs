import { defineConfig } from '@swissspidy/belay-calibrate';
import { exampleCloud } from '../shared/cloud.mjs';
import { webaiBrowser } from '../shared/extension.mjs';
import { context, redactEmails, triageSchema } from './task.mjs';

// Claude: Laya → Claude is the most accurate cascade here (scripts/three-tier.mjs).
const cloud = exampleCloud({ data: new URL('./examples.jsonl', import.meta.url), redact: redactEmails }, { prefer: 'claude' });

export default defineConfig({
  tasks: {
    'ticket-triage': {
      schema: triageSchema,
      context,
      local: { runner: 'classifier-api' },
      cloud: cloud.runner,
      redact: redactEmails,
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
