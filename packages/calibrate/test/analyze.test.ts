import { describe, expect, it } from 'vitest';
import { analyze, candidateThresholds, niceThreshold, wilsonInterval, type Sample } from '../src/index.js';

const sample = (id: number, confidence: number | null, localCorrect: boolean, cloudCorrect = true, truth = 'a', label = 'a'): Sample => ({
  id: String(id),
  input: `input ${id}`,
  truth,
  local: confidence === null ? null : { label, confidence, correct: localCorrect },
  cloud: { label: cloudCorrect ? truth : 'x', correct: cloudCorrect },
});

describe('niceThreshold', () => {
  it('returns the shortest decimal in (lo, hi]', () => {
    expect(niceThreshold(-Infinity, 0.3)).toBe(0);
    expect(niceThreshold(0.8123, 0.8457)).toBe(0.82);
    expect(niceThreshold(0.3, 0.9)).toBe(0.4);
    expect(niceThreshold(0.7, 0.8)).toBe(0.8);
    expect(niceThreshold(0.91234, 0.91235)).toBe(0.91235);
    expect(niceThreshold(0.5, 0.5000001)).toBeGreaterThan(0.5);
  });
});

describe('candidateThresholds', () => {
  it('has one threshold per routing-equivalence class', () => {
    expect(candidateThresholds([0.95, 0.4, 0.7, 0.7])).toEqual([0, 0.5, 0.8, 1]);
    expect(candidateThresholds([1, 0.5])).toEqual([0, 0.6]);
    expect(candidateThresholds([])).toEqual([0]);
  });

  it('never changes which samples stay local compared with the raw confidences', () => {
    const confs = [0.12, 0.345, 0.3451, 0.6, 0.61, 0.99];
    const candidates = candidateThresholds(confs);
    const distinct = [...new Set(confs)].sort((a, b) => a - b);
    const local = (t: number) => confs.filter((c) => c >= t).length;
    // One candidate per distinct confidence (routing exactly like it), plus "all escalate".
    expect(candidates.map(local)).toEqual([...distinct.map(local), 0]);
  });
});

describe('analyze', () => {
  // Local is right when confident, wrong when not; cloud is always right.
  const samples = [
    sample(1, 0.99, true),
    sample(2, 0.95, true),
    sample(3, 0.9, true),
    sample(4, 0.85, false),
    sample(5, 0.8, true),
    sample(6, 0.6, false),
    sample(7, 0.5, false),
    sample(8, 0.3, false),
    sample(9, null, false), // local failed
    sample(10, 0.97, true, false), // cloud would be wrong
  ];

  it('recommends the smallest threshold meeting the target', () => {
    const a = analyze(samples, { target: 0.95 });
    // In (0.85, 0.9] local answers 1, 2, 3, 10 (all right) and the cloud the rest (all right): 10/10.
    // One class lower, #4 (wrong) stays local: 9/10 < 0.95.
    expect(a.threshold).toBe(0.9);
    expect(a.targetMet).toBe(true);
    expect(a.expected).toMatchObject({ accuracy: 1, localShare: 0.4, localAccuracy: 1, cloudAccuracy: 0.9 });
    expect(a.curve.find((p) => p.threshold === 0.9)?.accuracy).toBe(1);
    expect(a.curve.find((p) => p.threshold === 0.81)?.accuracy).toBe(0.9);
  });

  it('prefers more local share when several thresholds meet the target', () => {
    const a = analyze(samples, { target: 0.9 });
    // (0.6, 0.8]: local 1-5 and 10 (#4 wrong), cloud 6-9 (right): 9/10.
    expect(a.threshold).toBe(0.7);
    expect(a.expected.localShare).toBe(0.6);
    expect(a.expected.accuracy).toBeCloseTo(0.9);
  });

  it('falls back to the most accurate threshold when the target is unreachable', () => {
    const a = analyze([sample(1, 0.9, false, false), sample(2, 0.2, false, false), sample(3, 0.5, true, false)], { target: 0.99 });
    expect(a.targetMet).toBe(false);
    expect(a.expected.accuracy).toBeCloseTo(1 / 3);
    expect(a.threshold).toBe(0);
  });

  it('computes cost, histogram, confusion and per-option stats', () => {
    const labelled = [
      sample(1, 0.95, true, true, 'a', 'a'),
      sample(2, 0.55, false, true, 'a', 'b'),
      sample(3, 0.91, true, true, 'b', 'b'),
      sample(4, 0.4, false, true, 'b', 'a'),
    ];
    const a = analyze(labelled, { target: 1, labels: ['a', 'b'], cost: { currency: 'USD', cloudPerRun: 0.002 } });
    expect(a.threshold).toBe(0.6);
    expect(a.expected.costPer1k).toBe(1);
    expect(a.curve[0]).toMatchObject({ threshold: 0, costPer1k: 0 });
    expect(a.confidenceHistogram.counts).toEqual([0, 0, 0, 0, 1, 1, 0, 0, 0, 2]);
    expect(a.confusion).toEqual({ labels: ['a', 'b'], local: [[1, 1], [1, 1]] });
    expect(a.perOption).toEqual([
      { label: 'a', count: 2, localAccuracy: 0.5, cloudAccuracy: 1, localShare: 0.5, cascadeAccuracy: 1, threshold: 0.6 },
      { label: 'b', count: 2, localAccuracy: 0.5, cloudAccuracy: 1, localShare: 0.5, cascadeAccuracy: 1, threshold: 0.6 },
    ]);
  });

  it('fits per-label thresholds that only lower the global one and keep the target', () => {
    // Label "a" is well calibrated down to 0.5; label "b" is not.
    const s = [
      sample(1, 0.95, true, true, 'a', 'a'),
      sample(2, 0.6, true, true, 'a', 'a'),
      sample(3, 0.55, true, true, 'a', 'a'),
      sample(4, 0.9, true, true, 'b', 'b'),
      sample(5, 0.7, false, true, 'b', 'b'),
      sample(6, 0.65, false, true, 'a', 'b'),
    ];
    const a = analyze(s, { target: 1, labels: ['a', 'b'], perLabel: true });
    expect(a.threshold).toBe(0.8);
    expect(a.thresholds).toEqual({ a: 0 });
    expect(a.expected).toMatchObject({ accuracy: 1, localShare: 4 / 6 });
    expect(a.perOption.find((o) => o.label === 'a')!.threshold).toBe(0);
  });

  it('lists confident mistakes, most confident first', () => {
    const a = analyze(samples, { target: 0.9 });
    expect(a.confidentMistakes.map((s) => s.id)).toEqual(['4']);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(analyze(samples, { target: 0.9, perLabel: true }))).toBe(JSON.stringify(analyze([...samples], { target: 0.9, perLabel: true })));
  });
});

describe('wilsonInterval', () => {
  it('matches reference values', () => {
    const [lo, hi] = wilsonInterval(285, 300);
    expect(lo).toBeCloseTo(0.9189, 3);
    expect(hi).toBeCloseTo(0.9693, 3);
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
  });
});
