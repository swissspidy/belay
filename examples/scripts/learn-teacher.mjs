#!/usr/bin/env node
/**
 * The experiments behind `teacherAccuracy` (ADR 0006): one simulated stream per call, with a
 * teacher that is always right (`reference`), wrong at random as often as the task's calibrated
 * cloud model (`noisy`, as in learn-simulate.mjs), or wrong as often but mostly on borderline
 * inputs (`hard`), so that its mistakes correlate with the classifier's.
 *
 *   node examples/scripts/learn-teacher.mjs <task> <reference|noisy|hard> <variant> [seeded]
 *
 * Variants: `baseline` (threshold 0.9), `teacher` (teacherAccuracy = the calibrated cloud
 * accuracy), and `b95` / `t95`, the same at threshold 0.95. Prints one summary line. Uses the
 * cached embeddings, like learn-simulate.mjs.
 */
import { readFile } from 'node:fs/promises';
import { buildSeed, simulateLearning, softmaxTrain, softmaxPredict } from '@swissspidy/belay-learn';
import { cachedEmbedder, readJsonl } from '../shared/embeddings.mjs';

const [name, teacherId, variantId, seededArg] = process.argv.slice(2);
const seeded = seededArg === 'seeded';
const root = new URL('../', import.meta.url);
const TASKS = {
  'ticket-triage': { module: '../ticket-triage/task.mjs', schema: 'triageSchema' },
  'content-moderation': { module: '../content-moderation/task.mjs', schema: 'moderationSchema' },
  'intent-detection': { module: '../intent-detection/task.mjs', schema: 'intentSchema' },
};

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const schema = (await import(TASKS[name].module))[TASKS[name].schema];
const stream = await readJsonl(new URL(`${name}/stream.jsonl`, root));
const examples = await readJsonl(new URL(`${name}/examples.jsonl`, root));
const calibration = JSON.parse(await readFile(new URL(`${name}/belay.calibration.json`, root), 'utf8'));
const labels = [...new Set(stream.map((e) => String(e.label)))];
const cloudAccuracy = calibration.expected.cloudAccuracy;
const embedder = await cachedEmbedder(name);
const toValue = (l) => (schema.type === 'binary' ? l === 'true' : l);

// Teachers. `noisy` reproduces examples/scripts/learn-simulate.mjs exactly.
if (!['reference', 'noisy', 'hard'].includes(teacherId)) throw new Error(`unknown teacher "${teacherId}" (reference, noisy or hard)`);
let teacher;
const errorRate = teacherId === 'reference' ? 0 : 1 - cloudAccuracy;
if (teacherId === 'reference') teacher = (_i, truth) => truth;
else if (teacherId === 'noisy') {
  const noise = rng(11);
  teacher = (_input, truth) => {
    if (noise() >= errorRate) return truth;
    const others = labels.filter((l) => l !== String(truth));
    return toValue(others[Math.floor(noise() * others.length)]);
  };
} else if (teacherId === 'hard') {
  // Mistakes concentrated on hard inputs, and (for multi-class) on the label a simple embedding
  // model would pick: correlated with the classifier's own mistakes. Difficulty comes from a
  // softmax fitted on examples.jsonl (moderation: from the raters' toxicity share).
  const emb = await embedder.embed(stream.map((e) => e.input));
  const exEmb = await embedder.embed(examples.map((e) => e.input));
  const model = await softmaxTrain(
    examples.map((e, i) => ({ embedding: exEmb[i], label: labels.indexOf(String(e.label)), weight: 1 })).filter((e) => e.label >= 0),
    labels.length,
    exEmb[0].length,
    { epochs: 200 },
  );
  const info = stream.map((e, i) => {
    const p = softmaxPredict(model, emb[i]);
    const order = [...p.keys()].sort((a, b) => p[b] - p[a]);
    const truth = labels.indexOf(String(e.label));
    const wrong = order[0] !== truth ? order[0] : order[1];
    const w = typeof e.toxicity === 'number' ? 1 - Math.abs(2 * e.toxicity - 1) : 1 - p[truth];
    return { wrong, w: Math.max(0, w) };
  });
  // Scale so that the mean flip probability is the error rate.
  let lo = 0, hi = 1e6;
  for (let it = 0; it < 100; it++) {
    const c = (lo + hi) / 2;
    const m = info.reduce((s, x) => s + Math.min(1, c * x.w), 0) / info.length;
    if (m > errorRate) hi = c; else lo = c;
  }
  const r = rng(13);
  const flip = new Map(stream.map((e, i) => [e.input, r() < Math.min(1, lo * info[i].w) ? labels[info[i].wrong] : null]));
  const realized = [...flip.values()].filter(Boolean).length / stream.length;
  console.error(`hard teacher: realized error ${realized.toFixed(3)} (target ${errorRate.toFixed(3)})`);
  teacher = (input, truth) => (flip.get(input) ? toValue(flip.get(input)) : truth);
}

const VARIANTS = {
  baseline: {},
  teacher: { classifier: { teacherAccuracy: cloudAccuracy } },
  b95: { threshold: 0.95 },
  t95: { threshold: 0.95, classifier: { teacherAccuracy: cloudAccuracy } },
};
const variant = VARIANTS[variantId];
if (!variant) throw new Error(`unknown variant ${variantId}`);
const seed = seeded
  ? await buildSeed({ task: name, schema, embedder, examples: examples.map((e) => ({ input: e.input, value: e.label })), createdAt: '2026-10-12T00:00:00Z' })
  : null;

const started = Date.now();
const r = await simulateLearning({
  name,
  schema,
  embedder,
  stream: stream.map((e) => ({ input: e.input, value: e.label })),
  teacher,
  threshold: variant.threshold ?? 0.9,
  explore: { rate: 0.05, strategy: 'uniform', ...variant.explore },
  randomSeed: 7,
  window: 100,
  classifier: variant.classifier ?? {},
  ...(seed ? { seed } : {}),
});
const p = (x) => (x == null ? '  -  ' : (x * 100).toFixed(1));
console.log(`${name} ${teacherId} ${variantId}${seeded ? ' seeded' : ''}: on device ${p(r.all.localShare)}%, accurate ${p(r.all.localAccuracy)}%, overall ${p(r.all.accuracy)}% | last 300: ${p(r.last.localShare)}%, ${p(r.last.localAccuracy)}%, ${p(r.last.accuracy)}%`);
