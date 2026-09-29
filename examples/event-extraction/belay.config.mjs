import { defineConfig } from '@belay/calibrate';
import { exampleCloud } from '../shared/cloud.mjs';
import { webaiBrowser } from '../shared/extension.mjs';
import { context, extractionSchema, JUDGE_QUESTION, sameEvent } from './task.mjs';

// Claude: Jev answers choice and yes/no questions only, not structured outputs.
const cloud = exampleCloud({ data: new URL('./examples.jsonl', import.meta.url) }, { prefer: 'claude' });

export default defineConfig({
  tasks: {
    'event-extraction': {
      schema: extractionSchema,
      context,
      // Gemini Nano through Chrome's Prompt API, constrained to the JSON Schema.
      local: { runner: 'prompt-api' },
      // Laya through the Classifier API (WebAI Studio extension) scores each extraction.
      judge: { judge: 'classifier-judge', options: { question: JUDGE_QUESTION } },
      cloud: cloud.runner,
      correct: sameEvent,
      models: { local: 'Gemini Nano (Chrome 154 Prompt API, CPU backend); judge: Laya multilingual (WebAI Studio extension)', cloud: cloud.model },
      // The most accurate threshold; the report's held-out accuracy checks the gain.
      target: 'max',
      ...(cloud.cost ? { cost: cloud.cost } : {}),
    },
  },
  browser: webaiBrowser(),
});
