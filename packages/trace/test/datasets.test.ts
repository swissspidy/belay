import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloudAdapter } from '@swissspidy/belay-core';
import { loadDataset } from '../../calibrate/src/dataset.js';
import { mockLocal, rng, triageSchema } from '../../core/test/helpers.js';
import { labelTrace, tracedTask, type Trace } from '../src/index.js';
import { buildDatasets, inputId, jsonlSink, readManifest, readTraces, writeDatasets, type Datasets, type Split } from '../src/node/index.js';

const LABELS = ['bug', 'billing', 'feature', 'other'] as const;
const WORDS = 'invoice refund crash login export slow charge card button page error report team seat plan trial sync upload search filter'.split(' ');

/** A distinct sentence per index: far from every other one for the near-duplicate check. */
const sentence = (i: number, random: () => number): string =>
  `ticket ${i}: ` + Array.from({ length: 8 }, () => WORDS[Math.floor(random() * WORDS.length)]! + Math.floor(random() * 1000)).join(' ');

const gold = (input: string, value: (typeof LABELS)[number], index: number, extra: Partial<Trace> = {}): Trace => ({
  ...labelTrace({ task: 'triage', schema: triageSchema, input, value, index }),
  ...extra,
});

const build = (traces: Trace[], options: Partial<Parameters<typeof buildDatasets>[1]> = {}): Datasets =>
  buildDatasets(traces, { task: 'triage', schema: triageSchema, seed: 7, ...options });

const splitOf = (d: Datasets, input: string): Split | undefined => d.manifest.assignments[inputId(input)];
const all = (d: Datasets) => [...d.train, ...d.validation, ...d.holdout];

describe('1,000 recorded runs', () => {
  it('build the same splits from the same seed, with no input in two splits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'belay-trace-'));
    const file = join(dir, 'traces', 'triage.jsonl');
    const random = rng(1);
    const truth = new Map<string, (typeof LABELS)[number]>();
    const t = tracedTask(
      {
        name: 'triage',
        schema: triageSchema,
        // About a third of the runs are confident; a tenth of those are explored.
        local: mockLocal<typeof triageSchema>(() => ({ value: 'bug', confidence: random() < 0.35 ? 0.95 : 0.3 })),
        cloud: cloudAdapter<typeof triageSchema>(async ({ input }) => truth.get(input)!),
        threshold: 0.8,
        explore: { rate: 0.1, random },
      },
      { sink: jsonlSink(file) },
    );
    const inputs = Array.from({ length: 1000 }, (_, i) => {
      // Every tenth run repeats an earlier input.
      const input = i % 10 === 9 ? sentence(i - 9, rng(i - 9)) : sentence(i, rng(i));
      truth.set(input, LABELS[i % 4]!);
      return input;
    });
    for (const input of inputs) await t.run(input);
    await t.flush();

    const { traces, invalid } = await readTraces(join(dir, 'traces'));
    expect(invalid).toEqual([]);
    expect(traces).toHaveLength(1000);

    const first = build(traces);
    const again = build(traces);
    const shuffled = build([...traces].sort((a, b) => (a.id < b.id ? -1 : 1)).reverse());
    expect(again).toEqual(first);
    expect(shuffled).toEqual(first);
    expect(build(traces, { seed: 8 }).manifest.assignments).not.toEqual(first.manifest.assignments);

    // No input in two splits, by id and by normalized text.
    const ids = all(first).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(all(first).map((e) => e.input.toLowerCase())).size).toBe(ids.length);
    for (const split of ['train', 'validation', 'holdout'] as const) {
      for (const e of first[split]) expect(first.manifest.assignments[e.id]).toBe(split);
    }

    // Only runs that reached the cloud are labeled; the rest were recorded without input.
    const labeled = traces.filter((trace) => trace.label);
    expect(labeled.length).toBeGreaterThan(600);
    expect(labeled.length).toBeLessThan(1000);
    expect(first.stats.unlabeled).toBe(1000 - labeled.length);
    expect(first.stats.inputs).toBe(ids.length);
    expect(first.holdout.length / ids.length).toBeGreaterThan(0.15);
    expect(first.holdout.length / ids.length).toBeLessThan(0.25);
    expect(all(first).every((e) => e.labelKind === 'silver' && e.label === truth.get(e.input))).toBe(true);
    expect(all(first).some((e) => e.weight === 10)).toBe(true);

    // The split files are what `belay calibrate --data` reads.
    await writeDatasets(join(dir, 'datasets'), first);
    const loaded = await loadDataset(join(dir, 'datasets', 'holdout.jsonl'), triageSchema);
    expect(loaded.examples.map((e) => [e.id, e.input, e.expected])).toEqual(first.holdout.map((e) => [e.id, e.input, e.label]));
    expect(await readManifest(join(dir, 'datasets'))).toEqual(first.manifest);
    expect(await readManifest(join(dir, 'nowhere'))).toBeUndefined();
    expect(await readFile(join(dir, 'datasets', 'manifest.json'), 'utf8')).not.toContain('ticket');
  });
});

describe('buildDatasets', () => {
  const many = (n: number, from = 0): Trace[] => Array.from({ length: n }, (_, i) => gold(sentence(from + i, rng(from + i)), LABELS[i % 4]!, from + i));

  it('treats case, whitespace and Unicode form as the same input', () => {
    const d = build([gold('Where is my  invoice?', 'billing', 1), gold(' where is my invoice? ', 'billing', 2), gold('ｗhere is my invoice?', 'billing', 3)]);
    expect(all(d)).toHaveLength(1);
    expect(d.stats.inputs).toBe(1);
  });

  it('keeps near-duplicates in one split', () => {
    const traces: Trace[] = [];
    for (let i = 0; i < 60; i++) {
      const base = `ticket ${i}: the export button on the reports page ${i * 7919} fails with error code ${i * 104729} since the update last week`;
      traces.push(gold(base, 'bug', i * 2), gold(`${base} please help`, 'bug', i * 2 + 1));
    }
    const d = build(traces);
    expect(all(d)).toHaveLength(120);
    for (let i = 0; i < 120; i += 2) expect(splitOf(d, traces[i]!.input!)).toBe(splitOf(d, traces[i + 1]!.input!));
    expect(new Set(Object.values(d.manifest.assignments)).size).toBe(3);
    // With the check off, some pairs straddle two splits.
    const off = build(traces, { nearDuplicateThreshold: 1 });
    expect(traces.some((_, i) => i % 2 === 0 && splitOf(off, traces[i]!.input!) !== splitOf(off, traces[i + 1]!.input!))).toBe(true);
  });

  it('prefers gold labels, then the majority, then the latest', () => {
    const silver = (input: string, value: (typeof LABELS)[number], index: number, timestamp: number): Trace =>
      gold(input, value, index, { timestamp, label: { value, kind: 'silver', origin: 'cloud' } });
    const d = build([
      silver('a first question about things', 'bug', 1, 10),
      silver('a first question about things', 'bug', 2, 20),
      gold('a first question about things', 'billing', 3),
      silver('second question about stuff here', 'bug', 4, 10),
      silver('second question about stuff here', 'feature', 5, 20),
      silver('second question about stuff here', 'feature', 6, 30),
      silver('third question on another topic', 'bug', 7, 10),
      silver('third question on another topic', 'other', 8, 20),
    ]);
    const byInput = new Map(all(d).map((e) => [e.input, e]));
    expect(byInput.get('a first question about things')).toMatchObject({ label: 'billing', labelKind: 'gold', origin: 'dataset', cloud: 'bug' });
    expect(byInput.get('second question about stuff here')).toMatchObject({ label: 'feature', labelKind: 'silver' });
    expect(byInput.get('third question on another topic')).toMatchObject({ label: 'other', cloud: 'other' });
    expect(d.stats.conflicts).toBe(2);
    expect(d.stats.splits.train.gold + d.stats.splits.validation.gold + d.stats.splits.holdout.gold).toBe(1);
  });

  it('skips other tasks, stale schemas, invalid labels and traces without content', () => {
    const good = gold('where is my invoice today', 'billing', 1);
    const d = build([
      good,
      { ...good, id: 'dup-of-first' },
      { ...good, id: 'a', task: 'other-task' },
      { ...good, id: 'b', schemaFingerprint: 'fnv1a:00000000' },
      { ...good, id: 'c', label: { value: 'nope', kind: 'gold', origin: 'dataset' } },
      { ...good, id: 'd', input: null },
      { ...good, id: 'e', label: null },
      good,
    ]);
    expect(d.stats).toMatchObject({ traces: 6, staleSchema: 1, invalidLabel: 1, unlabeled: 2, inputs: 1 });
  });

  it('freezes the holdout: with the previous manifest every input keeps its split and the holdout only grows', () => {
    const first = build(many(300));
    const second = build([...many(300), ...many(300, 1000)], { previous: first.manifest });
    for (const [id, split] of Object.entries(first.manifest.assignments)) expect(second.manifest.assignments[id]).toBe(split);
    expect(second.holdout.length).toBeGreaterThan(first.holdout.length);
    expect(second.manifest.holdoutFingerprint).not.toBe(first.manifest.holdoutFingerprint);
    expect(build(many(300), { previous: first.manifest }).manifest).toEqual(first.manifest);
    // The same result as building everything at once: a split follows from the seed and the hash.
    expect(second.manifest.assignments).toEqual(build([...many(300), ...many(300, 1000)]).manifest.assignments);

    // Traces that were deleted stay assigned, and are counted as missing.
    const pruned = build(many(100), { previous: second.manifest });
    expect(pruned.stats.missing).toBe(500);
    expect(pruned.manifest.assignments).toEqual(second.manifest.assignments);

    expect(() => build(many(10), { previous: first.manifest, seed: 99 })).toThrow(/seed/);
    expect(() => buildDatasets(many(10), { task: 'triage', schema: { ...triageSchema, options: ['a', 'b'] }, seed: 7, previous: first.manifest })).toThrow(/schema/);
  });

  it('drops a new input that would link inputs of two splits, and joins a known near-duplicate\'s split', () => {
    const body = (i: number) => `ticket ${i}: the export button on the reports page fails with error code ${i * 104729} since the update last week`;
    const first = build(Array.from({ length: 80 }, (_, i) => gold(body(i), 'bug', i)));
    const inHoldout = first.holdout[0]!.input;
    const joined = build([...Array.from({ length: 80 }, (_, i) => gold(body(i), 'bug', i)), gold(`${inHoldout} thanks a lot`, 'bug', 500)], { previous: first.manifest });
    expect(splitOf(joined, `${inHoldout} thanks a lot`)).toBe('holdout');

    // Two known inputs of different splits, bridged by one new text close to both.
    const a = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon';
    const b = `${a} phi chi psi omega one`;
    const bridge = `${a} phi chi psi`;
    const manifest = { ...build([gold(a, 'bug', 1), gold(b, 'bug', 2)], { nearDuplicateThreshold: 0.85 }).manifest };
    manifest.assignments = { [inputId(a)]: 'train', [inputId(b)]: 'holdout' };
    const bridged = build([gold(a, 'bug', 1), gold(b, 'bug', 2), gold(bridge, 'bug', 3)], { previous: manifest });
    expect(bridged.stats.droppedAmbiguous).toBe(1);
    expect(splitOf(bridged, bridge)).toBeUndefined();
    expect(splitOf(bridged, a)).toBe('train');
    expect(splitOf(bridged, b)).toBe('holdout');
  });

  it('never puts synthetic examples in the holdout', () => {
    const synthetic = many(200).map((trace) => ({ ...trace, label: { ...trace.label!, kind: 'silver' as const, origin: 'synthetic' as const } }));
    const d = build(synthetic);
    expect(d.holdout).toHaveLength(0);
    expect(d.train.length + d.validation.length).toBe(200);
    expect(d.validation.length).toBeGreaterThan(20);

    // A synthetic near-duplicate of a holdout input is dropped, not added to it.
    const real = build(many(200));
    const target = real.holdout[0]!.input;
    const mixed = build([...many(200), { ...gold(`${target} ok`, 'bug', 900), label: { value: 'bug', kind: 'silver', origin: 'synthetic' } }], { previous: real.manifest });
    expect(mixed.stats.droppedSynthetic).toBe(1);
    expect(mixed.holdout).toHaveLength(real.holdout.length);
  });

  it('validates its options', () => {
    expect(() => build([], { nearDuplicateThreshold: 0.2 })).toThrow(/nearDuplicateThreshold/);
    expect(() => build([], { ratios: { train: 0, validation: 0, holdout: 0 } })).toThrow(/ratios/);
    const d = build(many(200), { ratios: { train: 1, validation: 1, holdout: 0 } });
    expect(d.holdout).toHaveLength(0);
    expect(d.manifest.ratios).toEqual({ train: 0.5, validation: 0.5, holdout: 0 });
  });
});

describe('jsonlSink and readTraces', () => {
  it('appends in order, skips broken lines and repeated ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'belay-trace-'));
    const file = join(dir, 'nested', 'a.jsonl');
    const sink = jsonlSink(file);
    const traces = Array.from({ length: 50 }, (_, i) => gold(`input number ${i}`, 'bug', i));
    for (const trace of traces) void sink.write(trace);
    void sink.write(traces[0]!);
    await sink.flush();
    await appendFile(file, '{"version":1,"id":"torn","kind":"ru');
    await writeFile(join(dir, 'nested', 'ignored.txt'), 'not traces');

    const fromFile = await readTraces(file);
    expect(fromFile.traces).toEqual(traces);
    expect(fromFile.invalid).toEqual([{ file, line: 52, error: expect.any(String) }]);
    expect((await readTraces(join(dir, 'nested'))).traces).toEqual(traces);
  });

  it('reports a failed write to its caller and keeps writing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'belay-trace-'));
    await writeFile(join(dir, 'file'), '');
    const blocked = jsonlSink(join(dir, 'file', 'under-a-file.jsonl'));
    await expect(blocked.write(gold('x y z', 'bug', 1))).rejects.toThrow();
    await expect(blocked.flush()).resolves.toBeUndefined();
    // Once the cause is gone, the same sink writes again: the failed mkdir is not remembered.
    await rm(join(dir, 'file'));
    await blocked.write(gold('x y z', 'bug', 2));
    expect((await readTraces(join(dir, 'file', 'under-a-file.jsonl'))).traces).toHaveLength(1);
  });
});
