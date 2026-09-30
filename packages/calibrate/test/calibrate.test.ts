import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCalibration, schemaFingerprint, task } from '@belay/core';
import { calibrate, loadDataset, main, nodeBackend, OutputCache } from '../src/index.js';
import { datasetJsonl, fakeCloud, fakeLocal, LABELS, schema } from './fixtures.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'belay-calibrate-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(cachePath: string | null, local = fakeLocal(), cloud = fakeCloud()) {
  await writeFile(join(dir, 'examples.jsonl'), datasetJsonl());
  const dataset = await loadDataset(join(dir, 'examples.jsonl'), schema);
  const config = { schema, local, cloud, cost: { currency: 'USD', cloudPerRun: 0.002 } };
  const result = await calibrate({
    name: 'ticket-triage',
    config,
    dataset,
    backend: nodeBackend(local, { task: 'ticket-triage', schema }),
    cache: await OutputCache.open(cachePath),
    target: 0.95,
    createdAt: '2026-09-29T00:00:00Z',
    datasetPath: 'examples.jsonl',
  });
  return { result, local, cloud };
}

describe('calibrate (300 examples)', () => {
  it('produces a valid calibration file with a curve and a recommended threshold', async () => {
    const { result } = await run(null);
    const file = parseCalibration(JSON.parse(JSON.stringify(result.file)), 'ticket-triage');
    expect(file.schemaFingerprint).toBe(schemaFingerprint(schema));
    expect(file.dataset.size).toBe(300);
    expect(file.createdAt).toBe('2026-09-29T00:00:00.000Z');
    expect(file.curve.length).toBeGreaterThan(100);
    expect(file.curve[0]).toMatchObject({ threshold: 0, localShare: 1 });
    expect(result.analysis.targetMet).toBe(true);
    expect(file.expected.accuracy).toBeGreaterThanOrEqual(0.95);
    // Cheaper than cloud-only: something is answered locally.
    expect(file.expected.localShare).toBeGreaterThan(0.1);
    expect(file.expected.costPer1k).toBeLessThan(2);
    expect(file.confusion!.labels).toEqual([...LABELS]);
    expect(file.confusion!.local.flat().reduce((a, b) => a + b, 0)).toBe(300);
    expect(result.report).toContain('<title>Belay calibration: ticket-triage</title>');
    expect(result.report).toContain('"threshold":' + file.threshold);
  });

  it('is reproducible: a second run replays the cache and writes an identical file', async () => {
    const cachePath = join(dir, 'cache', 'outputs.jsonl');
    const first = await run(cachePath);
    expect(first.local.calls).toBe(300);
    expect(first.cloud.calls).toBe(300);

    const second = await run(cachePath);
    expect(second.local.calls).toBe(0);
    expect(second.cloud.calls).toBe(0);
    expect(second.result.evaluation.cached).toEqual({ local: 300, cloud: 300 });
    expect(JSON.stringify(second.result.file)).toBe(JSON.stringify(first.result.file));
    expect(second.result.report.replace(/"cached":\{[^}]*\}/, '')).toBe(first.result.report.replace(/"cached":\{[^}]*\}/, ''));
  });

  it('is reproducible without a cache when the models are deterministic', async () => {
    const a = await run(null);
    const b = await run(null);
    expect(JSON.stringify(a.result.file)).toBe(JSON.stringify(b.result.file));
  });

  it('the recommended threshold reproduces the expected numbers at runtime', async () => {
    const { result } = await run(null);
    const dataset = await loadDataset(join(dir, 'examples.jsonl'), schema);
    const t = task({ name: 'ticket-triage', schema, local: fakeLocal(), cloud: fakeCloud(), calibration: result.file });
    let correct = 0;
    let local = 0;
    for (const e of dataset.examples) {
      const r = await t.run(e.input);
      if (r.value === e.expected) correct++;
      if (r.source === 'local') local++;
    }
    expect(correct / 300).toBeCloseTo(result.file.expected.accuracy, 10);
    expect(local / 300).toBeCloseTo(result.file.expected.localShare, 10);
  });

  it('treats local failures as always-escalated and does not cache them', async () => {
    const local = fakeLocal();
    const original = local.run.bind(local);
    local.run = async (input, ctx) => {
      if (input.includes('#7 ')) throw new Error('boom');
      return original(input, ctx);
    };
    const cachePath = join(dir, 'outputs.jsonl');
    const log = vi.fn();
    await writeFile(join(dir, 'examples.jsonl'), datasetJsonl());
    const dataset = await loadDataset(join(dir, 'examples.jsonl'), schema);
    const result = await calibrate({
      name: 't',
      config: { schema, local, cloud: fakeCloud() },
      dataset,
      backend: nodeBackend(local, { task: 't', schema }),
      cache: await OutputCache.open(cachePath),
      log,
    });
    expect(result.analysis.counts.localFailed).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('example ex-7'));
    expect((await readFile(cachePath, 'utf8')).trim().split('\n')).toHaveLength(299 + 300);
  });
});

describe('calibrate with measured cost', () => {
  const usageCloud = (reportUsage = true) => {
    const inner = fakeCloud();
    const runner = {
      id: inner.id,
      get calls() {
        return inner.calls;
      },
      async run(request: Parameters<typeof inner.run>[0]) {
        const output = await inner.run(request, {});
        return reportUsage ? { ...output, confidence: 0.7, usage: { model: 'm', inputTokens: 1000, outputTokens: 10 } } : output;
      },
    };
    return runner;
  };
  const measure = async (cachePath: string | null, cloud: ReturnType<typeof usageCloud>, target: 'cloud' | 'max' = 'cloud') => {
    await writeFile(join(dir, 'examples.jsonl'), datasetJsonl());
    const dataset = await loadDataset(join(dir, 'examples.jsonl'), schema);
    const local = fakeLocal();
    return calibrate({
      name: 'ticket-triage',
      config: { schema, local, cloud, cost: { currency: 'USD', prices: { m: { input: 2, output: 10 } }, runsPerMonth: 1000 } },
      dataset,
      backend: nodeBackend(local, { task: 'ticket-triage', schema }),
      cache: await OutputCache.open(cachePath),
      target,
      createdAt: '2026-09-29T00:00:00Z',
    });
  };

  it('prices every call from its usage and records savings and a held-out estimate', async () => {
    const { file, analysis, evaluation } = await measure(null, usageCloud());
    expect(evaluation.samples.every((s) => s.cloud?.confidence === 0.7)).toBe(true);
    // 1000 × $2/M + 10 × $10/M = $0.0021 per call.
    expect(file.cost).toEqual({
      currency: 'USD',
      cloudPerRun: 0.0021,
      basis: 'measured',
      prices: { m: { input: 2, output: 10 } },
      tokensPerRun: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 },
      runsPerMonth: 1000,
    });
    expect(file.target).toMatchObject({ mode: 'cloud', value: file.expected.cloudAccuracy });
    expect(file.expected.accuracy).toBeGreaterThanOrEqual(file.expected.cloudAccuracy!);
    expect(file.expected.cloudOnlyCostPer1k).toBeCloseTo(2.1);
    expect(file.expected.savingsPer1k).toBeCloseTo(2.1 - file.expected.costPer1k!);
    expect(file.expected.savingsPer1k).toBeGreaterThan(0);
    expect(file.expected.heldOut).toMatchObject({ folds: 5 });
    expect(analysis.headToHead.kept).toBe(Math.round(file.expected.localShare * 300));
  });

  it('fetches cached cloud outputs again when they have no usage', async () => {
    const cachePath = join(dir, 'cache', 'outputs.jsonl');
    await run(cachePath); // cloudPerRun config: caches outputs without usage
    const cloud = usageCloud();
    await measure(cachePath, cloud);
    expect(cloud.calls).toBe(300);
    const again = usageCloud();
    await measure(cachePath, again);
    expect(again.calls).toBe(0);
  });

  it('fails clearly when prices are set but the runner reports no usage', async () => {
    await expect(measure(null, usageCloud(false))).rejects.toThrow(/reported no token usage/);
  });
});

describe('nodeBackend', () => {
  it('includes the judge in its cache identity', () => {
    const runner = fakeLocal();
    const ctx = { task: 't', schema };
    async function strictJudge() {
      return 1;
    }
    expect(nodeBackend(runner, ctx).spec).not.toEqual(nodeBackend(runner, ctx, strictJudge).spec);
  });
});

describe('loadDataset', () => {
  it('validates labels and ids', async () => {
    const path = join(dir, 'bad.jsonl');
    await writeFile(path, '{"input":"a","label":"bug"}\n{"input":"b","label":"spam"}\n');
    await expect(loadDataset(path, schema)).rejects.toThrow(/example 2: invalid label/);
    await writeFile(path, '{"id":1,"input":"a","label":"bug"}\n{"id":1,"input":"b","label":"bug"}\n');
    await expect(loadDataset(path, schema)).rejects.toThrow(/duplicate id/);
    await writeFile(path, '[{"text":"a","expected":"Bug"}]');
    expect((await loadDataset(path, schema)).examples[0]).toMatchObject({ id: '1', input: 'a', expected: 'bug' });
  });
});

describe('CLI', () => {
  it('runs `belay calibrate` with a config file and writes both outputs', async () => {
    await writeFile(join(dir, 'examples.jsonl'), datasetJsonl());
    // The config uses no imports: runners are plain objects.
    await writeFile(
      join(dir, 'belay.config.mjs'),
      `
const LABELS = ['bug', 'billing', 'feature', 'other'];
const truthOf = (input) => LABELS.find((l) => input.includes('about ' + l + ' '));
export default {
  tasks: {
    'ticket-triage': {
      schema: { type: 'categorical', options: LABELS },
      local: {
        id: 'cli-local',
        availability: async () => 'available',
        run: async (input) => ({ value: truthOf(input), confidence: input.length % 2 ? 0.9 : 0.6 }),
      },
      cloud: { id: 'cli-cloud', run: async (req) => ({ value: truthOf(req.input) }) },
      target: 0.99,
    },
  },
};`,
    );
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cwd = process.cwd();
    let out = '';
    try {
      process.chdir(dir);
      const code = await main(['calibrate', '--data', 'examples.jsonl', '--out', 'out/cal.json', '--report', 'out/report.html', '--created-at', '2026-01-01T00:00:00Z']);
      expect(code).toBe(0);
      out = stdout.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      process.chdir(cwd);
      stdout.mockRestore();
      stderr.mockRestore();
    }
    const file = parseCalibration(JSON.parse(await readFile(join(dir, 'out/cal.json'), 'utf8')), 'ticket-triage');
    expect(file.local.runner).toBe('cli-local');
    expect(file.expected.accuracy).toBe(1);
    expect(file.expected.localShare).toBe(1);
    expect(file.threshold).toBe(0);
    expect(await readFile(join(dir, 'out/report.html'), 'utf8')).toContain('examples.jsonl');
    expect(out).toContain('Target          99.0% met');
  });

  it('reports usage errors', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main(['nope'])).toBe(1);
      await expect(main(['calibrate'])).rejects.toThrow(/--data is required/);
      await expect(main(['calibrate', '--data', 'x.jsonl', '--config', join(dir, 'missing.mjs')])).rejects.toThrow(/not found/);
      await writeFile(join(dir, 'examples.jsonl'), datasetJsonl(4));
      await writeFile(join(dir, 'c.mjs'), `export default { tasks: { t: { schema: { type: 'binary', prompt: 'q' }, local: { id: 'l', availability: async () => 'available', run: async () => ({ value: true, confidence: 1 }) }, cloud: { id: 'c', run: async () => ({ value: true }) } } } };`);
      for (const bad of ['abc', '0', '-1', '1.5']) {
        await expect(main(['calibrate', '--data', join(dir, 'examples.jsonl'), '--config', join(dir, 'c.mjs'), `--concurrency=${bad}`])).rejects.toThrow(/--concurrency must be a positive integer/);
      }
    } finally {
      stderr.mockRestore();
    }
  });
});
