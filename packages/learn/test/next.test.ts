import { describe, expect, it, vi } from 'vitest';
import { task, type BelayResult, type CloudRunner } from '@swissspidy/belay-core';
import {
  applyPlatt,
  fitPlatt,
  learnedClassifier,
  memoryStore,
  nearestSimilarity,
  normalize,
  parseLearnedState,
  persistStorage,
  quantile,
  type LearnedClassifierOptions,
} from '../src/index.js';
import { fakeEmbedder, triageSchema } from './helpers.js';

const TOPICS = ['bug', 'billing', 'feature', 'other'];
const inputs = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => `${TOPICS[(i + offset) % 4]} message ${i + offset}`);
const oracle = () => {
  const run = vi.fn(async (request: { input: string }) => ({ value: request.input.split(' ')[0] }));
  return { id: 'oracle', run } as unknown as CloudRunner & { run: typeof run };
};

async function trained(options: Partial<LearnedClassifierOptions> = {}, n = 120) {
  const embedder = fakeEmbedder(TOPICS);
  const local = learnedClassifier({ embedder, head: 'knn', ...options });
  const cloud = oracle();
  const t = task({ name: 'triage', schema: triageSchema, local, cloud, threshold: 0.9 });
  for (const text of inputs(n)) {
    await t.run(text);
    await local.flush();
  }
  return { t, local, cloud, embedder };
}

describe('helpers', () => {
  it('nearestSimilarity finds the k-th nearest, leaving one out', () => {
    const ex = [Float32Array.of(1, 0), Float32Array.of(0.8, 0.6), Float32Array.of(0, 1)].map((e, label) => ({ embedding: normalize(e), label, weight: 1 }));
    const v = Float32Array.of(1, 0);
    expect(nearestSimilarity(ex, v)).toBeCloseTo(1);
    expect(nearestSimilarity(ex, v, 2)).toBeCloseTo(0.8);
    expect(nearestSimilarity(ex, v, 1, 0)).toBeCloseTo(0.8);
    expect(nearestSimilarity(ex, v, 9)).toBeCloseTo(0);
    expect(nearestSimilarity([], v)).toBe(-Infinity);
  });

  it('quantile interpolates', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([3, 1, 2, 4], 0)).toBe(1);
    expect(quantile([3, 1, 2, 4], 0.5)).toBe(2.5);
    expect(quantile([3, 1, 2, 4], 1)).toBe(4);
  });

  it('fitPlatt honors pair weights', () => {
    // 50 wrong pairs at 0.9 with weight 10 outweigh 100 right ones.
    const pairs = [
      ...Array.from({ length: 100 }, () => ({ score: 0.9, correct: true })),
      ...Array.from({ length: 50 }, () => ({ score: 0.9, correct: false, weight: 10 })),
    ];
    expect(applyPlatt(fitPlatt(pairs), 0.9)).toBeLessThan(0.25);
  });
});

describe('distance gate', () => {
  it('sends inputs unlike anything stored to the cloud, and counts them', async () => {
    const { t, local } = await trained();
    const known = await t.run('billing invoice copy');
    expect(known.source).toBe('local');
    const stats = (await local.stats())!;
    const gatedBefore = stats.gate.gated;
    expect(stats.gate.threshold).not.toBeNull();
    expect(stats.gate.samples).toBeGreaterThanOrEqual(10);
    // An unknown topic lands on its own axis, far from every stored example.
    // (The oracle answers with the first word, which is no label here: the run escalates, then
    // falls back to the local answer, flagged.)
    const strange = await t.run('zzz completely unrelated');
    expect(strange.escalationReason).toBe('low-confidence');
    expect(strange.local!.confidence).toBe(0);
    expect((await local.stats())!.gate.gated).toBe(gatedBefore + 1);
  });

  it('can be fixed or turned off', async () => {
    const off = await trained({ distanceGate: false });
    expect((await off.local.stats())!.gate.threshold).toBeNull();
    const out = await off.local.run('zzz completely unrelated', { task: 'triage', schema: triageSchema });
    expect((out.raw as { gate?: string }).gate).toBeUndefined();
    const fixed = await trained({ distanceGate: 0.99 }, 60);
    expect((await fixed.local.stats())!.gate.threshold).toBe(0.99);
  });

  it('stays off during the cold start', async () => {
    const { local } = await trained({}, 12);
    expect((await local.stats())!.gate.threshold).toBeNull();
  });
});

describe('informativeness', () => {
  it('is low for a clear case and higher for an unclear one', async () => {
    const { local } = await trained();
    const ctx = { task: 'triage', schema: triageSchema };
    const clear = await local.run('bug crash 999', ctx);
    const unclear = await local.run('zzz unknown 999', ctx);
    expect(clear.informativeness).toBeLessThan(0.3);
    expect(unclear.informativeness).toBeGreaterThan(clear.informativeness!);
  });

  it('is passed to informative exploration, which sends weighted labels back', async () => {
    const { local, cloud } = await trained();
    const learn = vi.spyOn(local, 'learn');
    const t = task({ name: 'triage', schema: triageSchema, local, cloud, threshold: 0.9, explore: { rate: 1, strategy: 'informative' } });
    const r = (await t.run('feature dark mode 1')) as BelayResult<string>;
    expect(r.escalationReason).toBe('exploration');
    await local.flush();
    expect(learn.mock.calls.at(-1)![0]).toMatchObject({ reason: 'exploration', explorationWeight: expect.any(Number) });
  });
});

describe('exportState / importState', () => {
  it('moves what a task learned to another classifier, before its first run', async () => {
    const { local } = await trained({}, 60);
    await local.learn!({ input: 'bug flaky login', value: 'other', source: 'feedback' }, { task: 'triage', schema: triageSchema });
    const learned = (await local.stats())!.examples;
    const snapshot = JSON.parse(JSON.stringify(await local.exportState()));
    expect(snapshot).toMatchObject({ kind: 'belay-learn-state', version: 1, task: 'triage', embedder: 'fake-embedder' });
    expect(snapshot.examples.length).toBe(learned);
    expect(JSON.stringify(snapshot)).not.toContain('message');

    const other = learnedClassifier({ embedder: fakeEmbedder(TOPICS), head: 'knn' });
    expect(await other.importState(snapshot)).toEqual({ examples: learned });
    const t = task({ name: 'triage', schema: triageSchema, local: other, cloud: oracle(), threshold: 0.9 });
    expect((await t.run('billing refund 77')).source).toBe('local');
    expect((await other.run('bug flaky login', { task: 'triage', schema: triageSchema })).value).toBe('other');
    expect((await other.stats())!.examples).toBe(learned);
  });

  it('merges by default (a correction wins), or replaces', async () => {
    const store = memoryStore();
    const { local } = await trained({ store }, 40);
    const snapshot = await local.exportState();
    const n = snapshot.examples.length;
    const extra = { ...snapshot, examples: snapshot.examples.slice(0, 5).map((e) => ({ ...e, id: `x${e.id}` })) };
    expect(await local.importState(extra)).toEqual({ examples: n + 5 });
    expect(await local.importState(extra, { replace: true })).toEqual({ examples: 5 });

    await local.importState(snapshot, { replace: true });
    const corrected = { ...snapshot, examples: [{ ...snapshot.examples[0]!, label: 'other', source: 'feedback' as const }] };
    await local.importState(corrected);
    const cloudAgain = { ...snapshot, examples: [{ ...snapshot.examples[0]!, source: 'cloud' as const }] };
    await local.importState(cloudAgain);
    const after = await local.exportState();
    expect(after.examples.find((e) => e.id === snapshot.examples[0]!.id)).toMatchObject({ label: 'other', source: 'feedback' });
  });

  it('rejects snapshots from another embedder and malformed ones', async () => {
    const { local } = await trained({}, 20);
    const snapshot = await local.exportState();
    await expect(local.importState({ ...snapshot, embedder: 'other' })).rejects.toThrow(/embedder/);
    expect(() => parseLearnedState({ ...snapshot, examples: [{ id: 'a' }] })).toThrow(/snapshot/);
    expect(() => parseLearnedState(null)).toThrow(/snapshot/);
  });

  it('fails clearly for a task it has not seen', async () => {
    await expect(learnedClassifier({ embedder: fakeEmbedder(TOPICS) }).exportState()).rejects.toThrow(/has not been used/);
  });
});

describe('persistStorage', () => {
  it('asks for persistent storage and reports usage', async () => {
    const storage = { persisted: vi.fn(async () => false), persist: vi.fn(async () => true), estimate: vi.fn(async () => ({ usage: 10, quota: 100 })) };
    vi.stubGlobal('navigator', { storage });
    try {
      expect(await persistStorage()).toEqual({ persisted: true, usage: 10, quota: 100 });
      expect(storage.persist).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports false without the API', async () => {
    vi.stubGlobal('navigator', {});
    try {
      expect(await persistStorage()).toEqual({ persisted: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('simulateLearning', () => {
  it('streams labeled inputs through a learned classifier and summarizes it', async () => {
    const { simulateLearning } = await import('../src/index.js');
    const stream = inputs(160).map((input) => ({ input, value: input.split(' ')[0] }));
    const progress: number[] = [];
    const result = await simulateLearning({
      name: 'triage',
      schema: triageSchema,
      embedder: fakeEmbedder(TOPICS),
      stream,
      classifier: { head: 'knn' },
      window: 40,
      onProgress: (done) => progress.push(done),
    });
    expect(result.all.runs).toBe(160);
    expect(result.curve).toHaveLength(4);
    expect(result.curve[0]!.localShare).toBeLessThan(result.curve[3]!.localShare);
    expect(result.all.accuracy).toBe(1);
    expect(result.stats.examples).toBe(result.all.cloudCalls);
    expect(progress.at(-1)).toBe(160);
  });

  it('models a fallible teacher and rejects bad streams', async () => {
    const { simulateLearning } = await import('../src/index.js');
    const stream = inputs(80).map((input) => ({ input, value: input.split(' ')[0] }));
    const wrong = await simulateLearning({ name: 't', schema: triageSchema, embedder: fakeEmbedder(TOPICS), stream, teacher: () => 'other', classifier: { head: 'knn' } });
    expect(wrong.all.accuracy).toBeLessThan(0.5);
    await expect(simulateLearning({ name: 't', schema: triageSchema, embedder: fakeEmbedder(TOPICS), stream: [stream[0]!, stream[0]!] })).rejects.toThrow(/duplicate/);
    await expect(simulateLearning({ name: 't', schema: triageSchema, embedder: fakeEmbedder(TOPICS), stream: [{ input: 'x', value: 'nope' }] })).rejects.toThrow(/outside the schema/);
  });
});
