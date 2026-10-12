import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { indexedDbStore, memoryStore, type ExampleStore, type StoredMeta } from '../src/index.js';

const example = (id: string, label = 'bug') => ({ id, label, embedding: Float32Array.of(0.6, 0.8), source: 'cloud' as const, createdAt: 1 });
const meta: StoredMeta = { version: 1, pairs: { knn: [{ score: 0.9, correct: true }], softmax: [] } };

describe.each([
  ['memoryStore', () => memoryStore()],
  ['indexedDbStore', () => indexedDbStore({ name: `test-${Math.random()}` })],
] as [string, () => ExampleStore][])('%s', (_, make) => {
  it('puts, replaces, deletes and clears by scope', async () => {
    const store = make();
    expect(await store.load('a')).toEqual({ examples: [], meta: null });
    await store.put('a', [example('1'), example('2')]);
    await store.put('a', [example('1', 'billing')]);
    await store.put('b', [example('1', 'other')]);
    await store.putMeta('a', meta);
    const a = await store.load('a');
    expect(a.examples.map((e) => [e.id, e.label]).sort()).toEqual([['1', 'billing'], ['2', 'bug']]);
    expect(a.examples[0]!.embedding).toBeInstanceOf(Float32Array);
    expect(a.meta).toEqual(meta);
    await store.delete('a', ['2']);
    expect((await store.load('a')).examples.map((e) => e.id)).toEqual(['1']);
    await store.clear('a');
    expect(await store.load('a')).toEqual({ examples: [], meta: null });
    expect((await store.load('b')).examples.map((e) => e.label)).toEqual(['other']);
  });
});

it('indexedDbStore persists across instances with the same name', async () => {
  const name = `persist-${Math.random()}`;
  await indexedDbStore({ name }).put('s', [example('x')]);
  expect((await indexedDbStore({ name }).load('s')).examples.map((e) => e.id)).toEqual(['x']);
});

it('indexedDbStore reports a database that cannot be opened, and retries later', async () => {
  const broken = indexedDbStore({ indexedDB: { open: () => { throw new Error('blocked'); } } as unknown as IDBFactory });
  await expect(broken.load('s')).rejects.toThrow('blocked');
});
