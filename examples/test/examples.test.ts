import { describe, expect, it } from 'vitest';
import { optionLabels } from '@belay/core';
import { loadDataset, type BelayConfig } from '@belay/calibrate';

const examples = [
  { dir: 'ticket-triage', task: 'ticket-triage' },
  { dir: 'content-moderation', task: 'content-moderation' },
  { dir: 'intent-detection', task: 'intent-detection' },
];
const structured = [{ dir: 'event-extraction', task: 'event-extraction' }];

describe.each(examples)('$dir', ({ dir, task }) => {
  it('has a config whose dataset parses against the schema: 300 examples, balanced labels', async () => {
    process.env['BELAY_CLOUD'] ??= 'reference'; // no credentials needed to load the config
    const config = ((await import(`../${dir}/belay.config.mjs`)) as { default: BelayConfig }).default;
    const taskConfig = config.tasks[task]!;
    expect(taskConfig).toBeDefined();
    const dataset = await loadDataset(new URL(`../${dir}/examples.jsonl`, import.meta.url).pathname, taskConfig.schema);
    expect(dataset.examples).toHaveLength(300);
    const counts = new Map<string, number>();
    for (const e of dataset.examples) counts.set(e.truth, (counts.get(e.truth) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual([...optionLabels(taskConfig.schema)].sort());
    const sizes = [...counts.values()];
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(new Set(dataset.examples.map((e) => e.input.toLowerCase())).size).toBe(300);
  });
});

describe('ticket-triage redaction', () => {
  it('redacts ASCII and non-ASCII email addresses, keeping sentence punctuation', async () => {
    const { redactEmails } = (await import('../ticket-triage/task.mjs')) as { redactEmails: (s: string) => string };
    expect(redactEmails('mail josé@example.com, a.b+c@mail.co.uk or Émile@exämple.de.')).toBe('mail [email], [email] or [email].');
    expect(redactEmails('update {{Email Address}} please; no @ here')).toBe('update {{Email Address}} please; no @ here');
  });
});

describe('cloudCascade', () => {
  it('uses the second runner only below the first one\'s confidence, and reports both usages', async () => {
    const { cloudCascade } = (await import('../shared/cloud.mjs')) as { cloudCascade: (a: unknown, b: unknown, o: { threshold: number }) => any };
    const calls: string[] = [];
    const first = {
      id: 'a',
      run: async ({ input }: { input: string }) => {
        calls.push(`a:${input}`);
        return { value: 'x', confidence: input === 'sure' ? 0.9 : 0.5, usage: { model: 'a', inputTokens: 1, outputTokens: 0 } };
      },
    };
    const second = { id: 'b', run: async ({ input }: { input: string }) => (calls.push(`b:${input}`), { value: 'y', usage: { model: 'b', inputTokens: 2, outputTokens: 1 } }) };
    const runner = cloudCascade(first, second, { threshold: 0.8 });
    expect(runner.id).toBe('a@0.8>b');
    expect(await runner.run({ input: 'sure' }, {})).toMatchObject({ value: 'x', confidence: 0.9 });
    expect(await runner.run({ input: 'unsure' }, {})).toEqual({
      value: 'y',
      usage: [{ model: 'a', inputTokens: 1, outputTokens: 0 }, { model: 'b', inputTokens: 2, outputTokens: 1 }],
    });
    expect(calls).toEqual(['a:sure', 'a:unsure', 'b:unsure']);
  });
});

describe.each(structured)('$dir', ({ dir, task }) => {
  it('has a config whose dataset parses against the structured schema: 300 unique examples', async () => {
    process.env['BELAY_CLOUD'] ??= 'reference';
    const config = ((await import(`../${dir}/belay.config.mjs`)) as { default: BelayConfig }).default;
    const dataset = await loadDataset(new URL(`../${dir}/examples.jsonl`, import.meta.url).pathname, config.tasks[task]!.schema);
    expect(dataset.examples).toHaveLength(300);
    expect(new Set(dataset.examples.map((e) => e.input.toLowerCase())).size).toBe(300);
  });

  it('compares extractions field by field, ignoring case, punctuation, articles and prepositions', async () => {
    const { sameEvent, extractionSchema } = (await import('../event-extraction/task.mjs')) as {
      sameEvent: (a: unknown, b: unknown) => boolean;
      extractionSchema: { validate: (v: unknown) => boolean };
    };
    const expected = { event_name: 'team meeting', date: 'friday', time: 'three pm', person: null, place_name: null };
    expect(sameEvent({ ...expected, event_name: 'The team meeting', time: 'at three PM.' }, expected)).toBe(true);
    expect(sameEvent({ ...expected, person: '' }, expected)).toBe(true);
    expect(sameEvent({ ...expected, place_name: 'null' }, expected)).toBe(true);
    expect(sameEvent({ ...expected, date: 'next friday' }, expected)).toBe(false);
    expect(sameEvent({ ...expected, person: 'joe' }, expected)).toBe(false);
    expect(extractionSchema.validate(expected)).toBe(true);
    expect(extractionSchema.validate({ ...expected, extra: 1 })).toBe(false);
    expect(extractionSchema.validate({ ...expected, date: 5 })).toBe(false);
  });
});
