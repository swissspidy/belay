/**
 * Cloud runners for the examples.
 *
 * - `claudeCloud()`: Claude via the Anthropic API with structured output. Needs ANTHROPIC_API_KEY
 *   (or another credential source the Anthropic SDK understands). This is what an app's backend
 *   would call; in the browser, point `fetchAdapter()` at that backend instead.
 * - `referenceCloud()`: for machines without cloud credentials, answers with the dataset's own
 *   labels, i.e. a perfect cloud. The calibration then shows the real local model against an upper
 *   bound for the cloud side: the local share it reports is the most the target allows, and a real
 *   cloud model needs a higher threshold. The report names it as such.
 *
 * `exampleCloud()` picks Claude when BELAY_CLOUD=claude (the default when ANTHROPIC_API_KEY is set)
 * and the reference labels when BELAY_CLOUD=reference.
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { cloudAdapter } from '@belay/core';

export function claudeCloud({ model = 'claude-opus-5-5', effort = 'low' } = {}) {
  const client = new Anthropic();
  return cloudAdapter(
    async ({ instruction, input, jsonSchema }, { signal }) => {
      const response = await client.beta.messages.create(
        {
          model,
          max_tokens: 4096,
          system: instruction,
          messages: [{ role: 'user', content: input }],
          // Classification needs little reasoning; the JSON Schema constrains the answer to the options.
          output_config: { effort, format: { type: 'json_schema', schema: jsonSchema } },
          // If a safety classifier declines, re-run on a fallback model inside the same call.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        signal ? { signal } : {},
      );
      if (response.stop_reason === 'refusal') throw new Error(`Claude declined (${response.stop_details?.category ?? 'no category'})`);
      const text = response.content.find((block) => block.type === 'text')?.text;
      if (!text) throw new Error(`No text in the response (stop_reason: ${response.stop_reason})`);
      return JSON.parse(text);
    },
    { id: `anthropic:${model}` },
  );
}

/**
 * @param {{ data: string | URL, redact?: (input: string) => string }} options
 *   `data` is the JSONL dataset; `redact` must match the task's, since the cloud sees redacted input.
 */
export function referenceCloud({ data, redact = (s) => s }) {
  const labels = new Map();
  for (const line of readFileSync(data, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const { input, label } = JSON.parse(line);
    labels.set(redact(input), label);
  }
  return cloudAdapter(
    async ({ input }) => {
      if (!labels.has(input)) throw new Error('input not in the reference dataset');
      return labels.get(input);
    },
    { id: 'reference-labels' },
  );
}

/** @param {{ data: string | URL, redact?: (input: string) => string }} dataset */
export function exampleCloud(dataset) {
  const choice = process.env.BELAY_CLOUD ?? (process.env.ANTHROPIC_API_KEY ? 'claude' : 'reference');
  if (choice === 'claude') return { runner: claudeCloud(), model: 'claude-opus-5-5' };
  if (choice === 'reference') {
    return { runner: referenceCloud(dataset), model: 'dataset labels: perfect-cloud upper bound, not a model' };
  }
  throw new Error(`BELAY_CLOUD must be "claude" or "reference", got "${choice}"`);
}
