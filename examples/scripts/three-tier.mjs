/**
 * Simulates a three-tier cascade from the cached calibration outputs (no browser, no API calls):
 * Laya on device → Jev → Claude. Laya answers when its confidence ≥ t1; otherwise Jev is called
 * and answers when its own confidence ≥ t2; otherwise Claude answers (that run pays for both).
 *
 * Thresholds are chosen on four fifths of the examples and scored on the fifth (5-fold
 * cross-validation), and compared with the two-tier cascades and each cloud alone.
 *
 *   node scripts/three-tier.mjs            (after `npm run calibrate:all` has filled the caches)
 */
import { candidateThresholds, evaluate, loadDataset, OutputCache } from '@belay/calibrate';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TASKS = ['ticket-triage', 'content-moderation', 'intent-detection'];
const FOLDS = 5;
const NEVER = 2; // a threshold no confidence reaches

/** Replays one cloud's cached outputs for a task. */
async function samplesFor(name, cloud) {
  process.env.BELAY_CLOUD = cloud;
  const dir = join(root, name);
  // A query string gives each cloud its own module instance of the config.
  const config = (await import(`${pathToFileURL(join(dir, 'belay.config.mjs')).href}?cloud=${cloud}`)).default.tasks[name];
  const dataset = await loadDataset(join(dir, 'examples.jsonl'), config.schema);
  const cache = await OutputCache.open(join(dir, '.belay-cache', `${name}.outputs.jsonl`));
  const notCached = async () => {
    throw new Error(`${name}: output not cached; run npm run calibrate:all first`);
  };
  const backend = {
    spec: { browser: config.local, judge: null, extension: 'extension' },
    info: async () => ({ runner: 'classifier-api' }),
    availability: notCached,
    prepare: notCached,
    run: notCached,
    close: async () => {},
  };
  // Replay only: a cloud runner that rejects, so a cache miss can never become a paid request.
  const replayCloud = { id: config.cloud.id, run: notCached };
  const { samples, cached } = await evaluate({ name, config: { ...config, cloud: replayCloud }, dataset, backend, cache, cloudRetries: 0, log: () => {} });
  if (cached.local !== samples.length || cached.cloud !== samples.length) await notCached();
  return samples;
}

/** One row per example: what each tier would answer, how sure it was, and what it costs. */
async function rowsFor(name) {
  // One after the other: each config reads BELAY_CLOUD when it loads.
  const claude = await samplesFor(name, 'claude');
  const jev = await samplesFor(name, 'jev');
  return claude.map((c, i) => ({
    local: c.local ? { conf: c.local.confidence, ok: c.local.correct } : null,
    jev: { conf: jev[i].cloud?.confidence ?? 0, ok: !!jev[i].cloud?.correct, cost: jev[i].cloud?.cost ?? 0 },
    claude: { ok: !!c.cloud?.correct, cost: c.cloud?.cost ?? 0 },
  }));
}

/** Routes rows with thresholds t1 (local) and t2 (Jev; NEVER = skip Jev, -1 = trust Jev always). */
function route(rows, t1, t2, useJev) {
  let correct = 0, cost = 0, local = 0, jevAnswered = 0;
  for (const r of rows) {
    if (r.local && r.local.conf >= t1) {
      local++;
      if (r.local.ok) correct++;
      continue;
    }
    if (useJev) {
      cost += r.jev.cost;
      if (r.jev.conf >= t2) {
        jevAnswered++;
        if (r.jev.ok) correct++;
        continue;
      }
    }
    cost += r.claude.cost;
    if (r.claude.ok) correct++;
  }
  const n = rows.length;
  return { accuracy: correct / n, costPer1M: (cost / n) * 1e6, local: local / n, jev: jevAnswered / n };
}

const STRATEGIES = {
  'Claude alone': { t1: [NEVER], t2: [NEVER], useJev: false },
  'Jev alone': { t1: [NEVER], t2: [-1], useJev: true },
  'Laya → Claude': { t1: 'local', t2: [NEVER], useJev: false },
  'Laya → Jev': { t1: 'local', t2: [-1], useJev: true },
  'Jev → Claude': { t1: [NEVER], t2: 'jev', useJev: true },
  'Laya → Jev → Claude': { t1: 'local', t2: 'jev', useJev: true },
};

/** Picks thresholds on `train`: the most accurate, ties to the cheapest ('max'); or the cheapest at least as accurate as Claude alone ('claude'). */
function fit(train, strategy, goal) {
  const t1s = strategy.t1 === 'local' ? [...candidateThresholds(train.flatMap((r) => (r.local ? [r.local.conf] : []))), NEVER] : strategy.t1;
  const t2s = strategy.t2 === 'jev' ? [...candidateThresholds(train.map((r) => r.jev.conf)), NEVER] : strategy.t2;
  const floor = route(train, NEVER, NEVER, false).accuracy - 1e-12;
  let best = null;
  for (const t1 of t1s) {
    for (const t2 of t2s) {
      const e = route(train, t1, t2, strategy.useJev);
      const better =
        !best ||
        (goal === 'max'
          ? e.accuracy > best.e.accuracy + 1e-12 || (Math.abs(e.accuracy - best.e.accuracy) <= 1e-12 && e.costPer1M < best.e.costPer1M)
          : (e.accuracy >= floor && (best.e.accuracy < floor || e.costPer1M < best.e.costPer1M)) || (best.e.accuracy < floor && e.accuracy > best.e.accuracy));
      if (better) best = { t1, t2, e };
    }
  }
  return best;
}

function heldOut(rows, strategy, goal) {
  const sum = { accuracy: 0, costPer1M: 0, local: 0, jev: 0 };
  for (let k = 0; k < FOLDS; k++) {
    const train = rows.filter((_, i) => i % FOLDS !== k);
    const test = rows.filter((_, i) => i % FOLDS === k);
    const { t1, t2 } = fit(train, strategy, goal);
    const e = route(test, t1, t2, strategy.useJev);
    for (const key of Object.keys(sum)) sum[key] += e[key] * test.length;
  }
  for (const key of Object.keys(sum)) sum[key] /= rows.length;
  return sum;
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const usd = (v) => `$${v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2)}`;

for (const name of TASKS) {
  const rows = await rowsFor(name);
  console.log(`\n## ${name} (held out, ${FOLDS}-fold)\n`);
  console.log('| Strategy | Goal | Accuracy | Laya | Jev | Claude | Cloud cost per 1M runs | Thresholds (fitted on all) |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [label, strategy] of Object.entries(STRATEGIES)) {
    const tunable = strategy.t1 === 'local' || strategy.t2 === 'jev';
    for (const goal of tunable ? ['claude', 'max'] : ['-']) {
      const e = heldOut(rows, strategy, goal === '-' ? 'max' : goal);
      const goalLabel = goal === 'claude' ? '≥ Claude, cheapest' : goal === 'max' ? 'most accurate' : '';
      const all = fit(rows, strategy, goal === '-' ? 'max' : goal);
      const fitted = [strategy.t1 === 'local' ? `t1 ${all.t1}` : '', strategy.t2 === 'jev' ? `t2 ${all.t2}` : ''].filter(Boolean).join(', ');
      console.log(`| ${label} | ${goalLabel} | ${pct(e.accuracy)} | ${pct(e.local)} | ${pct(e.jev)} | ${pct(1 - e.local - e.jev)} | ${usd(e.costPer1M)} | ${fitted} |`);
    }
  }
}
