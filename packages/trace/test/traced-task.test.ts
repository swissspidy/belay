import { describe, expect, it, vi } from 'vitest';
import { cloudAdapter, type BelayEvent, type TaskSchema } from '@swissspidy/belay-core';
import { mockCloud, mockLocal, triageSchema } from '../../core/test/helpers.js';
import { labelTrace, memorySink, parseTrace, tracedTask } from '../src/index.js';

const confident = { value: 'bug', confidence: 0.95 };
const unsure = { value: 'bug', confidence: 0.4 };

function setup(overrides: Record<string, unknown> = {}, trace: Record<string, unknown> = {}, local = unsure) {
  const sink = memorySink();
  const cloud = mockCloud<typeof triageSchema>('billing');
  const t = tracedTask(
    { name: 'triage', schema: triageSchema, local: mockLocal<typeof triageSchema>(local), cloud, threshold: 0.8, ...overrides },
    { sink, id: (() => { let n = 0; return () => `t${++n}`; })(), ...trace },
  );
  return { t, sink, cloud };
}

describe('tracedTask', () => {
  it('records an escalated run with its input and the cloud answer as a silver label', async () => {
    const { t, sink } = setup({}, { environment: { localModel: 'laya-1' } });
    const result = await t.run('I was charged twice');
    await t.flush();
    expect(result.source).toBe('cloud');
    expect(sink.traces).toHaveLength(1);
    const trace = sink.traces[0]!;
    expect(trace).toMatchObject({
      version: 1,
      id: 't1',
      kind: 'run',
      task: 'triage',
      input: 'I was charged twice',
      redacted: false,
      source: 'cloud',
      local: { value: 'bug', confidence: 0.4 },
      cloud: { value: 'billing', confidence: null },
      label: { value: 'billing', kind: 'silver', origin: 'cloud' },
      threshold: 0.8,
      escalationReason: 'low-confidence',
      escalationBlocked: null,
      policy: 'auto',
      environment: { localRunner: 'mock-local', cloudRunner: 'mock-cloud', localModel: 'laya-1' },
    });
    expect(trace.weight).toBeUndefined();
    expect(parseTrace(JSON.parse(JSON.stringify(trace)))).toEqual(trace);
  });

  it('by default records a run the device answered without its input', async () => {
    const { t, sink, cloud } = setup({}, {}, confident);
    await t.run('The app crashes on save');
    await t.flush();
    expect(cloud.run).not.toHaveBeenCalled();
    expect(sink.traces[0]).toMatchObject({ input: null, label: null, source: 'local', cloud: null, local: { value: 'bug', confidence: 0.95 } });
  });

  it('records every input under content "all"', async () => {
    const { t, sink } = setup({}, { content: 'all' }, confident);
    await t.run('The app crashes on save');
    await t.flush();
    expect(sink.traces[0]).toMatchObject({ input: 'The app crashes on save', label: null, source: 'local' });
  });

  it('redacts with the privacy hook before storing', async () => {
    const redact = (text: string) => text.replace(/\S+@\S+/g, '[email]');
    const { t, sink } = setup({ privacy: { redact } });
    await t.run('refund for ann@example.com please');
    await t.flush();
    expect(sink.traces[0]).toMatchObject({ input: 'refund for [email] please', redacted: true });
    expect(JSON.stringify(sink.traces)).not.toContain('ann@example.com');
  });

  it('withholds the content when the trace redact hook throws', async () => {
    const onError = vi.fn();
    const { t, sink } = setup({}, { onError, redact: () => { throw new Error('boom'); } });
    const result = await t.run('secret text');
    await t.flush();
    expect(result.source).toBe('cloud');
    expect(sink.traces[0]).toMatchObject({ input: null, redacted: false, label: { value: 'billing' } });
    expect(JSON.stringify(sink.traces)).not.toContain('secret text');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('a never-escalate task makes no cloud call and stores no content, even with exploration and content "all"', async () => {
    for (const local of [confident, unsure]) {
      const { t, sink, cloud } = setup({ privacy: { escalation: 'never' }, explore: 1 }, { content: 'all' }, local);
      const result = await t.run('private text');
      await t.feedback('private text', 'billing');
      await t.flush();
      expect(result.source).toBe('local');
      expect(cloud.run).not.toHaveBeenCalled();
      expect(sink.traces).toHaveLength(1);
      expect(sink.traces[0]).toMatchObject({ input: null, label: null, cloud: null, policy: 'never' });
      expect(JSON.stringify(sink.traces)).not.toContain('private text');
    }
  });

  it('a per-run "never" and a task without a cloud runner store no content either', async () => {
    const a = setup({}, { content: 'all' }, confident);
    await a.t.run('private text', { escalation: 'never' });
    await a.t.flush();
    expect(a.sink.traces[0]).toMatchObject({ input: null, policy: 'never' });

    const b = setup({ cloud: undefined }, { content: 'all' }, confident);
    await b.t.run('private text');
    await b.t.flush();
    expect(b.sink.traces[0]).toMatchObject({ input: null, policy: 'never' });
  });

  it('stores no content when consent was denied', async () => {
    const { t, sink, cloud } = setup({ privacy: { escalation: 'consent', consent: () => false } }, { content: 'all' });
    const result = await t.run('private text');
    await t.flush();
    expect(result.escalationBlocked).toBe('consent-denied');
    expect(cloud.run).not.toHaveBeenCalled();
    expect(sink.traces[0]).toMatchObject({ input: null, label: null, escalationBlocked: 'consent-denied' });
  });

  it('keeps the input of a run whose cloud call failed: it was sent', async () => {
    const cloud = cloudAdapter<typeof triageSchema>(async () => { throw new Error('503'); });
    const { t, sink } = setup({ cloud });
    const result = await t.run('I was charged twice');
    await t.flush();
    expect(result.escalationBlocked).toBe('cloud-error');
    expect(sink.traces[0]).toMatchObject({ input: 'I was charged twice', label: null, cloud: null });
  });

  it('weighs an explored run by the confident runs it stands for', async () => {
    const uniform = setup({ explore: { rate: 0.25, random: () => 0 } }, {}, confident);
    await uniform.t.run('The app crashes on save');
    await uniform.t.flush();
    expect(uniform.sink.traces[0]).toMatchObject({ escalationReason: 'exploration', input: 'The app crashes on save', label: { value: 'billing' }, weight: 4 });

    const events: BelayEvent[] = [];
    const informative = setup(
      { explore: { rate: 0.1, strategy: 'informative', random: () => 0 }, onEvent: (e: BelayEvent) => events.push(e) },
      {},
      { value: 'bug', confidence: 0.95, informativeness: 0.5 } as typeof confident,
    );
    await informative.t.run('first');
    await informative.t.run('second');
    await informative.t.flush();
    const weights = events.flatMap((e) => (e.type === 'run' ? [e.explorationWeight!] : []));
    expect(weights).toHaveLength(2);
    expect(informative.sink.traces.map((trace) => trace.weight)).toEqual(weights.map((w) => w / 0.1));
  });

  it('matches concurrent runs to their own events', async () => {
    const cloud = cloudAdapter<typeof triageSchema>(async ({ input }, { reportUsage }) => {
      await new Promise((r) => setTimeout(r, input === 'slow' ? 20 : 1));
      reportUsage({ model: 'm', inputTokens: input.length, outputTokens: 1 });
      return 'billing';
    });
    const { t, sink } = setup({ cloud });
    await Promise.all(['slow', 'quick!', 'mid'].map((input) => t.run(input)));
    await t.flush();
    expect(sink.traces).toHaveLength(3);
    for (const trace of sink.traces) expect(trace.cloud!.usage).toEqual([{ model: 'm', inputTokens: trace.input!.length, outputTokens: 1 }]);
  });

  it('keeps every event of a large batch that resolves at once, even when the runs look alike', async () => {
    // Every run reports the same latency, source and threshold: only the order tells them apart.
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const cloud = cloudAdapter<typeof triageSchema>(async ({ input }, { reportUsage }) => {
        await gate;
        reportUsage({ model: 'm', inputTokens: input.length, outputTokens: 1 });
        return 'billing';
      });
      const { t, sink } = setup({ cloud });
      const runs = Array.from({ length: 600 }, (_, i) => t.run('x'.repeat(i + 1)));
      release();
      await Promise.all(runs);
      await t.flush();
      expect(sink.traces).toHaveLength(600);
      for (const trace of sink.traces) expect(trace.cloud!.usage).toEqual([{ model: 'm', inputTokens: trace.input!.length, outputTokens: 1 }]);
    } finally {
      clock.mockRestore();
    }
  });

  it('records feedback as a gold label only under content "all"', async () => {
    const off = setup();
    expect(await off.t.feedback('where is my invoice', 'billing')).toBe(false);
    await off.t.flush();
    expect(off.sink.traces).toHaveLength(0);

    const on = setup({}, { content: 'all', redact: (text: string) => text.toUpperCase() });
    await on.t.feedback('where is my invoice', 'billing');
    await on.t.flush();
    expect(on.sink.traces[0]).toMatchObject({ kind: 'label', input: 'WHERE IS MY INVOICE', redacted: true, label: { value: 'billing', kind: 'gold', origin: 'feedback' } });
    await expect(on.t.feedback('x', 'nope' as 'bug')).rejects.toThrow(/feedback/);
  });

  it('a failing sink never breaks a run', async () => {
    const onError = vi.fn();
    const { t } = setup({}, { sink: () => Promise.reject(new Error('disk full')), onError });
    await expect(t.run('I was charged twice')).resolves.toMatchObject({ value: 'billing' });
    await t.flush();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('records nothing for a run that throws', async () => {
    const { t, sink } = setup({ cloud: undefined }, {}, { value: 'not-an-option', confidence: 1 });
    await expect(t.run('x')).rejects.toThrow();
    await t.flush();
    expect(sink.traces).toHaveLength(0);
  });

  it('redacts strings inside structured outputs and withholds them with the input', async () => {
    const schema = {
      type: 'structured',
      jsonSchema: { type: 'object' },
      validate: (v: unknown): v is { who: string; tags: string[] } => !!v && typeof v === 'object',
    } satisfies TaskSchema;
    const make = (confidence: number, content: 'sent' | 'all') => {
      const sink = memorySink();
      const t = tracedTask(
        {
          name: 'extract',
          schema,
          local: mockLocal<typeof schema>({ value: { who: 'ann@example.com', tags: ['a ann@example.com'] }, confidence }),
          cloud: mockCloud<typeof schema>({ who: '[email]', tags: [] }),
          threshold: 0.8,
          privacy: { redact: (text: string) => text.replace(/\S+@\S+/g, '[email]') },
        },
        { sink, content },
      );
      return { t, sink };
    };
    const sent = make(0.1, 'sent');
    await sent.t.run('mail ann@example.com');
    await sent.t.flush();
    expect(sent.sink.traces[0]).toMatchObject({ input: 'mail [email]', local: { value: { who: '[email]', tags: ['a [email]'] } }, label: { value: { who: '[email]', tags: [] } } });

    const kept = make(0.9, 'sent');
    await kept.t.run('mail ann@example.com');
    await kept.t.flush();
    expect(kept.sink.traces[0]).toMatchObject({ input: null, local: { value: null, confidence: 0.9 } });
    expect(JSON.stringify(kept.sink.traces)).not.toContain('ann@example.com');
  });

  it('still calls the task\'s own onEvent and needs a sink', async () => {
    const onEvent = vi.fn();
    const { t } = setup({ onEvent });
    await t.run('x');
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'run' }));
    expect(() => tracedTask({ name: 'x', schema: triageSchema, local: mockLocal(unsure), threshold: 0.5 }, {} as never)).toThrow(/sink/);
  });
});

describe('labelTrace and parseTrace', () => {
  it('builds a deterministic gold label from a dataset row', () => {
    const trace = labelTrace({ task: 'triage', schema: triageSchema, input: 'where is my invoice', value: 'billing', index: 3 });
    expect(trace).toMatchObject({ id: 'dataset:3', kind: 'label', timestamp: 0, label: { kind: 'gold', origin: 'dataset' } });
    expect(labelTrace({ task: 'triage', schema: triageSchema, input: 'x', value: 'bug', origin: 'synthetic' }).label).toMatchObject({ kind: 'silver' });
    expect(() => labelTrace({ task: 'triage', schema: triageSchema, input: 'x', value: 'nope' as 'bug' })).toThrow(/schema/);
  });

  it('rejects malformed traces', () => {
    const good = labelTrace({ task: 'triage', schema: triageSchema, input: 'x', value: 'bug', index: 1 });
    expect(() => parseTrace({ ...good, version: 2 })).toThrow(/version/);
    expect(() => parseTrace({ ...good, input: 5 })).toThrow(/input/);
    expect(() => parseTrace({ ...good, label: { value: 'bug', kind: 'bronze', origin: 'cloud' } })).toThrow(/kind/);
    expect(() => parseTrace({ ...good, weight: -1 })).toThrow(/weight/);
    expect(() => parseTrace('nope')).toThrow();
  });
});
