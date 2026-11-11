import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { labelTrace } from '@swissspidy/belay-trace';
import { jsonlSink } from '@swissspidy/belay-trace/node';
import { main } from '../src/index.js';
import { datasetJsonl, LABELS, schema } from './fixtures.js';

let dir: string;
let cwd: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'belay-datasets-'));
  cwd = process.cwd();
  process.chdir(dir);
  await writeFile(join(dir, 'belay.config.mjs'), `export default { tasks: { 'ticket-triage': { schema: { type: 'categorical', options: ${JSON.stringify(LABELS)} } } } };`);
});
afterEach(async () => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const lines = async (file: string) => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; input: string; labelKind: string });

describe('belay datasets', () => {
  it('builds splits from traces and gold examples, and keeps them on the next build', async () => {
    const sink = jsonlSink(join(dir, 'traces', 'day-1.jsonl'));
    for (let i = 0; i < 200; i++) {
      const trace = labelTrace({ task: 'ticket-triage', schema, input: `customer message ${i} says thing ${i * 31} happened in area ${i * 17}`, value: LABELS[i % 4]!, origin: 'cloud', index: i, timestamp: i });
      void sink.write(trace);
    }
    await sink.flush();
    await writeFile(join(dir, 'gold.jsonl'), datasetJsonl(100));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    expect(await main(['datasets', '--traces', 'traces', '--gold', 'gold.jsonl', '--seed', '42'])).toBe(0);
    const printed = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toMatch(/Labeled inputs\s+300/);
    expect(printed).toMatch(/fewer than 100 gold labels/);
    expect(printed).toMatch(/new manifest, seed "42"/);

    const out = join(dir, '.belay', 'datasets', 'ticket-triage');
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as { seed: string; assignments: Record<string, string> };
    const [train, validation, holdout] = await Promise.all(['train', 'validation', 'holdout'].map((s) => lines(join(out, `${s}.jsonl`))));
    expect(train!.length + validation!.length + holdout!.length).toBe(300);
    expect(holdout!.some((e) => e.labelKind === 'gold') && holdout!.some((e) => e.labelKind === 'silver')).toBe(true);
    expect(Object.keys(manifest.assignments)).toHaveLength(300);

    // The next night: more traces, no --seed. Every input keeps its split.
    const more = jsonlSink(join(dir, 'traces', 'day-2.jsonl'));
    for (let i = 200; i < 260; i++) void more.write(labelTrace({ task: 'ticket-triage', schema, input: `customer message ${i} says thing ${i * 31} happened in area ${i * 17}`, value: 'bug', origin: 'cloud', index: i }));
    await more.flush();
    stdout.mockClear();
    expect(await main(['datasets', '--traces', 'traces', '--gold', 'gold.jsonl', '--quiet'])).toBe(0);
    expect(stdout).not.toHaveBeenCalled();
    const next = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as typeof manifest;
    expect(next.seed).toBe('42');
    expect(Object.keys(next.assignments)).toHaveLength(360);
    for (const [id, split] of Object.entries(manifest.assignments)) expect(next.assignments[id]).toBe(split);

    await expect(main(['datasets', '--traces', 'traces', '--seed', '43'])).rejects.toThrow(/seed/);
  });

  it('validates its arguments', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main(['datasets', '--help'])).toBe(0);
    expect(String(stdout.mock.calls[0]![0])).toMatch(/Usage: belay datasets/);
    await expect(main(['datasets'])).rejects.toThrow(/--traces/);
    await expect(main(['datasets', '--traces', 'x', '--task', 'nope'])).rejects.toThrow(/not in/);
    await expect(main(['datasets', '--traces', 'x', '--near-duplicates', '0.1'])).rejects.toThrow(/--near-duplicates/);
  });
});
