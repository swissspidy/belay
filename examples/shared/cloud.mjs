/**
 * Cloud runners for the examples.
 *
 * - `claudeCloud()`: Claude via the Anthropic API with structured output. Needs ANTHROPIC_API_KEY
 *   (or another credential source the Anthropic SDK understands). This is what an app's backend
 *   would call; in the browser, point `fetchAdapter()` at that backend instead.
 * - `jevCloud()`: Jev, TypeSafe AI's System One model, which answers choice and yes/no questions
 *   with probabilities instead of generating text. Needs JEV_API_KEY (or TYPESAFE_API_KEY).
 * - `geminiCloud()`: Gemini via the Gemini API (REST) with structured output. Needs GEMINI_API_KEY.
 * - `referenceCloud()`: for machines without cloud credentials, answers with the dataset's own
 *   labels, i.e. a perfect cloud. The calibration then shows the real local model against an upper
 *   bound for the cloud side: the local share it reports is the most the target allows, and a real
 *   cloud model needs a higher threshold. The report names it as such.
 *
 * Both model runners report token usage, so the calibration measures what every call cost with the
 * price tables below.
 *
 * - `jevThenClaude()`: Jev first, Claude only for the runs Jev is unsure about (`cloudCascade()`).
 *
 * `exampleCloud()` picks the runner: each example names the cloud that suited it best, and
 * BELAY_CLOUD ("claude", "gemini", "jev", "jev-claude" or "reference") overrides it.
 */
import Anthropic from '@anthropic-ai/sdk';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { readFileSync } from 'node:fs';
import { cloudAdapter, normalizeOptions, usageParts } from '@swissspidy/belay-core';

/**
 * Standard API prices in USD per million tokens, from https://claude.com/pricing#api (checked
 * 2026-09-29; no batch discount, no US-only inference surcharge). Cache prices are for the
 * 5-minute TTL. Keyed by the model id the API reports, so a response that a refusal fallback
 * served is priced at the fallback model's rates.
 * @type {import('@swissspidy/belay-core').PriceTable}
 */
export const claudePrices = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/**
 * Standard (not batch or flex) paid-tier prices in USD per million tokens, from
 * https://ai.google.dev/gemini-api/docs/pricing (checked 2026-10-08). These are Gemini 3.8 Flash's
 * prices through December 31, 2026; from January 1, 2027 they double ($1.50 / $7.50, cache $0.15).
 * Output includes thinking tokens.
 * @type {import('@swissspidy/belay-core').PriceTable}
 */
export const geminiPrices = {
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cacheRead: 0.075 },
};

/**
 * USD per million tokens, from https://docs.typesafe.ai/models (checked 2026-09-29): Jev 1.13 is
 * $0.042 per million input tokens, and output tokens are free.
 * @type {import('@swissspidy/belay-core').PriceTable}
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
 * @returns {import('@swissspidy/belay-core').CloudUsage[]}
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
 * Gemini through the Gemini API's REST endpoint, with the answer constrained to the JSON Schema.
 * Thinking is set to "low", like Claude's effort: classification needs little reasoning.
 */
export function geminiCloud({ model = 'gemini-3.8-flash', thinkingLevel = 'low' } = {}) {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  return cloudAdapter(
    async ({ instruction, input, jsonSchema }, { signal, reportUsage }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey ?? '' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instruction }] },
          contents: [{ role: 'user', parts: [{ text: input }] }],
          generationConfig: { responseMimeType: 'application/json', responseJsonSchema: jsonSchema, thinkingConfig: { thinkingLevel } },
        }),
        ...(signal ? { signal } : {}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`Gemini API ${res.status}: ${json.error?.message ?? JSON.stringify(json)}`);
      const u = json.usageMetadata ?? {};
      const cached = u.cachedContentTokenCount ?? 0;
      reportUsage({
        model: json.modelVersion ?? model,
        inputTokens: (u.promptTokenCount ?? 0) - cached,
        // Thinking tokens are billed as output.
        outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        cacheReadInputTokens: cached,
      });
      const candidate = json.candidates?.[0];
      const text = candidate?.content?.parts?.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
      if (!text) throw new Error(`No text in the response (finishReason: ${candidate?.finishReason ?? json.promptFeedback?.blockReason ?? 'none'})`);
      return JSON.parse(text);
    },
    { id: `google:${model}` },
  );
}

/**
 * Jev through TypeSafe's System One API: a categorical or ordinal task becomes one Choice question
 * (option descriptions become its criteria), a binary task one Noul question. Pinned to a version,
 * as TypeSafe advises when thresholds are tuned against it.
 * @returns {import('@swissspidy/belay-core').CloudRunner}
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
 * Two cloud runners in a row: `first` answers when its own confidence is at least `threshold`,
 * otherwise `second` answers. The usage of both calls is reported, so each is priced at its own
 * model's rates. Choose `threshold` on labeled data (`scripts/three-tier.mjs` fits one).
 * @param {import('@swissspidy/belay-core').CloudRunner} first  must report a confidence
 * @param {import('@swissspidy/belay-core').CloudRunner} second
 * @returns {import('@swissspidy/belay-core').CloudRunner}
 */
export function cloudCascade(first, second, { threshold }) {
  return {
    id: `${first.id}@${threshold}>${second.id}`,
    async run(request, options) {
      const a = await first.run(request, options);
      if (typeof a.confidence === 'number' && a.confidence >= threshold) return a;
      const b = await second.run(request, options);
      return { ...b, usage: [...usageParts(a.usage), ...usageParts(b.usage)] };
    },
  };
}

/**
 * Jev first; Claude for the runs where Jev's confidence is below `threshold`. 0.8 is the most
 * accurate threshold for the intent-detection example: Jev answers 296 of its 300 examples.
 */
export function jevThenClaude({ threshold = 0.8 } = {}) {
  return cloudCascade(jevCloud(), claudeCloud(), { threshold });
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

const CLOUDS = {
  claude: { keys: ['ANTHROPIC_API_KEY'], runner: () => claudeCloud(), model: 'claude-opus-5-5', prices: claudePrices },
  gemini: { keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], runner: () => geminiCloud(), model: 'gemini-3.8-flash', prices: geminiPrices },
  jev: { keys: ['JEV_API_KEY', 'TYPESAFE_API_KEY'], runner: () => jevCloud(), model: 'jev-1.13.0', prices: jevPrices },
  'jev-claude': {
    keys: ['ANTHROPIC_API_KEY'],
    alsoKeys: ['JEV_API_KEY', 'TYPESAFE_API_KEY'],
    runner: () => jevThenClaude(),
    model: 'jev-1.13.0, then claude-opus-5-5 below Jev confidence 0.8',
    prices: { ...jevPrices, ...claudePrices },
  },
};

const hasKey = (names) => names.some((n) => process.env[n]);

/**
 * The cloud runner, model name and cost config for the calibration. `prefer` is the cloud the
 * example uses; BELAY_CLOUD overrides it. Without credentials for it, the reference labels stand
 * in (the report says so). The reference labels have no cost: nobody pays for them.
 * @param {{ data: string | URL, redact?: (input: string) => string }} dataset
 * @param {{ prefer?: 'claude' | 'gemini' | 'jev' | 'jev-claude', runsPerMonth?: number }} [options]
 */
export function exampleCloud(dataset, { prefer = 'claude', runsPerMonth = 1_000_000 } = {}) {
  let choice = process.env.BELAY_CLOUD;
  if (!choice) {
    const cloud = CLOUDS[prefer];
    choice = hasKey(cloud.keys) && (!cloud.alsoKeys || hasKey(cloud.alsoKeys)) ? prefer : 'reference';
    if (choice === 'reference') process.stderr.write(`No credentials for "${prefer}": using the reference labels (set BELAY_CLOUD to choose).\n`);
  }
  if (choice === 'reference') {
    return { runner: referenceCloud(dataset), model: 'dataset labels: perfect-cloud upper bound, not a model', name: 'reference' };
  }
  const cloud = CLOUDS[choice];
  if (!cloud) throw new Error(`BELAY_CLOUD must be one of ${[...Object.keys(CLOUDS), 'reference'].join(', ')}; got "${choice}"`);
  return { runner: cloud.runner(), model: cloud.model, name: choice, cost: { currency: 'USD', prices: cloud.prices, runsPerMonth } };
}
