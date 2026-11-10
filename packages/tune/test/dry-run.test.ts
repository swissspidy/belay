import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserBackend, nodeBackend, OutputCache, type LocalBackend } from '@swissspidy/belay-calibrate';
import { fakeLocal, hash01, LABELS, schema } from '../../calibrate/test/fixtures.js';
import { dryRun, loadSplit, tuneCommand, type Baseline } from '../src/index.js';

const truthOf = (input: string) => LABELS.find((l) => input.includes(`about ${l} `))!;

/** A split as `belay datasets` writes it: mostly silver, some gold with the cloud's answer, some without. */
function splitJsonl(n = 300): string {
  return Array.from({ length: n }, (_, i) => {
    const label = LABELS[i % LABELS.length]!;
    const input = `ticket #${i + 1} about ${label} (${hash01(String(i)).toFixed(4)})`;
    const row: Record<string, unknown> = { id: `ex-${i + 1}`, input, label, labelKind: 'silver', origin: 'cloud', cloud: label, weight: i % 7 === 0 ? 10 : 1 };
    if (i % 5 === 0) Object.assign(row, { labelKind: 'gold', origin: 'feedback', cloud: i % 100 === 0 ? 'other' : label });
    if (i % 25 === 5) delete row['cloud'];
    return JSON.stringify(row);
  }).join('\n');
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'belay-tune-'));
  await writeFile(join(dir, 'validation.jsonl'), splitJsonl());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const backendOf = (runner = fakeLocal()) => nodeBackend(runner, { task: 'ticket-triage', schema });

describe('loadSplit', () => {
  it('reads split files and plain labeled datasets', async () => {
    const split = await loadSplit(join(dir, 'validation.jsonl'), schema);
    expect(split.examples).toHaveLength(300);
    expect(split.examples[0]).toMatchObject({ id: 'ex-1', labelKind: 'gold', weight: 10, cloud: 'other' });
    expect(split.examples[5]).not.toHaveProperty('cloud');
    expect(split.dataset.examples[1]).toMatchObject({ id: 'ex-2', expected: 'billing', truth: 'billing' });

    await writeFile(join(dir, 'plain.jsonl'), '{"input":"a","label":"bug"}\n// comment\n{"input":"b","label":"other","cloud":"gone-option"}\n');
    const plain = await loadSplit(join(dir, 'plain.jsonl'), schema);
    expect(plain.examples).toEqual([
      { id: '1', input: 'a', label: 'bug', labelKind: 'gold', weight: 1 },
      { id: '2', input: 'b', label: 'other', labelKind: 'gold', weight: 1 },
    ]);
  });

  it('rejects malformed rows', async () => {
    const check = async (content: string, message: RegExp) => {
      await writeFile(join(dir, 'bad.jsonl'), content);
      await expect(loadSplit(join(dir, 'bad.jsonl'), schema)).rejects.toThrow(message);
    };
    await check('{"input":"a","label":"nope"}', /invalid label/);
    await check('{"label":"bug"}', /no "input"/);
    await check('{"input":"a","label":"bug","weight":0}', /weight/);
    await check('{"input":"a","label":"bug","labelKind":"bronze"}', /labelKind/);
    await check('{"id":1,"input":"a","label":"bug"}\n{"id":1,"input":"b","label":"bug"}', /duplicate id/);
    await check('not json', /invalid JSON/);
    await check('\n', /no examples/);
  });
});

describe('dryRun', () => {
  it('scores the current config against the labels, without a cloud call', async () => {
    const split = await loadSplit(join(dir, 'validation.jsonl'), schema);
    const runner = fakeLocal();
    const baseline = await dryRun({
      name: 'ticket-triage',
      config: { schema, models: { local: 'fake-1' } },
      split,
      backend: backendOf(runner),
      cache: await OutputCache.open(null),
      target: 0.95,
      seed: 3,
      createdAt: '2026-11-10T00:00:00.000Z',
    });
    expect(runner.calls).toBe(300);
    expect(baseline).toMatchObject({
      version: 1,
      task: 'ticket-triage',
      createdAt: '2026-11-10T00:00:00.000Z',
      environment: { runner: 'fake-local', model: 'fake-1' },
      dataset: { size: 300, fingerprint: split.dataset.fingerprint },
      seed: '3',
      // 60 gold examples; 12 of them have no recorded cloud answer; 3 of the other 48 have a wrong one.
      cloud: { known: 48, assumed: 12 },
      spread: 0,
      stable: true,
      localFailures: 0,
      cached: 0,
    });
    expect(baseline.runs).toHaveLength(1);
    const s = baseline.score;
    expect(s).toMatchObject({ targetMet: true, examples: 300, gold: 60, silver: 240 });
    expect(s.accuracy).toBeGreaterThanOrEqual(0.95);
    expect(s.localShare).toBeGreaterThan(0.1);
    expect(s.localShare).toBeLessThan(0.9);
    expect(s.localShareInterval![0]).toBeLessThan(s.localShare);
    expect(s.cloudOnlyAccuracy).toBeLessThan(1);
    expect(s.goldAccuracy).not.toBeNull();
    expect(s.cloudAgreement).toBeGreaterThan(0.9);
    expect(baseline.cloud.assumedAccuracy).toBeGreaterThan(0.5);
    expect(baseline.cloud.assumedAccuracy).toBeLessThan(1);
  });

  it('runs again without the cache on a repeat, and two runs of a stable runner agree', async () => {
    const split = await loadSplit(join(dir, 'validation.jsonl'), schema);
    const runner = fakeLocal();
    const cache = await OutputCache.open(join(dir, 'cache.jsonl'));
    const options = { name: 'ticket-triage', config: { schema }, split, cache, target: 0.95 };
    const first = await dryRun({ ...options, backend: backendOf(runner), repeat: 2 });
    expect(runner.calls).toBe(600);
    expect(first.runs).toHaveLength(2);
    expect(first).toMatchObject({ spread: 0, stable: true, cached: 0 });

    const cached = await dryRun({ ...options, backend: backendOf(runner) });
    expect(runner.calls).toBe(600);
    expect(cached.cached).toBe(300);
    expect(cached.score).toEqual(first.score);
    await dryRun({ ...options, backend: backendOf(runner), refresh: true });
    expect(runner.calls).toBe(900);
  });

  it('flags runs that disagree by more than a point', async () => {
    const split = await loadSplit(join(dir, 'validation.jsonl'), schema);
    let calls = 0;
    // The second pass gets everything wrong.
    const drifted = { ...fakeLocal(), run: async (input: string) => ({ value: calls++ < 300 ? truthOf(input) : LABELS[(LABELS.indexOf(truthOf(input)) + 1) % 4]!, confidence: 0.9 }) };
    const baseline = await dryRun({ name: 'ticket-triage', config: { schema }, split, backend: backendOf(drifted), cache: await OutputCache.open(null), target: 0.95, repeat: 2, resamples: 0 });
    expect(baseline.runs[0]!.localShare).toBe(1);
    expect(baseline.runs[1]!.localShare).toBe(0);
    expect(baseline).toMatchObject({ spread: 1, stable: false });
  });

  it('counts local failures as escalations and takes a given cloud accuracy', async () => {
    const split = await loadSplit(join(dir, 'validation.jsonl'), schema);
    const flaky = { ...fakeLocal(), run: async (input: string) => (input.includes('#1 ') ? Promise.reject(new Error('gpu lost')) : { value: truthOf(input), confidence: 0.9 }) };
    const baseline = await dryRun({ name: 'ticket-triage', config: { schema }, split, backend: backendOf(flaky), cache: await OutputCache.open(null), target: 0.9, cloudAccuracy: 0.5, resamples: 0 });
    expect(baseline.localFailures).toBe(1);
    expect(baseline.cloud.assumedAccuracy).toBe(0.5);
    expect(baseline.score.localShare).toBeLessThan(1);
    await expect(dryRun({ name: 't', config: { schema }, split, backend: backendOf(), cache: await OutputCache.open(null), target: 0.9, repeat: 0 })).rejects.toThrow(/repeat/);
  });
});

describe('belay tune --dry-run', () => {
  const CONFIG = `
const LABELS = ['bug', 'billing', 'feature', 'other'];
const truthOf = (input) => LABELS.find((l) => input.includes('about ' + l + ' '));
export default {
  tasks: {
    'ticket-triage': {
      schema: { type: 'categorical', options: LABELS },
      local: { id: 'cli-local', availability: async () => 'available', run: async (input) => ({ value: input.length % 3 ? truthOf(input) : 'other', confidence: input.length % 3 ? 0.9 : 0.6 }) },
      cloud: { id: 'cli-cloud', run: async () => { throw new Error('the cloud must not be called'); } },
    },
  },
};`;

  it('scores the default split and writes the baseline', async () => {
    await writeFile(join(dir, 'belay.config.mjs'), CONFIG);
    const cwd = process.cwd();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      process.chdir(dir);
      await expect(tuneCommand(['--dry-run', '--target', '0.95'])).rejects.toThrow(/belay datasets --task ticket-triage/);
      await expect(tuneCommand(['--dry-run', '--data', 'validation.jsonl'])).rejects.toThrow(/--target is required/);
      await expect(tuneCommand(['--target', '0.95'])).rejects.toThrow(/--dry-run/);
      await expect(tuneCommand(['--dry-run', '--data', 'validation.jsonl', '--target', '2'])).rejects.toThrow(/--target/);
      await expect(tuneCommand(['--dry-run', '--data', 'validation.jsonl', '--target', '0.9', '--repeat', '0'])).rejects.toThrow(/--repeat/);

      const code = await tuneCommand(['--dry-run', '--data', 'validation.jsonl', '--target', '0.95', '--repeat', '2', '--created-at', '2026-11-10T00:00:00Z']);
      expect(code).toBe(0);
      const printed = stdout.mock.calls.map((c) => String(c[0])).join('');
      expect(printed).toMatch(/Target\s+95\.0% accuracy met/);
      expect(printed).toMatch(/Local share\s+\d+\.\d% \(95% CI \d+\.\d%–\d+\.\d%\)/);
      expect(printed).toMatch(/Runs\s+.*agree \(spread 0\.0 points\)/);
      expect(printed).toMatch(/fewer than 100 gold labels/);
      const baseline = JSON.parse(await readFile(join(dir, '.belay/tune/ticket-triage/baseline.json'), 'utf8')) as Baseline;
      expect(baseline).toMatchObject({ task: 'ticket-triage', createdAt: '2026-11-10T00:00:00.000Z', environment: { runner: 'cli-local' }, stable: true });
      expect(baseline.score.threshold).toBe(0.9);

      // An unreachable target exits with 2.
      expect(await tuneCommand(['--dry-run', '--data', 'validation.jsonl', '--target', '1', '--cloud-accuracy', '0.5', '--quiet', '--out', 'out/score.json'])).toBe(2);
      expect(existsSync(join(dir, 'out/score.json'))).toBe(true);
      stdout.mockClear();
      expect(await tuneCommand(['--help'])).toBe(0);
      expect(String(stdout.mock.calls[0]![0])).toMatch(/Usage: belay tune --dry-run/);
    } finally {
      process.chdir(cwd);
    }
  });
});

/** A Chrome/Chromium binary: BELAY_CHROME, or the Playwright-managed Chromium if present. */
function findChrome(): string | undefined {
  if (process.env['BELAY_CHROME']) return process.env['BELAY_CHROME'];
  const root = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      if (existsSync(join(root, d, rel))) return join(root, d, rel);
    }
  }
  return undefined;
}

/** A stand-in for the Classifier API whose confidence wobbles a little from call to call, like a real model's. */
const STUB_CLASSIFIER = `
(() => {
  const hash = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0) / 2 ** 32; };
  let calls = 0;
  globalThis.Classifier = {
    async availability() { return 'available'; },
    async create(options) {
      const q = options.questions[0];
      const labels = q.options.map((o) => o.label);
      return {
        async classify(input) {
          const truth = labels.find((l) => input.includes('about ' + l + ' '));
          const base = 0.3 + 0.7 * hash('conf:' + input);
          const top = Math.min(0.999, Math.max(0.26, base + (hash('noise:' + (calls++)) - 0.5) * 0.004));
          const label = hash('right:' + input) < base ? truth : labels[(labels.indexOf(truth) + 1) % labels.length];
          const rest = (1 - top) / (labels.length - 1);
          return { [q.id]: { id: q.id, label, confidence: top, probabilities: labels.map((l) => ({ label: l, probability: l === label ? top : rest })) } };
        },
        destroy() {},
      };
    },
  };
})();
`;

const chrome = findChrome();

describe.skipIf(!chrome)('dryRun in a real Chromium', () => {
  let profile: string;
  let backend: LocalBackend;
  beforeAll(async () => {
    profile = await mkdtemp(join(tmpdir(), 'belay-tune-browser-'));
    backend = await browserBackend({ task: 'ticket-triage', schema, local: { runner: 'classifier-api' }, browser: { executablePath: chrome!, proxy: false }, cacheDir: profile, initScript: STUB_CLASSIFIER });
  }, 60_000);
  afterAll(async () => {
    await backend?.close();
    await rm(profile, { recursive: true, force: true });
  });

  it('reports local share at the target accuracy with an interval, and two runs agree within a point', async () => {
    const split = await loadSplit(join(dir, 'validation.jsonl'), schema);
    const baseline = await dryRun({ name: 'ticket-triage', config: { schema }, split, backend, cache: await OutputCache.open(null), target: 0.95, repeat: 2 });
    expect(baseline.environment.runner).toBe('classifier-api');
    expect(baseline.environment.userAgent).toMatch(/Chrome/);
    expect(baseline.localFailures).toBe(0);
    const [a, b] = baseline.runs;
    expect(a!.targetMet).toBe(true);
    expect(a!.localShare).toBeGreaterThan(0.1);
    expect(a!.localShareInterval![1]).toBeGreaterThan(a!.localShareInterval![0]);
    // The runs are not identical: the stub's confidences wobble.
    expect(a!.threshold).not.toBe(b!.threshold);
    expect(baseline.spread).toBeLessThanOrEqual(0.01);
    expect(baseline.stable).toBe(true);
  }, 120_000);
});
