import { describe, expect, it, vi } from 'vitest';
import { task, type Availability, type CloudRunner } from '@swissspidy/belay-core';
import {
  classifierApi,
  readDecision,
  toClassifierSchema,
  type ClassifierCreateOptions,
  type ClassifierDecision,
  type ClassifierStatic,
} from '../src/index.js';

const triageSchema = {
  type: 'categorical',
  prompt: 'Which team should handle this ticket?',
  options: ['bug', { label: 'billing', description: 'Invoices and charges' }, 'feature', 'other'],
} as const;

function fakeClassifier(decision: (input: string) => ClassifierDecision, initial: Availability = 'available') {
  let state: Availability = initial;
  const instances: { classify: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[] = [];
  const api = {
    availability: vi.fn(async () => state),
    create: vi.fn(async (options: ClassifierCreateOptions) => {
      if (state !== 'available') {
        // Mirrors the real API: creating while downloadable starts the download.
        const monitor = new EventTarget();
        options.monitor?.(monitor);
        monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 0.5 }));
        monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 1 }));
        state = 'available';
      }
      const instance = {
        classify: vi.fn(async (input: string) => ({ answer: decision(input) })),
        destroy: vi.fn(),
      };
      instances.push(instance);
      return instance;
    }),
  };
  return { api: api satisfies ClassifierStatic, instances };
}

const categorical = (label: string, probabilities: Record<string, number>, confidence = 0.5): ClassifierDecision => ({
  id: 'answer',
  label,
  confidence,
  probabilities: Object.entries(probabilities).map(([l, probability]) => ({ label: l, probability })),
});

describe('toClassifierSchema', () => {
  it('maps a categorical task to one question', () => {
    expect(toClassifierSchema(triageSchema, { context: 'SaaS support' })).toEqual({
      context: 'SaaS support',
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      questions: [
        {
          id: 'answer',
          type: 'categorical',
          prompt: 'Which team should handle this ticket?',
          options: [{ label: 'bug' }, { label: 'billing', description: 'Invoices and charges' }, { label: 'feature' }, { label: 'other' }],
        },
      ],
    });
  });

  it('maps binary and ordinal tasks', () => {
    expect(toClassifierSchema({ type: 'binary', prompt: 'Abusive?' }).questions).toEqual([{ id: 'answer', type: 'binary', prompt: 'Abusive?' }]);
    expect(toClassifierSchema({ type: 'ordinal', options: ['1', '2', '3'] }).questions[0]).toMatchObject({ type: 'ordinal', prompt: expect.any(String) });
  });

  it('rejects structured tasks', () => {
    expect(() => toClassifierSchema({ type: 'structured', jsonSchema: {}, validate: (_: unknown): _ is unknown => true })).toThrow(/binary, categorical and ordinal/);
  });
});

describe('readDecision', () => {
  it('uses the probability of the returned label by default', () => {
    const out = readDecision(triageSchema, categorical('bug', { bug: 0.94, billing: 0.03, feature: 0.03 }, 0.92));
    expect(out).toMatchObject({ value: 'bug', confidence: 0.94 });
    expect(out.probabilities).toHaveLength(3);
  });

  it('can use the model-reported confidence instead', () => {
    expect(readDecision(triageSchema, categorical('bug', { bug: 0.94 }, 0.92), 'model').confidence).toBe(0.92);
  });

  it('falls back to confidence when probabilities are missing, and to argmax when the label is', () => {
    expect(readDecision(triageSchema, { id: 'answer', label: 'bug', confidence: 0.8 }).confidence).toBe(0.8);
    expect(readDecision(triageSchema, { probabilities: [{ label: 'feature', probability: 0.6 }, { label: 'bug', probability: 0.4 }] } as ClassifierDecision)).toMatchObject({ value: 'feature', confidence: 0.6 });
  });

  it('binary: value is a boolean and confidence is max(P(true), P(false))', () => {
    const schema = { type: 'binary', prompt: 'Abusive?' } as const;
    expect(readDecision(schema, { id: 'answer', label: 'true', probability: 0.97, confidence: 0.94 })).toMatchObject({ value: true, confidence: 0.97 });
    const no = readDecision(schema, { id: 'answer', label: 'false', probability: 0.2, confidence: 0.6 });
    expect(no.value).toBe(false);
    expect(no.confidence).toBeCloseTo(0.8);
  });

  it('throws on malformed results', () => {
    expect(() => readDecision(triageSchema, undefined)).toThrow();
    expect(() => readDecision(triageSchema, { id: 'answer' } as ClassifierDecision)).toThrow();
  });
});

describe('classifierApi runner', () => {
  const ctx = { task: 'ticket-triage', schema: triageSchema };

  it('is unavailable without the API', async () => {
    const runner = classifierApi();
    expect(await runner.availability(ctx)).toBe('unavailable');
  });

  it('reads globalThis.Classifier (native API or extension polyfill)', async () => {
    const { api } = fakeClassifier(() => categorical('bug', { bug: 0.9 }));
    vi.stubGlobal('Classifier', api);
    try {
      expect(await classifierApi().availability(ctx)).toBe('available');
      expect(api.availability).toHaveBeenCalledWith(toClassifierSchema(triageSchema));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('creates one session and reuses it', async () => {
    const { api, instances } = fakeClassifier(() => categorical('billing', { bug: 0.1, billing: 0.9 }));
    const runner = classifierApi({ classifier: api });
    await runner.run('a', ctx);
    const out = await runner.run('b', ctx);
    expect(out).toMatchObject({ value: 'billing', confidence: 0.9 });
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(instances[0]!.classify).toHaveBeenCalledTimes(2);
  });

  it('never creates a session (download) from run() while downloadable', async () => {
    const { api } = fakeClassifier(() => categorical('bug', { bug: 0.9 }), 'downloadable');
    const runner = classifierApi({ classifier: api });
    await expect(runner.run('a', ctx)).rejects.toMatchObject({ name: 'LocalUnavailableError' });
    expect(api.create).not.toHaveBeenCalled();
  });

  it('prepare() downloads with progress, after which run() works', async () => {
    const { api } = fakeClassifier(() => categorical('bug', { bug: 0.9 }), 'downloadable');
    const runner = classifierApi({ classifier: api });
    const progress: number[] = [];
    await runner.prepare!(ctx, { onProgress: (p) => progress.push(p) });
    expect(progress).toEqual([0.5, 1]);
    expect(await runner.run('a', ctx)).toMatchObject({ value: 'bug' });
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it('keeps one session per context and evicts the oldest', async () => {
    const { api, instances } = fakeClassifier(() => categorical('bug', { bug: 0.9 }));
    const runner = classifierApi({ classifier: api, maxSessions: 2 });
    await runner.run('a', { ...ctx, context: 'one' });
    await runner.run('a', { ...ctx, context: 'two' });
    await runner.run('a', { ...ctx, context: 'three' });
    expect(api.create).toHaveBeenCalledTimes(3);
    expect(api.create.mock.calls[1]![0]).toMatchObject({ context: 'two' });
    await Promise.resolve();
    expect(instances[0]!.destroy).toHaveBeenCalled();
    runner.destroy!();
    await Promise.resolve();
    expect(instances[2]!.destroy).toHaveBeenCalled();
  });

  it('passes the abort signal to classify() but not to the cached session', async () => {
    const { api, instances } = fakeClassifier(() => categorical('bug', { bug: 0.9 }));
    const runner = classifierApi({ classifier: api });
    const { signal } = new AbortController();
    await runner.run('a', { ...ctx, signal });
    expect(instances[0]!.classify).toHaveBeenCalledWith('a', { signal });
    // Aborting one run must not destroy the session every later run shares.
    expect(api.create.mock.calls[0]![0]).not.toHaveProperty('signal');
  });
});

describe('end to end: categorical task with the Classifier runner', () => {
  const scripted: Record<string, ClassifierDecision> = {
    'App crashes when I click save': categorical('bug', { bug: 0.96, billing: 0.01, feature: 0.02, other: 0.01 }),
    'Please add dark mode': categorical('feature', { bug: 0.05, billing: 0.02, feature: 0.9, other: 0.03 }),
    'Something is off with my account': categorical('other', { bug: 0.2, billing: 0.35, feature: 0.05, other: 0.4 }),
    'The export button charges me twice': categorical('bug', { bug: 0.55, billing: 0.43, feature: 0.01, other: 0.01 }),
  };

  it('escalates exactly the inputs whose top probability is below the threshold', async () => {
    const { api } = fakeClassifier((input) => scripted[input]!);
    const cloud: CloudRunner = { id: 'cloud', run: vi.fn(async () => ({ value: 'billing' })) };
    const triage = task({ name: 'ticket-triage', schema: triageSchema, local: classifierApi({ classifier: api }), cloud, threshold: 0.8 });

    const results = Object.fromEntries(
      await Promise.all(Object.keys(scripted).map(async (text) => [text, await triage.run(text)] as const)),
    );
    expect(results['App crashes when I click save']).toMatchObject({ value: 'bug', source: 'local', confidence: 0.96 });
    expect(results['Please add dark mode']).toMatchObject({ value: 'feature', source: 'local', confidence: 0.9 });
    expect(results['Something is off with my account']).toMatchObject({ value: 'billing', source: 'cloud', escalationReason: 'low-confidence', local: { value: 'other', confidence: 0.4 } });
    expect(results['The export button charges me twice']).toMatchObject({ source: 'cloud', local: { confidence: 0.55 } });
    expect(cloud.run).toHaveBeenCalledTimes(2);
  });

  it('escalates with local-unavailable (and no download) until prepare() is called', async () => {
    const { api } = fakeClassifier((input) => scripted[input]!, 'downloadable');
    const cloud: CloudRunner = { id: 'cloud', run: vi.fn(async () => ({ value: 'bug' })) };
    const triage = task({ name: 'ticket-triage', schema: triageSchema, local: classifierApi({ classifier: api }), cloud, threshold: 0.8 });

    expect(await triage.run('App crashes when I click save')).toMatchObject({ source: 'cloud', escalationReason: 'local-unavailable' });
    expect(api.create).not.toHaveBeenCalled();

    await triage.prepare(); // from a click handler in a real app
    expect(await triage.run('App crashes when I click save')).toMatchObject({ source: 'local', value: 'bug' });
  });
});
