import type { ProbabilityEntry } from './types.js';

/** Probability of the top option: the confidence signal for classifier tasks. */
export function topProbability(probabilities: readonly ProbabilityEntry[]): number {
  let top = 0;
  for (const p of probabilities) if (p.probability > top) top = p.probability;
  return clamp01(top);
}

export interface ConfidenceSignals {
  /** Whether the output passed schema validation. */
  valid: boolean;
  /** Confidence reported by the local runner itself, if any. */
  runner?: number | undefined;
  /** P(correct) from the classifier-as-judge, if any. */
  judge?: number | undefined;
}

/**
 * Combines the signals into one confidence (ADR 0001, "Confidence signal"):
 *
 * - schema validation is a hard gate: an invalid output has confidence 0;
 * - with only one of `runner` / `judge`, that value is the confidence;
 * - with both, the minimum (the more pessimistic signal wins);
 * - with neither, `undefined`: the task cannot decide and reports a configuration error.
 */
export function combineConfidence(signals: ConfidenceSignals): number | undefined {
  if (!signals.valid) return 0;
  const values = [signals.runner, signals.judge].filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return undefined;
  return clamp01(Math.min(...values));
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
