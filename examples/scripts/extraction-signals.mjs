/**
 * Compares confidence signals for the event-extraction example from its cached outputs: the Laya
 * judge it was calibrated with, a verbatim check, Jev as a judge, and self-consistency across extra
 * Gemini Nano runs (from `scripts/extraction-consistency.mjs`, when its cache exists). Each signal replaces the local
 * confidence and goes through the same analysis as `belay calibrate` (target 'max', 5-fold held out).
 *
 *   node scripts/extraction-signals.mjs    (Jev judgements are cached; JEV_API_KEY fetches missing ones)
 */
import { analyze, crossValidate, evaluate, loadDataset, OutputCache } from '@belay/calibrate';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { FIELDS, normalize, sameEvent } from '../event-extraction/task.mjs';

process.env.BELAY_CLOUD ??= 'claude';
const dir = new URL('../event-extraction/', import.meta.url).pathname;
const config = (await import(`${dir}belay.config.mjs`)).default.tasks['event-extraction'];
const dataset = await loadDataset(`${dir}examples.jsonl`, config.schema);
const cache = await OutputCache.open(`${dir}.belay-cache/event-extraction.outputs.jsonl`);
const notCached = async () => {
  throw new Error('output not cached: run npm run calibrate:extraction first');
};
const backend = { spec: { browser: config.local, judge: config.judge, extension: 'extension' }, info: async () => ({ runner: 'prompt-api' }), availability: notCached, prepare: notCached, run: notCached, close: async () => {} };
const { samples } = await evaluate({ name: 'event-extraction', config, dataset, backend, cache });

/** Share of the extracted values that appear word for word in the request (1 when nothing was extracted). */
function verbatim(input, value) {
  const request = ` ${normalize(input)} `;
  const values = FIELDS.map((f) => normalize(value?.[f])).filter(Boolean);
  return values.length ? values.filter((v) => request.includes(` ${v} `)).length / values.length : 1;
}

// Jev as a judge: one yes/no question per extraction, P(yes) as the confidence.
const jevFile = `${dir}.belay-cache/jev-judge.json`;
const jev = existsSync(jevFile) ? JSON.parse(readFileSync(jevFile, 'utf8')) : {};
const missing = samples.filter((s) => s.local && jev[s.id] === undefined);
if (missing.length) {
  const client = new TypeSafeClient({ apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY });
  const question = {
    type: 'noul',
    instructions:
      'Is `extraction` exactly the calendar event stated in `request`: the right words for each field, nothing invented, nothing missing? Fields that the request does not mention must be null.',
    criteria: { true: 'every field is right', false: 'at least one field is wrong, missing or invented' },
  };
  for (const s of missing) {
    const r = await client.systemOne({ model: 'jev-1.13.0', state: { request: s.input, extraction: s.local.value }, questions: { ok: question } });
    jev[s.id] = r.answers.ok.noul;
  }
  writeFileSync(jevFile, JSON.stringify(jev, null, 0) + '\n');
}

// Self-consistency: extra Nano runs per request (scripts/extraction-consistency.mjs).
const runsFile = `${dir}.belay-cache/consistency.jsonl`;
const runs = new Map();
if (existsSync(runsFile)) {
  for (const line of readFileSync(runsFile, 'utf8').trim().split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    runs.set(r.id, [...(runs.get(r.id) ?? []), r.value]);
  }
}
const extraRuns = Math.max(0, ...[...runs.values()].map((v) => v.length));
const expected = new Map(dataset.examples.map((e) => [e.id, e.expected]));
/** Share of the extra runs that agree with the original answer. */
const agreement = (s) => {
  const extra = runs.get(s.id) ?? [];
  return extra.length ? extra.filter((v) => sameEvent(v, s.local.value)).length / extra.length : 0;
};
/** The most common answer among the original and the extra runs, and its share of the votes. */
const majority = (s) => {
  const answers = [s.local.value, ...(runs.get(s.id) ?? [])];
  let best = answers[0], votes = 0;
  for (const a of answers) {
    const n = answers.filter((b) => sameEvent(a, b)).length;
    if (n > votes) [best, votes] = [a, n];
  }
  return { value: best, share: votes / answers.length };
};

const signals = {
  'Laya judge (calibrated)': (s) => s.local.confidence,
  'Verbatim check': (s) => verbatim(s.input, s.local.value),
  'Jev judge': (s) => jev[s.id],
  'min(Jev, Laya)': (s) => Math.min(jev[s.id], s.local.confidence),
  ...(extraRuns
    ? {
        [`Agreement of ${extraRuns} extra Nano runs`]: agreement,
        'Agreement × Jev': (s) => agreement(s) * jev[s.id],
        [`Majority vote of ${extraRuns + 1} runs (answer changes too)`]: { majority: true },
      }
    : {}),
};
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const locals = samples.filter((s) => s.local);
console.log(`Gemini Nano: ${pct(locals.filter((s) => s.local.correct).length / samples.length)} right; Claude: ${pct(samples.filter((s) => s.cloud?.correct).length / samples.length)}\n`);
const n = samples.filter((s) => !extraRuns || (runs.get(s.id)?.length ?? 0) === extraRuns).length;
if (n < samples.length) console.log(`Scored on the ${n} requests with all ${extraRuns} extra runs cached.\n`);
console.log('| Signal | Local right | Top third by signal: right | Threshold | Accuracy | Held out | Local (held out) | Claude cost saved |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const [name, signal] of Object.entries(signals)) {
  const score = (s) => {
    if (typeof signal === 'function') return { ...s.local, confidence: signal(s) };
    const m = majority(s);
    return { ...s.local, value: m.value, confidence: m.share, correct: sameEvent(m.value, expected.get(s.id)) };
  };
  const complete = (s) => !extraRuns || (runs.get(s.id)?.length ?? 0) === extraRuns;
  const scored = samples.filter(complete).map((s) => (s.local ? { ...s, local: score(s) } : s));
  const options = { target: 'max', cost: { currency: 'USD' } };
  const a = analyze(scored, options);
  const cv = crossValidate(scored, options);
  const top = scored.filter((s) => s.local).sort((x, y) => y.local.confidence - x.local.confidence).slice(0, Math.floor(scored.length / 3));
  const saved = a.expected.savingsPer1k / a.expected.cloudOnlyCostPer1k;
  const localRight = scored.filter((s) => s.local?.correct).length / scored.length;
  console.log(`| ${name} | ${pct(localRight)} | ${pct(top.filter((s) => s.local.correct).length / top.length)} | ${a.threshold} | ${pct(a.expected.accuracy)} | ${cv ? pct(cv.accuracy) : '–'} | ${cv ? pct(cv.localShare) : '–'} | ${pct(saved)} |`);
}
