import { describe, expect, it } from 'vitest';
import { score, type ScoredExample } from '../src/index.js';

const ex = (id: string, confidence: number | null, correct: boolean, extra: Partial<ScoredExample> = {}): ScoredExample => ({
  id,
  weight: 1,
  labelKind: 'silver',
  local: confidence === null ? null : { confidence, correct },
  cloudCorrect: 1,
  ...extra,
});

/** n examples: the local answer is right when its confidence is above `wrongBelow`. */
const ramp = (n: number, wrongBelow: number): ScoredExample[] => Array.from({ length: n }, (_, i) => ex(`e${i}`, (i + 0.5) / n, (i + 0.5) / n >= wrongBelow));

describe('score', () => {
  it('finds the lowest threshold that holds the target', () => {
    // Local is wrong below 0.4. At a target of 95%, 5 of 100 wrong answers may stay local.
    const s = score(ramp(100, 0.4), { target: 0.95 });
    expect(s.targetMet).toBe(true);
    expect(s.threshold).toBeCloseTo(0.355);
    expect(s.localShare).toBeCloseTo(0.65);
    expect(s.accuracy).toBeCloseTo(0.95);
    expect(s.localAccuracy).toBeCloseTo(60 / 65);
    expect(s.cloudOnlyAccuracy).toBe(1);
    expect(s.cloudAgreement).toBeCloseTo(0.95);
    expect(s.goldAccuracy).toBeNull();
    expect(s.catchRate).toBeCloseTo(35 / 40);
    expect(s).toMatchObject({ examples: 100, gold: 0, silver: 100 });
    expect(s.localShareInterval![0]).toBeLessThanOrEqual(s.localShare);
    expect(s.localShareInterval![1]).toBeGreaterThanOrEqual(s.localShare);
    expect(s.localShareInterval![1] - s.localShareInterval![0]).toBeLessThan(0.35);
    expect(s.accuracyInterval![0]).toBeGreaterThan(0.9);
  });

  it('keeps everything local when the local side is always right, and nothing when it never is', () => {
    expect(score(ramp(50, 0), { target: 1 })).toMatchObject({ localShare: 1, threshold: 0.01, accuracy: 1, catchRate: null });
    expect(score(ramp(50, 2), { target: 1 })).toMatchObject({ localShare: 0, threshold: null, targetMet: true, localAccuracy: null, catchRate: 1 });
  });

  it('counts examples without a local answer as escalated', () => {
    const s = score([ex('a', 0.9, true), ex('b', null, false), ex('c', 0.8, true), ex('d', null, false)], { target: 1, resamples: 0 });
    expect(s).toMatchObject({ localShare: 0.5, threshold: 0.8, accuracy: 1, localShareInterval: null, accuracyInterval: null });
  });

  it('never splits equal confidences', () => {
    // Keeping both 0.7s costs too much; a threshold cannot keep only the right one.
    const s = score([ex('a', 0.9, true), ex('b', 0.7, true), ex('c', 0.7, false), ex('d', 0.5, false)], { target: 0.9, resamples: 0 });
    expect(s).toMatchObject({ threshold: 0.9, localShare: 0.25 });
  });

  it('weighs examples: one explored run stands for many confident ones', () => {
    const examples = [ex('explored', 0.95, true, { weight: 20 }), ...Array.from({ length: 20 }, (_, i) => ex(`esc${i}`, 0.3, false))];
    const s = score(examples, { target: 0.99, resamples: 0 });
    expect(s.localShare).toBeCloseTo(0.5);
    expect(score(examples.map((e) => ({ ...e, weight: 1 })), { target: 0.99, resamples: 0 }).localShare).toBeCloseTo(1 / 21);
  });

  it('gains accuracy where the local side is right and the cloud is wrong', () => {
    const examples = [
      ex('a', 0.9, true, { labelKind: 'gold', cloudCorrect: 0 }),
      ex('b', 0.8, true, { labelKind: 'gold', cloudCorrect: 1 }),
      ex('c', 0.2, false, { labelKind: 'gold', cloudCorrect: 1 }),
      ex('d', 0.1, false, { labelKind: 'gold', cloudCorrect: 0.5 }),
    ];
    const s = score(examples, { target: 0.8, resamples: 0 });
    expect(s).toMatchObject({ cloudOnlyAccuracy: 0.625, accuracy: 0.875, goldAccuracy: 0.875, cloudAgreement: null, threshold: 0.8, gold: 4 });
  });

  it('reports the most accurate threshold when the target is out of reach', () => {
    const examples = [ex('a', 0.9, true, { labelKind: 'gold', cloudCorrect: 0 }), ex('b', 0.5, false, { labelKind: 'gold', cloudCorrect: 0 })];
    expect(score(examples, { target: 0.9, resamples: 0 })).toMatchObject({ targetMet: false, threshold: 0.9, accuracy: 0.5, localShare: 0.5 });
  });

  it('gives the same intervals for the same seed, in any example order', () => {
    const examples = ramp(200, 0.3);
    const a = score(examples, { target: 0.97, seed: 'night-1' });
    expect(score(examples, { target: 0.97, seed: 'night-1' })).toEqual(a);
    expect(score(examples, { target: 0.97, seed: 'night-2' }).localShareInterval).not.toEqual(a.localShareInterval);
    expect(score([...examples].reverse(), { target: 0.97, seed: 'night-1' })).toMatchObject({ localShare: a.localShare, threshold: a.threshold });
  });

  it('validates its input', () => {
    expect(() => score([], { target: 0.9 })).toThrow(/no examples/);
    expect(() => score(ramp(3, 0), { target: 1.2 })).toThrow(/target/);
    expect(() => score([ex('a', 0.5, true, { weight: 0 })], { target: 0.9 })).toThrow(/weight/);
  });
});
