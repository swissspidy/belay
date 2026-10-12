import { describe, expect, it } from 'vitest';
import { applyPlatt, decodeInt8, dot, encodeInt8, fitPlatt, knnPredict, normalize, softmaxPredict, softmaxTrain, type HeadExample } from '../src/index.js';
import { rng } from './helpers.js';

function clusters(n: number, labels: number, dimensions: number, noise: number, seed: number): HeadExample[] {
  const random = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const label = i % labels;
    const v = new Float32Array(dimensions);
    v[label] = 1;
    for (let d = 0; d < dimensions; d++) v[d]! += (random() - 0.5) * 2 * noise;
    return { embedding: normalize(v), label, weight: 1 };
  });
}

describe('vectors', () => {
  it('round-trips unit vectors through int8 within 0.01 cosine', () => {
    for (const e of clusters(20, 4, 384, 0.5, 1)) {
      const back = decodeInt8(encodeInt8(e.embedding));
      expect(back).toHaveLength(384);
      expect(dot(back, e.embedding)).toBeGreaterThan(0.99);
    }
  });

  it('leaves a zero vector alone', () => {
    expect([...normalize(new Float32Array(3))]).toEqual([0, 0, 0]);
  });
});

describe('knnPredict', () => {
  it('votes by similarity among the k nearest', () => {
    const train = clusters(40, 4, 16, 0.2, 2);
    const test = clusters(40, 4, 16, 0.2, 3);
    let right = 0;
    for (const t of test) {
      const p = knnPredict(train, t.embedding, 4, { k: 5, temperature: 0.1 });
      expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      if (p.indexOf(Math.max(...p)) === t.label) right++;
    }
    expect(right).toBeGreaterThanOrEqual(38);
  });

  it('weights votes by example weight and handles k larger than the data', () => {
    const a = { embedding: normalize(Float32Array.of(1, 0)), label: 0, weight: 1 };
    const b = { embedding: normalize(Float32Array.of(1, 0.01)), label: 1, weight: 3 };
    const p = knnPredict([a, b], normalize(Float32Array.of(1, 0.005)), 2, { k: 10, temperature: 0.1 });
    expect(p[1]).toBeGreaterThan(0.7);
  });

  it('is uniform without examples and stable at tiny temperatures', () => {
    expect([...knnPredict([], Float32Array.of(1), 4, { k: 3, temperature: 0.1 })]).toEqual([0.25, 0.25, 0.25, 0.25]);
    const p = knnPredict(clusters(10, 2, 8, 0.3, 4), normalize(Float32Array.of(1, 0, 0, 0, 0, 0, 0, 0)), 2, { k: 5, temperature: 1e-4 });
    expect(p.every(Number.isFinite)).toBe(true);
  });
});

describe('softmaxTrain', () => {
  it('learns separable clusters, and a warm start continues from the previous fit', async () => {
    const train = clusters(80, 4, 16, 0.4, 5);
    const test = clusters(80, 4, 16, 0.4, 6);
    const model = await softmaxTrain(train, 4, 16, { epochs: 100 });
    const accuracy = (m: typeof model) => test.filter((t) => { const p = softmaxPredict(m, t.embedding); return p.indexOf(Math.max(...p)) === t.label; }).length / test.length;
    expect(accuracy(model)).toBeGreaterThan(0.95);
    const warm = await softmaxTrain(train, 4, 16, { epochs: 5, init: model });
    expect(accuracy(warm)).toBeGreaterThan(0.95);
    expect(warm.weights).not.toBe(model.weights);
  });

  it('honors an abort signal and returns zeros without weight', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(softmaxTrain(clusters(4, 2, 4, 0.1, 7), 2, 4, { epochs: 10, signal: controller.signal })).rejects.toThrow();
    const empty = await softmaxTrain([], 2, 4, { epochs: 10 });
    expect([...empty.weights].every((w) => w === 0)).toBe(true);
  });
});

describe('fitPlatt', () => {
  it('recovers a calibrated mapping from scores whose accuracy is known', () => {
    const random = rng(8);
    // True P(correct) = score², so a raw score of 0.9 is right 81% of the time.
    const pairs = Array.from({ length: 4000 }, () => {
      const score = 0.5 + random() * 0.5;
      return { score, correct: random() < score * score };
    });
    const scaling = fitPlatt(pairs);
    for (const s of [0.6, 0.75, 0.9]) expect(applyPlatt(scaling, s)).toBeCloseTo(s * s, 1);
    expect(scaling.n).toBe(4000);
  });

  it('never reaches 1 on a run of right answers, or 0 on wrong ones', () => {
    const right = fitPlatt(Array.from({ length: 30 }, () => ({ score: 0.99, correct: true })));
    expect(applyPlatt(right, 0.99)).toBeLessThan(0.99);
    expect(applyPlatt(right, 0.99)).toBeGreaterThan(0.9);
    const wrong = fitPlatt(Array.from({ length: 30 }, () => ({ score: 0.99, correct: false })));
    expect(applyPlatt(wrong, 0.99)).toBeGreaterThan(0);
    expect(applyPlatt(wrong, 0.99)).toBeLessThan(0.1);
  });

  it('stays finite on degenerate input (one score, extremes, empty)', () => {
    for (const pairs of [
      [],
      Array.from({ length: 50 }, (_, i) => ({ score: 1, correct: i % 2 === 0 })),
      Array.from({ length: 50 }, (_, i) => ({ score: i % 2 ? 0 : 1, correct: i % 3 === 0 })),
    ]) {
      const s = fitPlatt(pairs);
      expect(Number.isFinite(s.a) && Number.isFinite(s.b)).toBe(true);
      expect(applyPlatt(s, 0.7)).toBeGreaterThanOrEqual(0);
    }
  });

  it('with a half-life, follows a head that starts going wrong', () => {
    // 200 right answers, then 30 wrong ones at the same score: drift.
    const pairs = [
      ...Array.from({ length: 200 }, () => ({ score: 0.95, correct: true })),
      ...Array.from({ length: 30 }, () => ({ score: 0.95, correct: false })),
    ];
    const flat = applyPlatt(fitPlatt(pairs), 0.95);
    const recent = applyPlatt(fitPlatt(pairs, { halfLife: 20 }), 0.95);
    expect(flat).toBeGreaterThan(0.8);
    expect(recent).toBeLessThan(0.5);
  });

  it('maps an overconfident head down', () => {
    // Scores near 1, right only 60% of the time (what content moderation looks like).
    const random = rng(9);
    const pairs = Array.from({ length: 150 }, () => ({ score: 0.95 + random() * 0.05, correct: random() < 0.6 }));
    expect(applyPlatt(fitPlatt(pairs), 0.99)).toBeLessThan(0.75);
  });
});
