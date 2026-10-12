import { describe, expect, it, vi } from 'vitest';
import { task, type BelayResult, type CloudRunner } from '@swissspidy/belay-core';
import { buildSeed, learnedClassifier, memoryStore, parseSeed, type LearnedClassifierOptions } from '../src/index.js';
import { fakeEmbedder, rng, tick, triageSchema } from './helpers.js';

const TOPICS = ['bug', 'billing', 'feature', 'other'];

/** A cloud that answers with the topic word, i.e. always right. */
function oracle() {
  const run = vi.fn(async (request: { input: string }) => ({ value: request.input.split(' ')[0] }));
  return { id: 'oracle', run } as unknown as CloudRunner & { run: typeof run };
}

function setup(options: Partial<LearnedClassifierOptions> = {}, extra: Record<string, unknown> = {}) {
  const embedder = fakeEmbedder(TOPICS);
  const local = learnedClassifier({ embedder, softmax: { retrainDelayMs: 0 }, ...options });
  const cloud = oracle();
  const t = task({ name: 'triage', schema: triageSchema, local, cloud, threshold: 0.9, ...extra } as Parameters<typeof task>[0]);
  return { t, local, cloud, embedder };
}

/** `n` inputs, round-robin over the topics, each one distinct. */
const inputs = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => `${TOPICS[(i + offset) % 4]} message ${i + offset}`);

async function stream(t: ReturnType<typeof setup>['t'], local: ReturnType<typeof setup>['local'], texts: string[]) {
  const results: BelayResult<string>[] = [];
  for (const text of texts) {
    results.push((await t.run(text)) as BelayResult<string>);
    await local.flush();
  }
  return results;
}

describe('learnedClassifier with task()', () => {
  it('escalates while it has nothing to go on', async () => {
    const { t, cloud } = setup();
    const result = await t.run('bug crash on save');
    expect(result).toMatchObject({ source: 'cloud', value: 'bug', escalationReason: 'local-unavailable' });
    expect(cloud.run).toHaveBeenCalledTimes(1);
  });

  it('learns from the cloud until it answers on its own, and stays right', async () => {
    const { t, local, cloud } = setup();
    const results = await stream(t, local, inputs(200));
    const early = results.slice(0, 40).filter((r) => r.source === 'local').length;
    const late = results.slice(-50);
    expect(early).toBeLessThan(10);
    expect(late.filter((r) => r.source === 'local').length).toBeGreaterThan(40);
    expect(results.every((r, i) => r.value === TOPICS[i % 4])).toBe(true);
    expect(cloud.run.mock.calls.length).toBeLessThan(100);
    const stats = await local.stats();
    expect(stats).toMatchObject({ task: 'triage', ready: true, seedExamples: 0, pending: 0 });
    expect(stats!.examples).toBe(cloud.run.mock.calls.length);
    expect(Object.values(stats!.perLabel).every((n) => n > 3)).toBe(true);
  });

  it('reports 0 confidence during the cold start, then calibrated probabilities', async () => {
    const { t, local } = setup({ minExamples: 10, calibration: { minPairs: 30 } });
    const results = await stream(t, local, inputs(120));
    const confidences = results.map((r) => r.local?.confidence ?? null);
    expect(confidences.slice(1, 10).every((c) => c === 0)).toBe(true);
    const last = results.at(-1)!.local!;
    expect(last.confidence).toBeGreaterThan(0.9);
    expect(last.confidence).toBeLessThan(1);
    expect(last.probabilities!.map((p) => p.label)).toEqual(TOPICS);
  });

  it('stays escalated when the cloud labels are noise (nothing to learn)', async () => {
    const random = rng(3);
    const embedder = fakeEmbedder(TOPICS);
    const local = learnedClassifier({ embedder, head: 'knn' });
    const cloud = { id: 'noise', run: vi.fn(async () => ({ value: TOPICS[Math.floor(random() * 4)] })) };
    const t = task({ name: 'triage', schema: triageSchema, local, cloud, threshold: 0.9 });
    const results = await stream(t, local, inputs(200));
    expect(results.filter((r) => r.source === 'local').length).toBeLessThan(10);
  });

  it('with teacherAccuracy, answers on the device although the cloud is right less often than the threshold', async () => {
    // A cloud that is right 80% of the time, wrong uniformly otherwise: agreeing with it is
    // capped at about 0.8, below the threshold of 0.9.
    const run = async (teacherAccuracy?: number) => {
      const random = rng(9);
      const embedder = fakeEmbedder(TOPICS);
      const local = learnedClassifier({ embedder, head: 'knn', ...(teacherAccuracy ? { teacherAccuracy } : {}) });
      const cloud = {
        id: 'noisy',
        run: async (request: { input: string }) => {
          const topic = request.input.split(' ')[0]!;
          return { value: random() < 0.8 ? topic : TOPICS.filter((t) => t !== topic)[Math.floor(random() * 3)] };
        },
      };
      const t = task({ name: 'triage', schema: triageSchema, local, cloud, threshold: 0.9 });
      const results = await stream(t, local, inputs(300));
      return results.map((r, i) => ({ ...r, truth: TOPICS[i % 4] })).slice(-100).filter((r) => r.source === 'local');
    };
    expect((await run()).length).toBeLessThan(10);
    const kept = await run(0.8);
    expect(kept.length).toBeGreaterThan(50);
    expect(kept.filter((r) => r.value === r.truth).length / kept.length).toBeGreaterThan(0.9);
  });

  it('rejects a teacherAccuracy outside (0, 1]', () => {
    expect(() => learnedClassifier({ embedder: fakeEmbedder(TOPICS), teacherAccuracy: 0 })).toThrow(/teacherAccuracy/);
    expect(() => learnedClassifier({ embedder: fakeEmbedder(TOPICS), teacherAccuracy: 1.2 })).toThrow(/teacherAccuracy/);
  });

  it('explores confident runs and keeps learning from them', async () => {
    const { t, local, cloud } = setup({}, { explore: { rate: 0.2, random: rng(5) } });
    const results = await stream(t, local, inputs(200));
    const explored = results.filter((r) => r.escalationReason === 'exploration');
    expect(explored.length).toBeGreaterThan(10);
    expect(explored.every((r) => r.local !== null && r.source === 'cloud')).toBe(true);
    expect((await local.stats())!.examples).toBe(cloud.run.mock.calls.length);
  });

  it('learns from feedback, which outranks a later cloud answer for the same input', async () => {
    const { t, local } = setup({ head: 'knn' });
    await stream(t, local, inputs(80));
    // The user says this "bug" message is really "other"; the cloud later disagrees.
    await t.feedback('bug flaky login', 'other');
    await local.learn!({ input: 'bug flaky login', value: 'bug', source: 'cloud' }, { task: 'triage', schema: triageSchema });
    const out = await local.run('bug flaky login', { task: 'triage', schema: triageSchema });
    expect(out.value).toBe('other');
  });

  it('switches to the softmax head when it is more often right, in auto mode', async () => {
    const { t, local } = setup({ softmax: { minExamples: 20, retrainDelayMs: 0 } });
    await stream(t, local, inputs(150));
    const stats = (await local.stats())!;
    expect(stats.heads.softmax.trained).toBe(true);
    expect(stats.heads.softmax.pairs).toBeGreaterThan(0);
    expect(['knn', 'softmax']).toContain(stats.head);
    const knnOnly = setup({ head: 'knn' });
    await stream(knnOnly.t, knnOnly.local, inputs(60));
    expect((await knnOnly.local.stats())!.heads.softmax.trained).toBe(false);
  });

  it('keeps what it learned in the store, across instances', async () => {
    const store = memoryStore();
    const first = setup({ store, head: 'knn' });
    await stream(first.t, first.local, inputs(100));
    const learned = (await first.local.stats())!.examples;

    const second = setup({ store, head: 'knn' });
    const result = await second.t.run('billing invoice twice');
    expect(result.source).toBe('local');
    expect((await second.local.stats())!.examples).toBe(learned);
    expect(second.cloud.run).not.toHaveBeenCalled();
  });

  it('scopes stored examples by task, schema and embedder', async () => {
    const store = memoryStore();
    const a = setup({ store });
    await stream(a.t, a.local, inputs(20));
    const other = learnedClassifier({ embedder: fakeEmbedder(TOPICS), store });
    const otherSchema = { type: 'categorical', options: [...TOPICS, 'spam'] } as const;
    const t = task({ name: 'triage', schema: otherSchema, local: other, cloud: oracle(), threshold: 0.9 });
    expect((await t.run('bug x')).escalationReason).toBe('local-unavailable');
  });

  it('reset() forgets the learned examples', async () => {
    const { t, local } = setup();
    await stream(t, local, inputs(60));
    await local.reset();
    expect(await local.stats()).toMatchObject({ examples: 0, heads: { knn: { pairs: 0 } } });
    expect((await t.run('bug again')).escalationReason).toBe('local-unavailable');
  });

  it('queues labels while the embedding model is not loaded, and learns them on prepare()', async () => {
    const embedder = fakeEmbedder(TOPICS, { availability: 'downloadable' });
    const local = learnedClassifier({ embedder });
    const t = task({ name: 'triage', schema: triageSchema, local, cloud: oracle(), threshold: 0.9 });
    for (const text of inputs(12)) await t.run(text);
    await local.flush();
    expect(await local.stats()).toMatchObject({ examples: 0, pending: 12 });
    await t.prepare();
    expect(await local.stats()).toMatchObject({ examples: 12, pending: 0 });
  });

  it('keeps queued labels when embedding them fails, and learns them on the next try', async () => {
    const embedder = fakeEmbedder(TOPICS, { availability: 'downloadable' });
    const local = learnedClassifier({ embedder });
    const t = task({ name: 'triage', schema: triageSchema, local, cloud: oracle(), threshold: 0.9 });
    for (const text of inputs(5)) await t.run(text);
    await local.flush();
    const embed = embedder.embed;
    embedder.embed = async () => Promise.reject(new Error('WebGPU device lost'));
    await expect(t.prepare()).rejects.toThrow('WebGPU device lost');
    expect(await local.stats()).toMatchObject({ examples: 0, pending: 5 });
    embedder.embed = embed;
    await t.prepare();
    expect(await local.stats()).toMatchObject({ examples: 5, pending: 0 });
  });

  it('drops learning that was still embedding when reset() ran', async () => {
    const embedder = fakeEmbedder(TOPICS);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const embed = embedder.embed;
    const local = learnedClassifier({ embedder });
    const ctx = { task: 'triage', schema: triageSchema };
    await local.learn!({ input: 'bug first', value: 'bug', source: 'cloud' }, ctx);
    embedder.embed = async (texts) => {
      await gate;
      return embed(texts);
    };
    const inFlight = local.learn!({ input: 'billing late', value: 'billing', source: 'cloud' }, ctx);
    await tick();
    await local.reset();
    release();
    await inFlight;
    await local.flush();
    expect(await local.stats()).toMatchObject({ examples: 0 });
  });

  it('never embeds while the model is not loaded', async () => {
    const embedder = fakeEmbedder(TOPICS, { availability: 'downloadable' });
    const embed = vi.spyOn(embedder, 'embed');
    const local = learnedClassifier({ embedder });
    const t = task({ name: 'triage', schema: triageSchema, local, cloud: oracle(), threshold: 0.9 });
    expect((await t.run('bug x')).escalationReason).toBe('local-unavailable');
    expect(await t.availability()).toBe('downloadable');
    expect(embed).not.toHaveBeenCalled();
  });

  it('flush() waits for learning that is still embedding', async () => {
    const embedder = fakeEmbedder(TOPICS);
    const fast = embedder.embed;
    embedder.embed = async (texts) => {
      await tick(5);
      return fast(texts);
    };
    const local = learnedClassifier({ embedder });
    const t = task({ name: 'triage', schema: triageSchema, local, cloud: oracle(), threshold: 0.9 });
    await t.run('bug slow');
    await local.flush();
    expect((await local.stats())!.examples).toBe(1);
  });

  it('embeds an escalated input once, for the prediction and the example', async () => {
    const { t, local, embedder } = setup();
    await stream(t, local, inputs(30));
    expect(embedder.calls).toBe(30);
  });

  it('starts from a seed, calibrated from its leave-one-out pairs', async () => {
    const embedder = fakeEmbedder(TOPICS);
    const seed = await buildSeed({
      task: 'triage',
      schema: triageSchema,
      embedder,
      examples: inputs(60, 1000).map((input) => ({ input, value: input.split(' ')[0] })),
      createdAt: '2026-10-01T00:00:00Z',
    });
    expect(seed).toMatchObject({ version: 1, task: 'triage', embedder: 'fake-embedder', dimensions: 16, createdAt: '2026-10-01T00:00:00.000Z' });
    expect(seed.examples).toHaveLength(60);
    expect(seed.pairs!.knn).toHaveLength(60);
    expect(JSON.stringify(seed)).not.toContain('message');

    const local = learnedClassifier({ embedder, seed });
    const cloud = oracle();
    const t = task({ name: 'triage', schema: triageSchema, local, cloud, threshold: 0.9 });
    const result = await t.run('feature dark mode please');
    expect(result).toMatchObject({ source: 'local', value: 'feature' });
    expect(await local.stats()).toMatchObject({ examples: 60, seedExamples: 60 });

    const exported = await local.exportSeed();
    expect(exported.examples).toHaveLength(60);
    await t.run('bug the app crashes');
    await local.flush();
    await local.reset();
    expect(await local.stats()).toMatchObject({ examples: 60, ready: true, heads: { knn: { pairs: 60 } } });
    expect((await t.run('billing refund please')).source).toBe('local');
  });

  it('rejects malformed seed files', () => {
    const good = { version: 1, task: 't', schemaFingerprint: 'abc', embedder: 'e', dimensions: 2, createdAt: '', examples: [{ label: 'bug', embedding: 'fwA=' }] };
    expect(parseSeed(good)).toBe(good);
    for (const bad of [
      null,
      { ...good, version: 2 },
      { ...good, schemaFingerprint: undefined },
      { ...good, examples: [{ label: 'bug', embedding: '' }] },
      { ...good, examples: [{ label: 'bug', embedding: [1, 2] }] },
      { ...good, examples: [null] },
    ]) {
      expect(() => parseSeed(bad)).toThrow(/not a Belay seed file/);
    }
  });

  it('rejects a seed made with another embedder or for another schema', async () => {
    const embedder = fakeEmbedder(TOPICS);
    const seed = await buildSeed({ task: 'triage', schema: triageSchema, embedder, examples: [{ input: 'bug a', value: 'bug' }] });
    for (const bad of [{ ...seed, embedder: 'other' }, { ...seed, schemaFingerprint: 'deadbeef' }]) {
      const t = task({ name: 'triage', schema: triageSchema, local: learnedClassifier({ embedder, seed: bad }), cloud: oracle(), threshold: 0.9 });
      const events: unknown[] = [];
      const t2 = task({ name: 'triage', schema: triageSchema, local: learnedClassifier({ embedder, seed: bad }), cloud: oracle(), threshold: 0.9, onEvent: (e) => events.push(e) });
      expect((await t.run('bug x')).escalationReason).toBe('local-error');
      await t2.run('bug x');
      expect(events.some((e) => (e as { type: string; message?: string }).type === 'error' && /seed file/.test((e as { message: string }).message))).toBe(true);
    }
  });

  it('returns booleans for binary tasks', async () => {
    const schema = { type: 'binary', prompt: 'Is it a bug?' } as const;
    const embedder = fakeEmbedder(['yes', 'no']);
    const local = learnedClassifier({ embedder, head: 'knn' });
    const cloud = { id: 'c', run: vi.fn(async (r: { input: string }) => ({ value: r.input.startsWith('yes') })) };
    const t = task({ name: 'is-bug', schema, local, cloud, threshold: 0.9 });
    let last: BelayResult<boolean> | undefined;
    for (let i = 0; i < 80; i++) {
      last = await t.run(`${i % 2 ? 'yes' : 'no'} ${i}`);
      await local.flush();
    }
    expect(last!.value).toBe(true);
    expect(last!.source).toBe('local');
    expect(typeof last!.local!.value).toBe('boolean');
  });

  it('ignores cloud answers below minCloudConfidence', async () => {
    const embedder = fakeEmbedder(TOPICS);
    const local = learnedClassifier({ embedder, minCloudConfidence: 0.8 });
    const ctx = { task: 't', schema: triageSchema };
    await local.learn!({ input: 'bug a', value: 'bug', source: 'cloud', cloudConfidence: 0.5 }, ctx);
    await local.learn!({ input: 'bug b', value: 'bug', source: 'cloud', cloudConfidence: 0.9 }, ctx);
    await local.learn!({ input: 'bug c', value: 'bug', source: 'cloud' }, ctx);
    expect((await local.stats())!.examples).toBe(2);
  });

  it('evicts the oldest cloud examples beyond maxExamples, never feedback', async () => {
    const embedder = fakeEmbedder(TOPICS);
    const local = learnedClassifier({ embedder, maxExamples: 5, head: 'knn' });
    const ctx = { task: 't', schema: triageSchema };
    await local.learn!({ input: 'bug keep', value: 'bug', source: 'feedback' }, ctx);
    for (const input of inputs(10)) await local.learn!({ input, value: input.split(' ')[0]!, source: 'cloud' }, ctx);
    const stats = (await local.stats())!;
    expect(stats.examples).toBe(5);
    expect(stats.perLabel.bug).toBeGreaterThanOrEqual(1);
  });

  it('rejects structured tasks', async () => {
    const local = learnedClassifier({ embedder: fakeEmbedder(TOPICS) });
    const schema = { type: 'structured', jsonSchema: {}, validate: (_: unknown): _ is unknown => true } as const;
    await expect(local.availability({ task: 't', schema: schema as never })).rejects.toThrow(/binary, categorical and ordinal/);
  });
});
