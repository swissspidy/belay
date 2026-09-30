import { describe, expect, it, vi } from 'vitest';
import {
  BelayError,
  buildInstruction,
  combineConfidence,
  fetchAdapter,
  fnv1a,
  parseCalibration,
  parseValue,
  schemaFingerprint,
  thresholdFor,
  toJsonSchema,
  topProbability,
} from '../src/index.js';
import { triageSchema } from './helpers.js';

describe('confidence', () => {
  it('topProbability', () => {
    expect(topProbability([{ label: 'a', probability: 0.2 }, { label: 'b', probability: 0.7 }])).toBe(0.7);
    expect(topProbability([])).toBe(0);
  });

  it('combineConfidence', () => {
    expect(combineConfidence({ valid: false, runner: 1, judge: 1 })).toBe(0);
    expect(combineConfidence({ valid: true, runner: 0.7 })).toBe(0.7);
    expect(combineConfidence({ valid: true, judge: 0.6 })).toBe(0.6);
    expect(combineConfidence({ valid: true, runner: 0.9, judge: 0.6 })).toBe(0.6);
    expect(combineConfidence({ valid: true })).toBeUndefined();
    expect(combineConfidence({ valid: true, judge: 1.4 })).toBe(1);
  });
});

describe('schema', () => {
  it('toJsonSchema wraps non-structured values', () => {
    expect(toJsonSchema(triageSchema)).toEqual({
      type: 'object',
      properties: { value: { type: 'string', enum: ['bug', 'billing', 'feature', 'other'] } },
      required: ['value'],
      additionalProperties: false,
    });
    expect(toJsonSchema({ type: 'binary', prompt: 'q' })).toMatchObject({ properties: { value: { type: 'boolean' } } });
  });

  it('parseValue', () => {
    expect(parseValue(triageSchema, 'bug')).toEqual({ ok: true, value: 'bug' });
    expect(parseValue(triageSchema, 'BUG ')).toEqual({ ok: true, value: 'bug' });
    expect(parseValue(triageSchema, { value: 'other' })).toEqual({ ok: true, value: 'other' });
    expect(parseValue(triageSchema, 'spam').ok).toBe(false);
    expect(parseValue(triageSchema, 3).ok).toBe(false);
    expect(parseValue({ type: 'binary', prompt: 'q' }, 'Yes')).toEqual({ ok: true, value: true });
    expect(parseValue({ type: 'binary', prompt: 'q' }, 'maybe').ok).toBe(false);
    expect(parseValue({ type: 'ordinal', options: ['1', '2', '3'] }, 2)).toEqual({ ok: true, value: '2' });
    const structured = { type: 'structured' as const, jsonSchema: {}, validate: (v: unknown): v is { a: number } => typeof (v as { a?: unknown })?.a === 'number' };
    expect(parseValue(structured, '{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseValue(structured, '{a:1}').ok).toBe(false);
  });

  it('schemaFingerprint is stable and sensitive to what the model sees', () => {
    const fp = schemaFingerprint(triageSchema);
    expect(fp).toMatch(/^fnv1a:[0-9a-f]{8}$/);
    expect(schemaFingerprint({ type: 'categorical', options: [...triageSchema.options] })).toBe(fp);
    expect(schemaFingerprint({ type: 'categorical', options: [{ label: 'bug' }, 'billing', 'feature', 'other'] })).toBe(fp);
    expect(schemaFingerprint({ type: 'categorical', options: ['bug', 'billing', 'feature', 'misc'] })).not.toBe(fp);
    expect(schemaFingerprint({ type: 'categorical', options: [{ label: 'bug', description: 'defect' }, 'billing', 'feature', 'other'] })).not.toBe(fp);
    expect(schemaFingerprint({ ...triageSchema, prompt: 'Route it' })).not.toBe(fp);
  });

  it('buildInstruction', () => {
    const text = buildInstruction({ type: 'categorical', options: [{ label: 'bug', description: 'a defect' }, 'other'] }, 'Support desk');
    expect(text).toBe(
      'Support desk\nClassify the input into exactly one of the options.\nOptions:\n- bug: a defect\n- other\nRespond with JSON: {"value": "<one option label>"}.',
    );
  });

  it('fnv1a matches the reference vectors', () => {
    expect(fnv1a('')).toBe('811c9dc5');
    expect(fnv1a('a')).toBe('e40c292c');
    expect(fnv1a('foobar')).toBe('bf9cf968');
  });
});

describe('calibration file', () => {
  const valid = {
    version: 1,
    task: 't',
    schemaFingerprint: 'fnv1a:00000000',
    threshold: 0.7,
    expected: { accuracy: 0.9, localShare: 0.6, localAccuracy: 0.95, cloudAccuracy: 0.9 },
    curve: [],
    confidenceHistogram: { edges: [0, 1], counts: [3] },
  };

  it('parses a valid file', () => {
    expect(parseCalibration(valid, 't').threshold).toBe(0.7);
  });

  it.each([
    [{ version: 2 }, /version/],
    [{ task: 'other' }, /task/],
    [{ threshold: -0.2 }, /threshold/],
    [{ thresholds: { bug: -1 } }, /thresholds/],
    [{ expected: {} }, /expected/],
    [{ confidenceHistogram: { edges: [0, 1], counts: [1, 2] } }, /edges/],
  ])('rejects %j', (patch, message) => {
    expect(() => parseCalibration({ ...valid, ...patch }, 't')).toThrow(message);
    expect(() => parseCalibration({ ...valid, ...patch }, 't')).toThrow(BelayError);
  });

  it('thresholdFor', () => {
    expect(thresholdFor({ threshold: 0.7, thresholds: { bug: 0.9 } }, 'bug')).toBe(0.9);
    expect(thresholdFor({ threshold: 0.7, thresholds: { bug: 0.9 } }, 'other')).toBe(0.7);
    expect(thresholdFor({ threshold: 0.7 }, 'toString')).toBe(0.7);
  });
});

describe('fetchAdapter', () => {
  const request = {
    task: 't',
    schema: triageSchema,
    jsonSchema: toJsonSchema(triageSchema),
    instruction: 'i',
    input: 'hello',
  };

  it('POSTs the request as JSON and returns the selected output', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ result: { value: 'bug' } })));
    const runner = fetchAdapter({ url: '/api/belay', headers: { 'x-app': '1' }, select: (j) => (j as { result: unknown }).result, fetch: fetchMock });
    const out = await runner.run(request, {});
    expect(out).toEqual({ value: { value: 'bug' } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/belay');
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json', 'x-app': '1' } });
    expect(JSON.parse(init!.body as string)).toMatchObject({ task: 't', input: 'hello', schema: { type: 'categorical' } });
  });

  it('throws on HTTP errors', async () => {
    const runner = fetchAdapter({ url: '/x', fetch: async () => new Response('no', { status: 500 }) });
    await expect(runner.run(request, {})).rejects.toThrow(/500/);
  });
});
