#!/usr/bin/env node
/**
 * Are a real cloud model's mistakes independent of an embedding classifier's? `teacherAccuracy`
 * (ADR 0006) assumes so. On examples.jsonl, with the cloud answers cached by the calibration
 * (`.belay-cache/<task>.outputs.jsonl`), it compares a leave-one-out kNN (k = 7) with the cloud,
 * and shows what the correction would estimate on the kNN's most confident inputs.
 *
 *   node examples/scripts/teacher-independence.mjs <task> <jev|claude>
 */
import { evaluate, loadDataset, OutputCache } from '@swissspidy/belay-calibrate';
import { knnPredict } from '@swissspidy/belay-learn';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cachedEmbedder } from '../shared/embeddings.mjs';

const [name, cloudId] = process.argv.slice(2);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.BELAY_CLOUD = cloudId;
// Only cached answers are read; the cloud clients just need a key to be constructed.
for (const key of ['ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY', 'GEMINI_API_KEY']) process.env[key] ??= 'unused';
const dir = join(root, name);
const config = (await import(pathToFileURL(join(dir, 'belay.config.mjs')).href)).default.tasks[name];
const dataset = await loadDataset(join(dir, 'examples.jsonl'), config.schema);
const cache = await OutputCache.open(join(dir, '.belay-cache', `${name}.outputs.jsonl`));
const notCached = async () => {
  throw new Error('not cached');
};
const backend = { spec: { browser: config.local, judge: null, extension: 'extension' }, info: async () => ({ runner: 'classifier-api' }), availability: notCached, prepare: notCached, run: notCached, close: async () => {} };
const { samples } = await evaluate({ name, config: { ...config, cloud: { id: config.cloud.id, run: notCached } }, dataset, backend, cache, cloudRetries: 0, log: () => {} });

const labels = [...new Set(dataset.examples.map((e) => String(e.truth)))];
const emb = await (await cachedEmbedder(name)).embed(dataset.examples.map((e) => e.input));
const ex = emb.map((v, i) => ({ embedding: v, label: labels.indexOf(String(dataset.examples[i].truth)), weight: 1 }));
const rows = samples.map((s, i) => {
  const p = knnPredict(ex.filter((_, j) => j !== i), emb[i], labels.length, { k: 7, temperature: 0.1 });
  let top = 0;
  for (let l = 1; l < p.length; l++) if (p[l] > p[top]) top = l;
  const cloudValue = String(s.cloud?.label);
  return { score: p[top], ok: top === ex[i].label, cloudOk: !!s.cloud?.correct, agree: labels[top] === cloudValue };
});
const a = rows.filter((r) => r.cloudOk).length / rows.length;
const e = (1 - a) / Math.max(1, labels.length - 1);
const rate = (xs, f) => (xs.length ? xs.filter(f).length / xs.length : NaN);
console.log(`${name} (${cloudId}): cloud accuracy ${a.toFixed(3)}, kNN LOO accuracy ${rate(rows, (r) => r.ok).toFixed(3)}`);
console.log(`P(cloud wrong | kNN right) ${rate(rows.filter((r) => r.ok), (r) => !r.cloudOk).toFixed(3)}, P(cloud wrong | kNN wrong) ${rate(rows.filter((r) => !r.ok), (r) => !r.cloudOk).toFixed(3)}`);
const sorted = [...rows].sort((x, y) => y.score - x.score);
for (const q of [0.25, 0.5, 1]) {
  const top = sorted.slice(0, Math.round(q * sorted.length));
  const agree = rate(top, (r) => r.agree);
  console.log(`top ${q * 100}% by kNN score: true acc ${rate(top, (r) => r.ok).toFixed(3)}, agreement ${agree.toFixed(3)}, corrected ${Math.min(1, (agree - e) / (a - e)).toFixed(3)}, cloud acc there ${rate(top, (r) => r.cloudOk).toFixed(3)}`);
}
