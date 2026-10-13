#!/usr/bin/env node
/**
 * Simulates a learned classifier (`@swissspidy/belay-learn`) in production: each task's
 * `stream.jsonl` arrives one input at a time, the cascade answers it, and the classifier learns
 * from every cloud answer. It uses the real `task()` and `learnedClassifier()`, and real
 * embeddings (bge-small-en-v1.5 through transformers.js, the model a page would download).
 *
 *   node examples/scripts/learn-simulate.mjs [ticket-triage content-moderation intent-detection]
 *
 * The teacher stands in for the cloud model, which this script does not call:
 *
 * - `reference`: the dataset's own labels, i.e. a cloud that is always right;
 * - `noisy`: wrong as often as the task's calibrated cloud model was on examples.jsonl (Claude
 *   on ticket triage, Jev on the others), with the wrong label drawn uniformly. Real cloud
 *   mistakes are not uniform, so this is a rough model of a fallible teacher.
 *
 * Each runs cold (no seed) and seeded (a seed built from examples.jsonl, disjoint from the
 * stream). Content moderation also runs `shift`: the stream sorted by label, all non-toxic
 * comments first, then all toxic ones, with the reference teacher. It tests what the calibration
 * does when the inputs change under a confident classifier. Accuracy is measured against the
 * dataset labels.
 *
 * It runs through `simulateLearning()`, the function behind `belay simulate`, with the package
 * defaults: uniform spot checks and the distance gate on. The `ablation` section of the output
 * (ADR 0005) reruns the cold start with each spot-check strategy, with and without the gate.
 * Writes `learn-simulation.json` per task and prints a summary.
 *
 * Embeddings are cached in `.belay-cache/<task>.embeddings.<model>.jsonl` (see
 * `shared/embeddings.mjs`), so a re-run needs neither the model nor the network.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { buildSeed, simulateLearning } from '@swissspidy/belay-learn';
import { cachedEmbedder, readJsonl } from '../shared/embeddings.mjs';

const THRESHOLD = 0.9;
const EXPLORE = 0.05;
const WINDOW = 100;

const TASKS = {
  'ticket-triage': { module: '../ticket-triage/task.mjs', schema: 'triageSchema' },
  'content-moderation': { module: '../content-moderation/task.mjs', schema: 'moderationSchema' },
  'intent-detection': { module: '../intent-detection/task.mjs', schema: 'intentSchema' },
};

/** The ablation of ADR 0005: spot-check strategy × distance gate, cold start. */
const VARIANTS = [
  { strategy: 'uniform', gate: false },
  { strategy: 'uniform', gate: true },
  { strategy: 'informative', gate: false },
  { strategy: 'informative', gate: true },
];

const only = process.argv.slice(2);
const root = new URL('../', import.meta.url);

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function simulate({ name, schema, stream, embedder, teacher, seed, labels, strategy = 'uniform', gate = true }) {
  const noise = rng(11);
  const r = await simulateLearning({
    name,
    schema,
    embedder,
    stream: stream.map((e) => ({ input: e.input, value: e.label })),
    teacher: (_input, truth) => {
      if (!teacher.errorRate || noise() >= teacher.errorRate) return truth;
      const others = labels.filter((l) => l !== String(truth));
      const wrong = others[Math.floor(noise() * others.length)];
      return schema.type === 'binary' ? wrong === 'true' : wrong;
    },
    threshold: THRESHOLD,
    explore: { rate: EXPLORE, strategy },
    randomSeed: 7,
    window: WINDOW,
    classifier: gate ? {} : { distanceGate: false },
    ...(seed ? { seed } : {}),
  });
  const { stats } = r;
  return {
    all: r.all,
    last: r.last,
    curve: r.curve,
    final: {
      examples: stats.examples,
      head: stats.head,
      heads: { knn: stats.heads.knn.recentAccuracy, softmax: stats.heads.softmax.recentAccuracy },
      gate: stats.gate,
    },
  };
}

const pct = (x) => (x === null ? '  –  ' : `${(x * 100).toFixed(1).padStart(5)}%`);

for (const [name, spec] of Object.entries(TASKS)) {
  if (only.length && !only.includes(name)) continue;
  const schema = (await import(spec.module))[spec.schema];
  const stream = await readJsonl(new URL(`${name}/stream.jsonl`, root));
  const examples = await readJsonl(new URL(`${name}/examples.jsonl`, root));
  const calibration = JSON.parse(await readFile(new URL(`${name}/belay.calibration.json`, root), 'utf8'));
  const labels = [...new Set(stream.map((e) => String(e.label)))];
  const embedder = await cachedEmbedder(name);
  const seed = await buildSeed({ task: name, schema, embedder, examples: examples.map((e) => ({ input: e.input, value: e.label })), createdAt: '2026-10-12T00:00:00Z' });

  const cloudModel = calibration.cloud.model ?? calibration.cloud.runner;
  const teachers = [
    { id: 'reference', errorRate: 0 },
    { id: 'noisy', errorRate: 1 - calibration.expected.cloudAccuracy, model: cloudModel },
  ];
  const results = [];
  const shifted = name === 'content-moderation' ? [...stream].sort((a, b) => Number(a.label) - Number(b.label)) : null;
  if (shifted) {
    const r = await simulate({ name, schema, stream: shifted, embedder, teacher: teachers[0], seed: null, labels });
    results.push({ teacher: 'reference', teacherAccuracy: 1, seeded: false, order: 'shift', ...r });
  }
  for (const teacher of teachers) {
    for (const seeded of [false, true]) {
      const started = Date.now();
      const r = await simulate({ name, schema, stream, embedder, teacher, seed: seeded ? seed : null, labels });
      results.push({ teacher: teacher.id, teacherAccuracy: 1 - teacher.errorRate, seeded, order: 'mixed', ...r });
      console.error(`${name} ${teacher.id}${seeded ? ' seeded' : ''}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
  }
  // The defaults (uniform, gate) are the unseeded rows of `results`; run the other three.
  const ablation = [];
  const runs = [
    ...teachers.map((teacher) => ({ teacher, order: 'mixed', stream })),
    ...(shifted ? [{ teacher: teachers[0], order: 'shift', stream: shifted }] : []),
  ];
  for (const { teacher, order, stream: s } of runs) {
    for (const v of VARIANTS) {
      const base = results.find((r) => r.teacher === teacher.id && r.order === order && !r.seeded);
      const r = v.strategy === 'uniform' && v.gate ? base : await simulate({ name, schema, stream: s, embedder, teacher, seed: null, labels, ...v });
      ablation.push({ teacher: teacher.id, order, strategy: v.strategy, gate: v.gate, all: r.all, last: r.last, gated: r.final.gate.gated });
    }
    console.error(`${name} ablation ${teacher.id} ${order}: done`);
  }
  const out = {
    task: name,
    createdAt: '2026-10-12T00:00:00Z',
    embedder: embedder.id,
    stream: stream.length,
    seedExamples: seed.examples.length,
    threshold: THRESHOLD,
    explore: EXPLORE,
    window: WINDOW,
    cloudPerRun: calibration.cost?.cloudPerRun ?? null,
    cloudModel,
    results,
    ablation,
  };
  await writeFile(new URL(`${name}/learn-simulation.json`, root), JSON.stringify(out, null, 2) + '\n');

  console.log(`\n${name}: ${stream.length} inputs, threshold ${THRESHOLD}, explore ${EXPLORE}`);
  console.log('teacher    seed   order | local share  local acc  accuracy | last 300: local share  local acc  accuracy');
  for (const r of results) {
    console.log(
      `${r.teacher.padEnd(10)} ${(r.seeded ? 'yes' : 'no').padEnd(6)} ${r.order.padEnd(5)} | ${pct(r.all.localShare)}      ${pct(r.all.localAccuracy)}     ${pct(r.all.accuracy)} |           ${pct(r.last.localShare)}     ${pct(r.last.localAccuracy)}     ${pct(r.last.accuracy)}`,
    );
  }
  console.log('\nablation (no seed)                   | local share  local acc  accuracy | gated');
  for (const r of ablation) {
    console.log(
      `${r.teacher.padEnd(10)} ${r.order.padEnd(5)} ${r.strategy.padEnd(11)} ${(r.gate ? 'gate' : 'no gate').padEnd(7)} | ${pct(r.all.localShare)}      ${pct(r.all.localAccuracy)}     ${pct(r.all.accuracy)} | ${r.gated}`,
    );
  }
}
