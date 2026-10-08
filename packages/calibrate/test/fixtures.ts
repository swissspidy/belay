import { fnv1a, type CloudRunner, type LocalRunner } from '@swissspidy/belay-core';

export const LABELS = ['bug', 'billing', 'feature', 'other'] as const;
export const schema = { type: 'categorical', options: [...LABELS] } as const;

/** Deterministic pseudo-random number in [0, 1) derived from a string. */
export const hash01 = (s: string) => parseInt(fnv1a(s), 16) / 2 ** 32;

/** 300 labeled examples with stable ids, as JSONL. */
export function datasetJsonl(n = 300): string {
  return Array.from({ length: n }, (_, i) => {
    const label = LABELS[i % LABELS.length]!;
    return JSON.stringify({ id: `ex-${i + 1}`, input: `ticket #${i + 1} about ${label} (${hash01(String(i)).toFixed(4)})`, label });
  }).join('\n');
}

const truthOf = (input: string) => LABELS.find((l) => input.includes(`about ${l} `))!;

/**
 * A calibrated fake local model: confidence is spread over [0.3, 1), and the answer is right
 * with probability ≈ confidence (decided deterministically from the input).
 */
export function fakeLocal(): LocalRunner<any> & { calls: number } {
  const runner = {
    id: 'fake-local',
    calls: 0,
    async availability() {
      return 'available' as const;
    },
    async run(input: string) {
      runner.calls++;
      const confidence = 0.3 + 0.7 * hash01(`conf:${input}`);
      const right = hash01(`right:${input}`) < confidence;
      const truth = truthOf(input);
      const value = right ? truth : LABELS[(LABELS.indexOf(truth) + 1) % LABELS.length]!;
      return { value, confidence };
    },
  };
  return runner;
}

/** A fake cloud model that is right 94% of the time. */
export function fakeCloud(): CloudRunner<any> & { calls: number } {
  const runner = {
    id: 'fake-cloud',
    calls: 0,
    async run(request: { input: string }) {
      runner.calls++;
      const truth = truthOf(request.input);
      const right = hash01(`cloud:${request.input}`) < 0.94;
      return { value: { value: right ? truth : 'other' } };
    },
  };
  return runner;
}
