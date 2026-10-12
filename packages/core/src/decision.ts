import { BelayError } from './errors.js';
import type { CalibrationFile } from './types.js';

export interface CostAwareThresholdOptions {
  /** Cost of one wrong answer, in the same unit as `cloudCost` (e.g. USD of support time). */
  errorCost: number;
  /** Cost of one cloud call. Defaults to the calibration file's `cost.cloudPerRun`. */
  cloudCost?: number;
  /** The cloud model's accuracy on your task, in [0, 1]. Defaults to the calibration file's `expected.cloudAccuracy`, else 1. */
  cloudAccuracy?: number;
  /** A calibration file to read `cloudCost` and `cloudAccuracy` from. */
  calibration?: CalibrationFile;
}

/**
 * The threshold that minimizes expected cost, for a local runner whose confidence is a
 * calibrated P(correct) (e.g. `@swissspidy/belay-learn`): Chow's reject rule applied to a
 * cascade. Answering locally costs `(1 - p) × errorCost` in expectation; escalating costs
 * `cloudCost + (1 - cloudAccuracy) × errorCost`. So accept locally iff
 *
 *     p ≥ cloudAccuracy − cloudCost / errorCost
 *
 * clamped to [0, 1]. A wrong answer that costs 100× a cloud call, with a 95%-accurate cloud,
 * gives 0.94: each point of local confidence below the cloud's accuracy has to be paid for by
 * the call it saves.
 */
export function costAwareThreshold(options: CostAwareThresholdOptions): number {
  const { errorCost, calibration } = options;
  const cloudCost = options.cloudCost ?? calibration?.cost?.cloudPerRun;
  const cloudAccuracy = options.cloudAccuracy ?? calibration?.expected.cloudAccuracy ?? 1;
  if (!(errorCost > 0)) throw new BelayError('invalid-task', 'costAwareThreshold: errorCost must be > 0');
  if (cloudCost === undefined || !(cloudCost >= 0)) {
    throw new BelayError('invalid-task', 'costAwareThreshold: cloudCost must be ≥ 0 (or pass a calibration file with cost.cloudPerRun)');
  }
  if (!(cloudAccuracy >= 0 && cloudAccuracy <= 1)) throw new BelayError('invalid-task', 'costAwareThreshold: cloudAccuracy must be in [0, 1]');
  return Math.min(1, Math.max(0, cloudAccuracy - cloudCost / errorCost));
}
