import type { Availability } from '@swissspidy/belay-core';
import type { Embedder } from '../src/index.js';

export const triageSchema = {
  type: 'categorical',
  options: ['bug', 'billing', 'feature', 'other'],
} as const;

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * Embeds "<topic> <anything>" near the topic's axis, with noise derived from the whole text, so
 * inputs about one topic cluster together. Unknown topics land on a separate axis.
 */
export function fakeEmbedder(topics: readonly string[], options: { dimensions?: number; noise?: number; availability?: Availability } = {}) {
  const dimensions = options.dimensions ?? 16;
  const noise = options.noise ?? 0.3;
  let state: Availability = options.availability ?? 'available';
  const embedder = {
    id: 'fake-embedder',
    calls: 0,
    availability: async () => state,
    prepare: async () => {
      state = 'available';
    },
    embed: async (texts: readonly string[]) => {
      if (state !== 'available') throw new Error('not loaded');
      embedder.calls += texts.length;
      return texts.map((text) => {
        const topic = topics.indexOf(text.split(' ')[0]!);
        const random = rng(hash(text));
        const v = new Float32Array(dimensions);
        v[topic >= 0 ? topic : dimensions - 1] = 1;
        for (let i = 0; i < dimensions; i++) v[i]! += (random() - 0.5) * 2 * noise;
        let n = 0;
        for (const x of v) n += x * x;
        return v.map((x) => x / Math.sqrt(n));
      });
    },
  };
  return embedder satisfies Embedder;
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
