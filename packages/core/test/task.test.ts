import { describe, expect, it, vi } from 'vitest';
import {
  BelayError,
  LocalUnavailableError,
  schemaFingerprint,
  task,
  type BelayEvent,
  type CalibrationFile,
  type RunEvent,
} from '../src/index.js';
import { mockCloud, mockLocal, rng, triageSchema } from './helpers.js';

function triage(confidence: number, extra: Record<string, unknown> = {}) {
  const local = mockLocal({ value: 'bug', confidence });
  const cloud = mockCloud('billing');
  const t = task({ name: 'ticket-triage', schema: triageSchema, local, cloud, threshold: 0.8, ...extra } as Parameters<typeof task>[0]);
  return { t, local, cloud };
}

describe('cascade: escalates exactly when confidence < threshold', () => {
  it.each([
    [0, 'cloud'],
    [0.5, 'cloud'],
    [0.79, 'cloud'],
    [0.7999999, 'cloud'],
    [0.8, 'local'],
    [0.8000001, 'local'],
    [0.95, 'local'],
    [1, 'local'],
  ] as const)('confidence %f at threshold 0.8 -> %s', async (confidence, source) => {
    const { t, cloud } = triage(confidence);
    const result = await t.run('I was charged twice');
    expect(result.source).toBe(source);
    expect(cloud.run).toHaveBeenCalledTimes(source === 'cloud' ? 1 : 0);
    expect(result.escalationReason).toBe(source === 'cloud' ? 'low-confidence' : null);
    expect(result.value).toBe(source === 'cloud' ? 'billing' : 'bug');
  });

  it('holds for 1,000 random (confidence, threshold) pairs', async () => {
    const random = rng(42);
    for (let i = 0; i < 1000; i++) {
      // Quantize some samples so exact ties are exercised too.
      const threshold = i % 3 === 0 ? Math.round(random() * 10) / 10 : random();
      const confidence = i % 3 === 0 ? Math.round(random() * 10) / 10 : random();
      const { t, cloud } = triage(confidence, { threshold });
      const result = await t.run('x');
      const shouldEscalate = confidence < threshold;
      expect(result.source, `c=${confidence} t=${threshold}`).toBe(shouldEscalate ? 'cloud' : 'local');
      expect(cloud.run).toHaveBeenCalledTimes(shouldEscalate ? 1 : 0);
    }
  });
});

describe('result shape', () => {
  it('local result', async () => {
    const { t } = triage(0.9);
    const result = await t.run('app crashes on save');
    expect(result).toMatchObject({
      value: 'bug',
      confidence: 0.9,
      source: 'local',
      escalationReason: null,
      escalationBlocked: null,
      threshold: 0.8,
      local: { value: 'bug', confidence: 0.9 },
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.local!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('cloud result keeps the local attempt and reports null confidence', async () => {
    const { t } = triage(0.3);
    const result = await t.run('hmm');
    expect(result).toMatchObject({
      value: 'billing',
      confidence: null,
      source: 'cloud',
      escalationReason: 'low-confidence',
      local: { value: 'bug', confidence: 0.3 },
    });
  });

  it('passes a cloud-reported confidence through', async () => {
    const local = mockLocal({ value: 'bug', confidence: 0.1 });
    const cloud = { id: 'c', run: vi.fn(async () => ({ value: 'feature', confidence: 0.97 })) };
    const t = task({ name: 'x', schema: triageSchema, local, cloud, threshold: 0.5 });
    expect(await t.run('a')).toMatchObject({ value: 'feature', confidence: 0.97, source: 'cloud' });
  });

  it('normalizes cloud output (wrapper, case, JSON string)', async () => {
    for (const raw of [{ value: 'Billing' }, ' billing', '{"value":"billing"}']) {
      const t = task({ name: 'x', schema: triageSchema, local: mockLocal({ value: 'bug', confidence: 0 }), cloud: mockCloud(raw), threshold: 0.5 });
      expect((await t.run('a')).value).toBe('billing');
    }
  });

  it('sends the cloud runner the instruction, JSON Schema, context and local guess', async () => {
    const { t, cloud } = triage(0.2, { context: 'SaaS support' });
    await t.run('charged twice', { context: 'Customer is on the Pro plan' });
    const [request] = cloud.run.mock.calls[0]! as unknown as [Record<string, unknown>];
    expect(request).toMatchObject({
      task: 'ticket-triage',
      input: 'charged twice',
      context: 'SaaS support\nCustomer is on the Pro plan',
      local: { value: 'bug', confidence: 0.2 },
      jsonSchema: { properties: { value: { enum: ['bug', 'billing', 'feature', 'other'] } } },
    });
    expect(request['instruction']).toContain('- billing');
  });
});

describe('escalation reasons', () => {
  it('local-unavailable: never runs (or downloads) the local model', async () => {
    for (const state of ['downloadable', 'downloading', 'unavailable'] as const) {
      const local = mockLocal({ value: 'bug', confidence: 1 }, state);
      const cloud = mockCloud();
      const t = task({ name: 'x', schema: triageSchema, local, cloud, threshold: 0.8 });
      const result = await t.run('a');
      expect(local.run).not.toHaveBeenCalled();
      expect(result).toMatchObject({ source: 'cloud', escalationReason: 'local-unavailable', local: null });
    }
  });

  it('local-unavailable when the runner throws LocalUnavailableError', async () => {
    const local = mockLocal(() => {
      throw new LocalUnavailableError('gone');
    });
    const t = task({ name: 'x', schema: triageSchema, local, cloud: mockCloud(), threshold: 0.8 });
    expect((await t.run('a')).escalationReason).toBe('local-unavailable');
  });

  it('local-error when the runner throws', async () => {
    const events: BelayEvent[] = [];
    const local = mockLocal(() => {
      throw new Error('boom');
    });
    const t = task({ name: 'x', schema: triageSchema, local, cloud: mockCloud(), threshold: 0.8, onEvent: (e) => events.push(e) });
    expect((await t.run('a')).escalationReason).toBe('local-error');
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', stage: 'local', message: 'boom' }));
  });

  it('invalid-output when the local value is not in the schema', async () => {
    const t = task({ name: 'x', schema: triageSchema, local: mockLocal({ value: 'spam', confidence: 0.99 }), cloud: mockCloud(), threshold: 0.8 });
    expect(await t.run('a')).toMatchObject({ source: 'cloud', escalationReason: 'invalid-output', local: null });
  });

  it('local-timeout aborts the local runner and escalates', async () => {
    let localSignal: AbortSignal | undefined;
    const local = mockLocal({ value: 'bug', confidence: 1 });
    local.run.mockImplementation((_input, ctx) => {
      localSignal = ctx?.signal;
      return new Promise(() => {});
    });
    const t = task({ name: 'x', schema: triageSchema, local, cloud: mockCloud(), threshold: 0.8, localTimeoutMs: 5 });
    expect(await t.run('a')).toMatchObject({ source: 'cloud', escalationReason: 'local-timeout' });
    expect(localSignal?.aborted).toBe(true);
  });
});

describe('privacy', () => {
  it('escalation "never" returns the low-confidence local result', async () => {
    const { t, cloud } = triage(0.3, { privacy: { escalation: 'never' } });
    const result = await t.run('a');
    expect(cloud.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ value: 'bug', source: 'local', confidence: 0.3, escalationReason: 'low-confidence', escalationBlocked: 'policy' });
  });

  it('escalation "never" without a local result throws no-result', async () => {
    const t = task({ name: 'x', schema: triageSchema, local: mockLocal({ value: 'bug', confidence: 1 }, 'unavailable'), cloud: mockCloud(), threshold: 0.8, privacy: { escalation: 'never' } });
    await expect(t.run('a')).rejects.toMatchObject({ name: 'BelayError', code: 'no-result' });
  });

  it('a task without a cloud runner never escalates', async () => {
    const t = task({ name: 'x', schema: triageSchema, local: mockLocal({ value: 'bug', confidence: 0.1 }), threshold: 0.8 });
    expect(await t.run('a')).toMatchObject({ source: 'local', escalationBlocked: 'policy' });
  });

  it('consent: asks with the redacted input; denied keeps it local', async () => {
    const consent = vi.fn(async () => false);
    const { t, cloud } = triage(0.3, { privacy: { escalation: 'consent', consent, redact: (s: string) => s.replace(/\d/g, '#') } });
    const result = await t.run('card 4242');
    expect(consent).toHaveBeenCalledWith({ task: 'ticket-triage', reason: 'low-confidence', input: 'card ####', local: { value: 'bug', confidence: 0.3 } });
    expect(cloud.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ source: 'local', escalationBlocked: 'consent-denied' });
  });

  it('consent: granted escalates; not asked when local is confident', async () => {
    const consent = vi.fn(() => true);
    const { t } = triage(0.3, { privacy: { escalation: 'consent', consent } });
    expect((await t.run('a')).source).toBe('cloud');
    const confident = triage(0.9, { privacy: { escalation: 'consent', consent } });
    await confident.t.run('a');
    expect(consent).toHaveBeenCalledTimes(1);
  });

  it('consent callback that throws counts as denied', async () => {
    const { t } = triage(0.3, { privacy: { escalation: 'consent', consent: () => { throw new Error('x'); } } });
    expect((await t.run('a')).escalationBlocked).toBe('consent-denied');
  });

  it('redact: the cloud receives only redacted input; a failing redact never sends', async () => {
    const { t, cloud } = triage(0.3, { privacy: { redact: async (s: string) => s.replace(/\S+@\S+/g, '[email]') } });
    await t.run('mail me at a@b.co');
    expect(cloud.run.mock.calls[0]![0]).toMatchObject({ input: 'mail me at [email]' });

    const failing = triage(0.3, { privacy: { redact: () => { throw new Error('nope'); } } });
    expect(await failing.t.run('a')).toMatchObject({ source: 'local', escalationBlocked: 'policy' });
    expect(failing.cloud.run).not.toHaveBeenCalled();
  });

  it('per-run escalation can tighten but not loosen the task policy', async () => {
    const auto = triage(0.3);
    expect((await auto.t.run('a', { escalation: 'never' })).escalationBlocked).toBe('policy');
    const never = triage(0.3, { privacy: { escalation: 'never' } });
    expect((await never.t.run('a', { escalation: 'auto' })).escalationBlocked).toBe('policy');
    expect(never.cloud.run).not.toHaveBeenCalled();
  });

  it('requires a consent callback for "consent"', () => {
    expect(() => triage(0.3, { privacy: { escalation: 'consent' } })).toThrow(BelayError);
  });
});

describe('cloud failures', () => {
  it('falls back to the local result when the cloud fails', async () => {
    const local = mockLocal({ value: 'bug', confidence: 0.3 });
    const cloud = { id: 'c', run: vi.fn(async () => { throw new Error('503'); }) };
    const t = task({ name: 'x', schema: triageSchema, local, cloud, threshold: 0.8 });
    expect(await t.run('a')).toMatchObject({ value: 'bug', source: 'local', escalationReason: 'low-confidence', escalationBlocked: 'cloud-error' });
  });

  it('throws when neither runner produced a result', async () => {
    const local = mockLocal({ value: 'bug', confidence: 1 }, 'unavailable');
    const failing = { id: 'c', run: vi.fn(async () => { throw new Error('503'); }) };
    await expect(task({ name: 'x', schema: triageSchema, local, cloud: failing, threshold: 0.8 }).run('a')).rejects.toMatchObject({ code: 'cloud-error' });
    const invalid = task({ name: 'x', schema: triageSchema, local, cloud: mockCloud('spam'), threshold: 0.8 });
    await expect(invalid.run('a')).rejects.toMatchObject({ code: 'cloud-invalid-output' });
  });
});

describe('abort', () => {
  it('rejects immediately when already aborted', async () => {
    const { t, local } = triage(0.9);
    const controller = new AbortController();
    controller.abort();
    await expect(t.run('a', { signal: controller.signal })).rejects.toThrow();
    expect(local.run).not.toHaveBeenCalled();
  });

  it('does not fall back to local when aborted during the cloud call', async () => {
    const controller = new AbortController();
    const local = mockLocal({ value: 'bug', confidence: 0.1 });
    const cloud = {
      id: 'c',
      run: vi.fn((_req: unknown, { signal }: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason));
          controller.abort();
        }),
      ),
    };
    const t = task({ name: 'x', schema: triageSchema, local, cloud: cloud as never, threshold: 0.8 });
    await expect(t.run('a', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('telemetry', () => {
  it('emits one run event per run, without the input', async () => {
    const events: BelayEvent[] = [];
    const { t } = triage(0.3, { onEvent: (e: BelayEvent) => events.push(e) });
    await t.run('secret text');
    expect(events).toHaveLength(1);
    const event = events[0] as RunEvent;
    expect(event).toMatchObject({
      type: 'run',
      task: 'ticket-triage',
      source: 'cloud',
      label: 'billing',
      confidence: null,
      localConfidence: 0.3,
      threshold: 0.8,
      thresholdSource: 'manual',
      calibratedAt: null,
      escalationReason: 'low-confidence',
      escalationBlocked: null,
      localRunner: 'mock-local',
      cloudRunner: 'mock-cloud',
    });
    expect(event.cloudLatencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('a throwing listener does not break the run', async () => {
    const { t } = triage(0.9, { onEvent: () => { throw new Error('x'); } });
    expect((await t.run('a')).source).toBe('local');
  });
});

describe('calibration', () => {
  const calibration = (overrides: Partial<CalibrationFile> = {}): CalibrationFile => ({
    version: 1,
    task: 'ticket-triage',
    schemaFingerprint: schemaFingerprint(triageSchema),
    createdAt: '2026-09-29T00:00:00.000Z',
    local: { runner: 'classifier-api' },
    cloud: { runner: 'fetch' },
    dataset: { size: 300, fingerprint: 'fnv1a:00000000' },
    target: { metric: 'accuracy', value: 0.95 },
    threshold: 0.6,
    expected: { accuracy: 0.95, localShare: 0.7, localAccuracy: 0.97, cloudAccuracy: 0.93 },
    curve: [],
    confidenceHistogram: { edges: [0, 0.5, 1], counts: [10, 290] },
    ...overrides,
  });

  it('uses the calibrated threshold instead of the manual one', async () => {
    const events: BelayEvent[] = [];
    const { t } = triage(0.7, { calibration: calibration(), onEvent: (e: BelayEvent) => events.push(e) });
    expect(await t.threshold()).toBe(0.6);
    expect(await t.run('a')).toMatchObject({ source: 'local', threshold: 0.6 });
    expect(events[0]).toMatchObject({ thresholdSource: 'calibration', calibratedAt: '2026-09-29T00:00:00.000Z' });
  });

  it('applies per-label thresholds to the local top label', async () => {
    const { t } = triage(0.7, { calibration: calibration({ thresholds: { bug: 0.75 } }) });
    expect(await t.run('a')).toMatchObject({ source: 'cloud', threshold: 0.75 });
  });

  it('loads from a URL once', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(calibration())));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { t } = triage(0.7, { threshold: undefined, calibration: '/belay.calibration.json' });
      await t.run('a');
      await t.run('b');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await t.threshold()).toBe(0.6);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a calibration made for another schema, falling back to the manual threshold', async () => {
    const events: BelayEvent[] = [];
    const { t } = triage(0.7, { calibration: calibration({ schemaFingerprint: 'fnv1a:deadbeef' }), onEvent: (e: BelayEvent) => events.push(e) });
    expect(await t.run('a')).toMatchObject({ source: 'cloud', threshold: 0.8 });
    expect(events[0]).toMatchObject({ type: 'error', stage: 'calibration' });
  });

  it('throws without a fallback threshold', async () => {
    const { t } = triage(0.7, { threshold: undefined, calibration: calibration({ task: 'other' }) });
    await expect(t.run('a')).rejects.toMatchObject({ code: 'invalid-calibration' });
  });
});

describe('generation tasks: validation + judge', () => {
  const schema = {
    type: 'structured' as const,
    jsonSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    validate: (v: unknown): v is { title: string } =>
      !!v && typeof v === 'object' && typeof (v as { title?: unknown }).title === 'string',
  };

  it('uses the judge probability as confidence', async () => {
    const judge = vi.fn(async () => 0.9);
    const t = task({ name: 'summarize', schema, local: mockLocal({ value: '{"title":"Hi"}' }), cloud: mockCloud({ title: 'Cloud' }), judge, threshold: 0.8 });
    const result = await t.run('text');
    expect(result).toMatchObject({ value: { title: 'Hi' }, confidence: 0.9, source: 'local' });
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ input: 'text', value: { title: 'Hi' }, task: 'summarize' }));
  });

  it('takes the minimum of runner and judge confidence', async () => {
    const t = task({ name: 's', schema, local: mockLocal({ value: { title: 'Hi' }, confidence: 0.95 }), cloud: mockCloud({ title: 'C' }), judge: async () => 0.5, threshold: 0.8 });
    expect(await t.run('text')).toMatchObject({ source: 'cloud', local: { confidence: 0.5 } });
  });

  it('escalates invalid output without asking the judge', async () => {
    const judge = vi.fn(async () => 1);
    const t = task({ name: 's', schema, local: mockLocal({ value: { nope: 1 } }), cloud: mockCloud({ title: 'C' }), judge, threshold: 0.1 });
    expect(await t.run('text')).toMatchObject({ source: 'cloud', escalationReason: 'invalid-output', value: { title: 'C' } });
    expect(judge).not.toHaveBeenCalled();
  });

  it('is a configuration error when there is no confidence signal at all', async () => {
    const t = task({ name: 's', schema, local: mockLocal({ value: { title: 'Hi' } }), cloud: mockCloud({ title: 'C' }), threshold: 0.8 });
    await expect(t.run('text')).rejects.toMatchObject({ code: 'invalid-task' });
  });
});

describe('task definition', () => {
  it('validates options', () => {
    const local = mockLocal({ value: 'bug', confidence: 1 });
    expect(() => task({ name: 'x', schema: triageSchema, local } as never)).toThrow(/threshold or a calibration/);
    expect(() => task({ name: 'x', schema: triageSchema, local, threshold: 1.5 })).toThrow(/threshold/);
    expect(() => task({ name: 'x', schema: { type: 'categorical', options: ['a'] }, local, threshold: 0.5 })).toThrow(/two options/);
    expect(() => task({ name: 'x', schema: { type: 'categorical', options: ['a', 'a'] }, local, threshold: 0.5 })).toThrow(/unique/);
    expect(() => task({ name: 'x', schema: { type: 'binary', prompt: '' }, local, threshold: 0.5 })).toThrow(/prompt/);
  });

  it('delegates availability, prepare and destroy to the local runner', async () => {
    const { t, local } = triage(0.9);
    expect(await t.availability()).toBe('available');
    const onProgress = () => {};
    await t.prepare({ onProgress });
    expect(local.prepare).toHaveBeenCalledWith(expect.objectContaining({ task: 'ticket-triage' }), { onProgress });
    t.destroy();
    expect(local.destroy).toHaveBeenCalled();
  });

  it('binary tasks return booleans', async () => {
    const t = task({
      name: 'moderation',
      schema: { type: 'binary', prompt: 'Is this comment abusive?' },
      local: mockLocal({ value: false, confidence: 0.6 }),
      cloud: mockCloud({ value: 'true' }),
      threshold: 0.9,
    });
    expect(await t.run('a')).toMatchObject({ value: true, source: 'cloud' });
  });
});
