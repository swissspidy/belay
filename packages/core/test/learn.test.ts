import { describe, expect, it, vi } from 'vitest';
import { BelayError, costAwareThreshold, savingsMeter, task, type BelayEvent, type CalibrationFile, type LearnExample, type RunEvent } from '../src/index.js';
import { mockCloud, mockLocal, rng as rngFor, triageSchema } from './helpers.js';

function learner(confidence: number) {
  const runner = mockLocal({ value: 'bug', confidence });
  const learn = vi.fn(async (_example: LearnExample, _ctx: unknown) => {});
  return Object.assign(runner, { learn });
}

describe('learn: the local runner learns from cloud answers', () => {
  it('passes the cloud answer, the local attempt and the reason, with the unredacted input', async () => {
    const local = learner(0.4);
    const cloud = mockCloud('billing');
    const t = task({
      name: 'triage',
      schema: triageSchema,
      context: 'SaaS support',
      local,
      cloud,
      threshold: 0.8,
      privacy: { redact: (s) => s.replace(/\S+@\S+/g, '[email]') },
    });
    await t.run('charged twice, me@example.com');
    expect(cloud.run.mock.calls[0]![0].input).toBe('charged twice, [email]');
    expect(local.learn).toHaveBeenCalledTimes(1);
    expect(local.learn.mock.calls[0]![0]).toEqual({
      input: 'charged twice, me@example.com',
      value: 'billing',
      source: 'cloud',
      reason: 'low-confidence',
      local: { value: 'bug', confidence: 0.4 },
    });
    expect(local.learn.mock.calls[0]![1]).toEqual({ task: 'triage', schema: triageSchema, context: 'SaaS support' });
  });

  it('also learns when the local runner was unavailable, without a local attempt', async () => {
    const local = Object.assign(mockLocal({ value: 'bug', confidence: 1 }, 'downloadable'), { learn: vi.fn() });
    const t = task({ name: 'triage', schema: triageSchema, local, cloud: mockCloud('billing'), threshold: 0.8 });
    await t.run('x');
    expect(local.learn.mock.calls[0]![0]).toEqual({ input: 'x', value: 'billing', source: 'cloud', reason: 'local-unavailable' });
  });

  it('passes the cloud confidence when the adapter reports one', async () => {
    const local = learner(0.1);
    const cloud = { id: 'c', run: vi.fn(async () => ({ value: 'feature', confidence: 0.7 })) };
    await task({ name: 't', schema: triageSchema, local, cloud, threshold: 0.8 }).run('x');
    expect(local.learn.mock.calls[0]![0]).toMatchObject({ value: 'feature', cloudConfidence: 0.7 });
  });

  it('does not learn from local answers, invalid cloud output or blocked escalations', async () => {
    const confident = learner(0.9);
    await task({ name: 't', schema: triageSchema, local: confident, cloud: mockCloud(), threshold: 0.8 }).run('x');
    expect(confident.learn).not.toHaveBeenCalled();

    const invalid = learner(0.1);
    await task({ name: 't', schema: triageSchema, local: invalid, cloud: mockCloud('nope'), threshold: 0.8 }).run('x');
    expect(invalid.learn).not.toHaveBeenCalled();

    const blocked = learner(0.1);
    await task({ name: 't', schema: triageSchema, local: blocked, cloud: mockCloud(), threshold: 0.8, privacy: { escalation: 'never' } }).run('x');
    expect(blocked.learn).not.toHaveBeenCalled();
  });

  it('never waits for learning, and reports its failures as error events', async () => {
    const events: BelayEvent[] = [];
    const local = Object.assign(mockLocal({ value: 'bug', confidence: 0.1 }), {
      learn: vi.fn(() => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('disk full')), 10))),
    });
    const t = task({ name: 't', schema: triageSchema, local, cloud: mockCloud(), threshold: 0.8, onEvent: (e) => events.push(e) });
    const result = await t.run('x');
    expect(result.source).toBe('cloud');
    expect(events.map((e) => e.type)).toEqual(['run']);
    await new Promise((r) => setTimeout(r, 20));
    expect(events.at(-1)).toMatchObject({ type: 'error', stage: 'learn', message: 'disk full' });

    const throwing = Object.assign(mockLocal({ value: 'bug', confidence: 0.1 }), {
      learn: vi.fn(() => {
        throw new Error('sync');
      }),
    });
    const events2: BelayEvent[] = [];
    await task({ name: 't', schema: triageSchema, local: throwing, cloud: mockCloud(), threshold: 0.8, onEvent: (e) => events2.push(e) }).run('x');
    expect(events2.find((e) => e.type === 'error')).toMatchObject({ stage: 'learn', message: 'sync' });
  });
});

describe('explore: a share of confident runs goes to the cloud', () => {
  const explored = (random: () => number, extra: Record<string, unknown> = {}) => {
    const local = learner(0.95);
    const cloud = mockCloud('billing');
    const events: RunEvent[] = [];
    const t = task({
      name: 't',
      schema: triageSchema,
      local,
      cloud,
      threshold: 0.8,
      explore: { rate: 0.1, random },
      onEvent: (e) => e.type === 'run' && events.push(e),
      ...extra,
    } as Parameters<typeof task>[0]);
    return { t, local, cloud, events };
  };

  it('escalates with reason "exploration" when the draw is below the rate', async () => {
    const { t, local, cloud, events } = explored(() => 0.05);
    const result = await t.run('x');
    expect(result).toMatchObject({ source: 'cloud', value: 'billing', escalationReason: 'exploration', local: { value: 'bug', confidence: 0.95 } });
    expect(cloud.run).toHaveBeenCalledTimes(1);
    expect(local.learn.mock.calls[0]![0]).toMatchObject({ reason: 'exploration', local: { value: 'bug', confidence: 0.95 } });
    expect(events[0]).toMatchObject({ label: 'billing', localLabel: 'bug', escalationReason: 'exploration' });
  });

  it('keeps the run local when the draw is at or above the rate', async () => {
    const { t, cloud } = explored(() => 0.1);
    expect((await t.run('x')).source).toBe('local');
    expect(cloud.run).not.toHaveBeenCalled();
  });

  it('draws only for confident runs', async () => {
    const random = vi.fn(() => 0);
    const local = learner(0.5);
    const t = task({ name: 't', schema: triageSchema, local, cloud: mockCloud(), threshold: 0.8, explore: { rate: 1, random } });
    expect((await t.run('x')).escalationReason).toBe('low-confidence');
    expect(random).not.toHaveBeenCalled();
  });

  it('accepts a bare rate', async () => {
    const t = task({ name: 't', schema: triageSchema, local: learner(0.95), cloud: mockCloud(), threshold: 0.8, explore: 1 });
    expect((await t.run('x')).escalationReason).toBe('exploration');
  });

  it('never explores under the consent or never policies, or without a cloud runner', async () => {
    const consent = vi.fn(() => true);
    for (const privacy of [{ escalation: 'consent' as const, consent }, { escalation: 'never' as const }]) {
      const { t, cloud } = explored(() => 0, { privacy });
      expect((await t.run('x')).source).toBe('local');
      expect(cloud.run).not.toHaveBeenCalled();
    }
    expect(consent).not.toHaveBeenCalled();
    const { t } = explored(() => 0);
    expect((await t.run('x', { escalation: 'never' })).source).toBe('local');
    const alone = task({ name: 't', schema: triageSchema, local: learner(0.95), threshold: 0.8, explore: 1 });
    expect((await alone.run('x')).source).toBe('local');
  });

  it('returns the local answer when the cloud fails on an explored run', async () => {
    const local = learner(0.95);
    const cloud = { id: 'c', run: vi.fn(async () => Promise.reject(new Error('down'))) };
    const t = task({ name: 't', schema: triageSchema, local, cloud, threshold: 0.8, explore: 1 });
    expect(await t.run('x')).toMatchObject({ source: 'local', value: 'bug', escalationReason: 'exploration', escalationBlocked: 'cloud-error' });
  });

  it('counts explored runs as cloud spend in savingsMeter', async () => {
    const meter = savingsMeter({ cloudPerRun: 0.01 });
    let draw = 0;
    const t = task({
      name: 't',
      schema: triageSchema,
      local: learner(0.95),
      cloud: mockCloud(),
      threshold: 0.8,
      explore: { rate: 0.5, random: () => [0.1, 0.9, 0.9, 0.9][draw++ % 4]! },
      onEvent: meter.onEvent,
    });
    for (let i = 0; i < 4; i++) await t.run('x');
    expect(meter.summary()).toMatchObject({ runs: 4, local: 3, cloud: 1, explored: 1, cloudSpend: 0.01, saved: 0.03 });
  });

  it('validates the rate', () => {
    for (const explore of [-0.1, 1.5, Number.NaN, { rate: 2 }]) {
      expect(() => task({ name: 't', schema: triageSchema, local: learner(1), threshold: 0.8, explore })).toThrow(/explore rate/);
    }
  });
});

describe('feedback', () => {
  it('teaches the local runner a validated value', async () => {
    const local = learner(0.9);
    const t = task({ name: 'triage', schema: triageSchema, context: 'SaaS', local, threshold: 0.8 });
    expect(await t.feedback('the app crashes', 'BUG' as 'bug', { context: 'web' })).toBe(true);
    expect(local.learn).toHaveBeenCalledWith(
      { input: 'the app crashes', value: 'bug', source: 'feedback' },
      { task: 'triage', schema: triageSchema, context: 'SaaS\nweb' },
    );
  });

  it('rejects values outside the schema', async () => {
    const t = task({ name: 't', schema: triageSchema, local: learner(0.9), threshold: 0.8 });
    const err = await t.feedback('x', 'refund' as 'bug').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BelayError);
    expect((err as BelayError).code).toBe('invalid-feedback');
  });

  it('resolves false when the runner cannot learn', async () => {
    const t = task({ name: 't', schema: triageSchema, local: mockLocal({ value: 'bug', confidence: 1 }), threshold: 0.8 });
    expect(await t.feedback('x', 'bug')).toBe(false);
  });

  it('waits for the runner and propagates its errors', async () => {
    const local = Object.assign(mockLocal({ value: 'bug', confidence: 1 }), { learn: vi.fn(async () => Promise.reject(new Error('nope'))) });
    const t = task({ name: 't', schema: triageSchema, local, threshold: 0.8 });
    await expect(t.feedback('x', 'bug')).rejects.toThrow('nope');
  });
});

describe('explore: informative strategy', () => {
  const runner = (outputs: { confidence: number; informativeness?: number }[]) => {
    let i = 0;
    const local = mockLocal(() => ({ value: 'bug', ...outputs[i++ % outputs.length]! }));
    return Object.assign(local, { learn: vi.fn(async (_e: LearnExample) => {}) });
  };

  it('explores informative runs more often, at about the rate on average', async () => {
    const random = rngFor(1);
    // Half the confident runs are informative (0.8), half not (0.05).
    const local = runner([{ confidence: 0.95, informativeness: 0.8 }, { confidence: 0.95, informativeness: 0.05 }]);
    const events: RunEvent[] = [];
    const t = task({
      name: 't',
      schema: triageSchema,
      local,
      cloud: mockCloud('bug'),
      threshold: 0.8,
      explore: { rate: 0.1, strategy: 'informative', random },
      onEvent: (e) => e.type === 'run' && events.push(e),
    });
    for (let i = 0; i < 4000; i++) await t.run(`x${i}`);
    const explored = events.map((e, i) => ({ e, informative: i % 2 === 0 })).filter(({ e }) => e.escalationReason === 'exploration');
    const share = explored.length / events.length;
    const informative = explored.filter((x) => x.informative).length;
    expect(share).toBeGreaterThan(0.07);
    expect(share).toBeLessThan(0.13);
    expect(informative / explored.length).toBeGreaterThan(0.8);
    // Inverse-probability weights: rare picks weigh more, and the weighted count estimates uniform.
    const weights = explored.map(({ e }) => e.explorationWeight!);
    expect(Math.min(...weights)).toBeLessThan(1);
    expect(Math.max(...weights)).toBeGreaterThan(1);
    expect(local.learn.mock.calls.every(([e]) => typeof e.explorationWeight === 'number')).toBe(true);
  });

  it('never goes below the floor, and defaults to 1 − confidence without informativeness', async () => {
    const random = vi.fn(() => 0.0249);
    const t = task({
      name: 't',
      schema: triageSchema,
      local: runner([{ confidence: 0.99 }]),
      cloud: mockCloud('bug'),
      threshold: 0.8,
      explore: { rate: 0.1, strategy: 'informative', floor: 0.25, random },
    });
    // Constant informativeness: its mean equals it, so the probability is the rate.
    expect((await t.run('x')).escalationReason).toBe('exploration');
    random.mockReturnValue(0.11);
    expect((await t.run('y')).escalationReason).toBe(null);
  });

  it('reports a weight of 1 under uniform exploration', async () => {
    const events: RunEvent[] = [];
    const t = task({ name: 't', schema: triageSchema, local: runner([{ confidence: 0.95 }]), cloud: mockCloud('bug'), threshold: 0.8, explore: { rate: 1 }, onEvent: (e) => e.type === 'run' && events.push(e) });
    await t.run('x');
    expect(events[0]).toMatchObject({ escalationReason: 'exploration', explorationWeight: 1 });
  });

  it('validates the strategy and floor', () => {
    const local = runner([{ confidence: 1 }]);
    expect(() => task({ name: 't', schema: triageSchema, local, threshold: 0.8, explore: { rate: 0.1, strategy: 'margin' as 'uniform' } })).toThrow(/strategy/);
    expect(() => task({ name: 't', schema: triageSchema, local, threshold: 0.8, explore: { rate: 0.1, floor: 2 } })).toThrow(/floor/);
  });
});

describe('costAwareThreshold', () => {
  it('is the cloud accuracy minus the call cost per error cost (Chow)', () => {
    expect(costAwareThreshold({ errorCost: 1, cloudCost: 0.01, cloudAccuracy: 0.95 })).toBeCloseTo(0.94, 10);
    expect(costAwareThreshold({ errorCost: 0.002, cloudCost: 0.01, cloudAccuracy: 0.95 })).toBe(0);
    expect(costAwareThreshold({ errorCost: 100, cloudCost: 0 })).toBe(1);
  });

  it('reads the cloud cost and accuracy from a calibration file', () => {
    const calibration = { expected: { cloudAccuracy: 0.9 }, cost: { cloudPerRun: 0.002 } } as unknown as CalibrationFile;
    expect(costAwareThreshold({ errorCost: 0.1, calibration })).toBeCloseTo(0.88, 10);
  });

  it('validates its inputs', () => {
    expect(() => costAwareThreshold({ errorCost: 0, cloudCost: 1 })).toThrow(/errorCost/);
    expect(() => costAwareThreshold({ errorCost: 1 })).toThrow(/cloudCost/);
    expect(() => costAwareThreshold({ errorCost: 1, cloudCost: 1, cloudAccuracy: 2 })).toThrow(/cloudAccuracy/);
    expect(() => costAwareThreshold({ errorCost: Infinity, cloudCost: Infinity })).toThrow(/errorCost/);
    expect(() => costAwareThreshold({ errorCost: 1, cloudCost: Infinity })).toThrow(/cloudCost/);
  });
});
