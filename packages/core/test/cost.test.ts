import { describe, expect, it, vi } from 'vitest';
import { cloudAdapter, costOf, fetchAdapter, savingsMeter, task, type BelayEvent, type RunEvent } from '../src/index.js';
import { mockLocal, triageSchema } from './helpers.js';

const prices = {
  'model-a': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'model-b': { input: 1, output: 5 },
};

describe('costOf', () => {
  it('prices tokens per million, by the model that served them', () => {
    expect(costOf({ model: 'model-a', inputTokens: 1000, outputTokens: 100 }, prices)).toBeCloseTo(0.006);
    expect(costOf({ model: 'model-b', inputTokens: 1000, outputTokens: 100 }, prices)).toBeCloseTo(0.0015);
    // A fallback: each attempt at its own model's rates.
    expect(
      costOf([{ model: 'model-a', inputTokens: 1000, outputTokens: 0 }, { model: 'model-b', inputTokens: 1000, outputTokens: 100 }], prices),
    ).toBeCloseTo(0.0055);
  });

  it('prices cache reads and writes, defaulting to the input price', () => {
    const usage = { model: 'model-a', inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1e6, cacheWriteInputTokens: 1e6 };
    expect(costOf(usage, prices)).toBeCloseTo(5.2);
    expect(costOf({ ...usage, model: 'model-b' }, prices)).toBeCloseTo(2);
  });

  it('accepts one price for every model', () => {
    expect(costOf({ inputTokens: 2e6, outputTokens: 0 }, { input: 0.042, output: 0 })).toBeCloseTo(0.084);
  });

  it('refuses to guess a missing price', () => {
    expect(() => costOf({ model: 'model-c', inputTokens: 1, outputTokens: 1 }, prices)).toThrow(/no price for model "model-c"/);
    expect(() => costOf({ inputTokens: 1, outputTokens: 1 }, prices)).toThrow(/names no model/);
  });
});

describe('usage reporting', () => {
  it('cloudAdapter passes reported usage through', async () => {
    const runner = cloudAdapter(async (_request, { reportUsage }) => {
      reportUsage({ model: 'model-a', inputTokens: 10, outputTokens: 2 });
      return { value: 'bug' };
    });
    const output = await runner.run({ task: 't', schema: triageSchema, jsonSchema: {}, instruction: '', input: 'x' }, {});
    expect(output).toEqual({ value: { value: 'bug' }, usage: { model: 'model-a', inputTokens: 10, outputTokens: 2 } });
    const silent = cloudAdapter(async () => 'bug');
    expect(await silent.run({ task: 't', schema: triageSchema, jsonSchema: {}, instruction: '', input: 'x' }, {})).toEqual({ value: 'bug' });
  });

  it('fetchAdapter extracts usage from the response', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ value: 'bug', usage: { in: 5, out: 1 } })));
    const runner = fetchAdapter({
      url: 'https://example.test/belay',
      fetch,
      select: (json) => (json as { value: string }).value,
      usage: (json) => ({ model: 'model-b', inputTokens: (json as any).usage.in, outputTokens: (json as any).usage.out }),
    });
    const output = await runner.run({ task: 't', schema: triageSchema, jsonSchema: {}, instruction: '', input: 'x' }, {});
    expect(output).toEqual({ value: 'bug', usage: { model: 'model-b', inputTokens: 5, outputTokens: 1 } });
  });

  it('run events carry the cloud usage', async () => {
    const events: BelayEvent[] = [];
    const cloud = { id: 'c', run: async () => ({ value: 'bug', usage: { model: 'model-a', inputTokens: 7, outputTokens: 1 } }) };
    const t = task({ name: 'x', schema: triageSchema, local: mockLocal({ value: 'billing', confidence: 0.2 }), cloud, threshold: 0.8, onEvent: (e) => events.push(e) });
    await t.run('hello');
    expect((events[0] as RunEvent).cloudUsage).toEqual([{ model: 'model-a', inputTokens: 7, outputTokens: 1 }]);
  });
});

describe('savingsMeter', () => {
  const run = (over: Partial<RunEvent>): RunEvent => ({
    type: 'run',
    task: 'triage',
    timestamp: 0,
    source: 'local',
    confidence: 0.9,
    localConfidence: 0.9,
    threshold: 0.8,
    thresholdSource: 'calibration',
    calibratedAt: null,
    escalationReason: null,
    escalationBlocked: null,
    latencyMs: 1,
    localLatencyMs: 1,
    cloudLatencyMs: null,
    localRunner: 'l',
    cloudRunner: 'c',
    ...over,
  });
  const cloudRun = (usage?: RunEvent['cloudUsage']) =>
    run({ source: 'cloud', escalationReason: 'low-confidence', ...(usage ? { cloudUsage: usage } : {}) });

  it('values avoided calls at the measured cost per call', () => {
    const meter = savingsMeter({ prices, currency: 'USD' });
    for (let i = 0; i < 3; i++) meter.onEvent(run({}));
    meter.onEvent(cloudRun([{ model: 'model-a', inputTokens: 1000, outputTokens: 100 }])); // 0.006
    meter.onEvent(cloudRun([{ model: 'model-a', inputTokens: 500, outputTokens: 50 }])); // 0.003
    meter.onEvent(run({ escalationReason: 'low-confidence', escalationBlocked: 'consent-denied' }));
    meter.onEvent({ type: 'error', task: 'triage', timestamp: 0, stage: 'cloud', message: 'x' });
    const s = meter.summary();
    expect(s).toMatchObject({ currency: 'USD', runs: 6, local: 3, cloud: 2, blocked: 1, measuredCalls: 2 });
    expect(s.cloudSpend).toBeCloseTo(0.009);
    expect(s.costPerCloudRun).toBeCloseTo(0.0045);
    expect(s.saved).toBeCloseTo(0.0135);
    expect(s.savedShare).toBeCloseTo(0.6);
  });

  it('falls back to cloudPerRun, and filters by task', () => {
    const meter = savingsMeter({ cloudPerRun: 0.002 });
    meter.onEvent(run({}));
    meter.onEvent(cloudRun());
    meter.onEvent(run({ task: 'other' }));
    expect(meter.summary('triage')).toMatchObject({ runs: 2, local: 1, cloud: 1, cloudSpend: 0.002, saved: 0.002, savedShare: 0.5, measuredCalls: 0 });
    expect(meter.summary().local).toBe(2);
    expect(meter.summary('none').runs).toBe(0);
    meter.reset();
    expect(meter.summary().runs).toBe(0);
  });

  it('reports no money without prices or a per-run cost', () => {
    const meter = savingsMeter();
    meter.onEvent(run({}));
    expect(meter.summary()).toMatchObject({ local: 1, cloudSpend: null, saved: null, savedShare: null });
  });
});
