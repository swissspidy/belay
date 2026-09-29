/**
 * Cloud runners for the examples.
 *
 * - `claudeCloud()`: Claude via the Anthropic API with structured output. Needs ANTHROPIC_API_KEY
 *   (or another credential source the Anthropic SDK understands). This is what an app's backend
 *   would call; in the browser, point `fetchAdapter()` at that backend instead.
 * - `jevCloud()`: Jev, TypeSafe AI's System One model, which answers choice and yes/no questions
 *   with probabilities instead of generating text. Needs JEV_API_KEY (or TYPESAFE_API_KEY).
 * - `referenceCloud()`: for machines without cloud credentials, answers with the dataset's own
 *   labels, i.e. a perfect cloud. The calibration then shows the real local model against an upper
 *   bound for the cloud side: the local share it reports is the most the target allows, and a real
 *   cloud model needs a higher threshold. The report names it as such.
 *
 * Both model runners report token usage, so the calibration measures what every call cost with the
 * price tables below.
 *
 * `exampleCloud()` picks the runner from BELAY_CLOUD: "claude" (the default when ANTHROPIC_API_KEY
 * is set), "jev", or "reference".
 */
import Anthropic from '@anthropic-ai/sdk';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { readFileSync } from 'node:fs';
import { cloudAdapter, normalizeOptions } from '@belay/core';

/**
 * Standard API prices in USD per million tokens, from https://claude.com/pricing#api (checked
 * 2026-09-29; no batch discount, no US-only inference surcharge). Cache prices are for the
 * 5-minute TTL. Keyed by the model id the API reports, so a response that a refusal fallback
 * served is priced at the fallback model's rates.
 * @type {import('@belay/core').PriceTable}
 */
export const claudePrices = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/**
 * USD per million tokens, from https://docs.typesafe.ai/models (checked 2026-09-29): Jev 1.13 is
 * $0.042 per million input tokens, and output tokens are free.
 * @type {import('@belay/core').PriceTable}
 */
export const jevPrices = {
  'jev-1.13.0': { input: 0.042, output: 0 },
};

export function claudeCloud({ model = 'claude-opus-5-5', effort = 'low' } = {}) {
  const client = new Anthropic();
  return cloudAdapter(
    async ({ instruction, input, jsonSchema }, { signal, reportUsage }) => {
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
      reportUsage(claudeUsage(response, model));
      if (response.stop_reason === 'refusal') throw new Error(`Claude declined (${response.stop_details?.category ?? 'no category'})`);
      const text = response.content.find((block) => block.type === 'text')?.text;
      if (!text) throw new Error(`No text in the response (stop_reason: ${response.stop_reason})`);
      return JSON.parse(text);
    },
    { id: `anthropic:${model}` },
  );
}

/**
 * Token usage per model. With a refusal fallback, `usage.iterations` lists every attempt and the
 * top-level `usage` covers only the last one, so each attempt is reported with its own model.
 * Every attempt is priced, which overstates the cost if a declined-before-output attempt is free.
 * @returns {import('@belay/core').CloudUsage[]}
 */
function claudeUsage(response, requestedModel) {
  const part = (u, model) => ({
    model,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteInputTokens: u.cache_creation_input_tokens ?? 0,
  });
  const attempts = (response.usage.iterations ?? []).filter((it) => it.type === 'message' || it.type === 'fallback_message');
  if (!attempts.length) return [part(response.usage, response.model)];
  return attempts.map((it) => part(it, it.model ?? requestedModel));
}

/**
 * Jev through TypeSafe's System One API: a categorical or ordinal task becomes one Choice question
 * (option descriptions become its criteria), a binary task one Noul question. Pinned to a version,
 * as TypeSafe advises when thresholds are tuned against it.
 * @returns {import('@belay/core').CloudRunner}
 */
export function jevCloud({ model = 'jev-1.13.0' } = {}) {
  const apiKey = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
  const client = new TypeSafeClient(apiKey ? { apiKey } : {});
  return {
    id: `typesafe:${model}`,
    async run({ schema, context, input }, { signal }) {
      const state = context ? { context, message: input } : input;
      let question;
      if (schema.type === 'binary') {
        question = { type: 'noul', instructions: schema.prompt };
      } else if (schema.type === 'categorical' || schema.type === 'ordinal') {
        const criteria = Object.fromEntries(normalizeOptions(schema.options).map((o) => [o.label, o.description ?? null]));
        question = { type: 'choice', instructions: schema.prompt ?? 'Which option fits the message?', criteria };
      } else {
        throw new Error('Jev answers choice and yes/no questions; structured outputs are not supported');
      }
      const response = await client.systemOne({ model, state, questions: { answer: question } }, signal ? { signal } : {});
      const answer = response.answers.answer;
      const usage = { model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
      if (answer.type === 'noul') {
        return { value: answer.noul >= 0.5, confidence: Math.max(answer.noul, 1 - answer.noul), usage, raw: answer };
      }
      return { value: answer.choice, confidence: answer.confidence, usage, raw: answer };
    },
  };
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

/**
 * The cloud runner, model name and cost config for the calibration, chosen by BELAY_CLOUD.
 * The reference labels have no cost: they are not a model anyone pays for.
 * @param {{ data: string | URL, redact?: (input: string) => string }} dataset
 */
export function exampleCloud(dataset, { runsPerMonth = 1_000_000 } = {}) {
  const choice = process.env.BELAY_CLOUD ?? (process.env.ANTHROPIC_API_KEY ? 'claude' : 'reference');
  if (choice === 'claude') {
    return { runner: claudeCloud(), model: 'claude-opus-5-5', cost: { currency: 'USD', prices: claudePrices, runsPerMonth } };
  }
  if (choice === 'jev') {
    return { runner: jevCloud(), model: 'jev-1.13.0', cost: { currency: 'USD', prices: jevPrices, runsPerMonth } };
  }
  if (choice === 'reference') {
    return { runner: referenceCloud(dataset), model: 'dataset labels: perfect-cloud upper bound, not a model' };
  }
  throw new Error(`BELAY_CLOUD must be "claude", "jev" or "reference", got "${choice}"`);
}
