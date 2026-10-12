import { BelayError } from './errors.js';
import type { CalibrationFile } from './types.js';

export interface CostAwareThresholdOptions {
  /** Cost of one wrong answer, in the same unit as `cloudCost` (e.g. USD of support time). */
  errorCost: number;
  /** Cost of one cloud call. Defaults to the calibration file's `cost.cloudPerRun`. */
  cloudCost?: number;
  /** The cloud model's accuracy on your task, in (0, 1]. Defaults to the calibration file's `expected.cloudAccuracy`, else 1. */
  cloudAccuracy?: number;
  /** A calibration file to read `cloudCost` and `cloudAccuracy` from. */
  calibration?: CalibrationFile;
  /**
   * What the local confidence is a probability of:
   *
   * - `'cloud'` (default): agreeing with the cloud. A runner that learns from the cloud's answers
   *   (`@swissspidy/belay-learn`) can only be calibrated on those.
   * - `'labels'`: being right, for a runner calibrated on labeled data (`belay calibrate`).
   */
  calibratedAgainst?: 'cloud' | 'labels';
}

/**
 * The threshold that minimizes expected cost, for a local runner whose confidence is calibrated:
 * Chow's reject rule applied to a cascade. Escalating costs `cloudCost + (1 − cloudAccuracy) ×
 * errorCost` in expectation. Answering locally costs `(1 − P(right)) × errorCost`, where P(right)
 * depends on what the confidence p measures:
 *
 * - against labels, P(right) = p, so accept iff `p ≥ cloudAccuracy − cloudCost / errorCost`;
 * - against the cloud, count a local answer as right only when it agrees with a right cloud,
 *   P(right) ≈ p × cloudAccuracy, so accept iff `p ≥ 1 − cloudCost / (cloudAccuracy × errorCost)`
 *   (conservative: a local answer that disagrees with a wrong cloud can still be right).
 *
 * Both are clamped to [0, 1] and agree when the cloud is always right. A wrong answer that costs
 * 100× a cloud call gives 0.99 against an always-right cloud: each point of local confidence has to
 * be paid for by the call it saves.
 */
export function costAwareThreshold(options: CostAwareThresholdOptions): number {
  const { errorCost, calibration, calibratedAgainst = 'cloud' } = options;
  const cloudCost = options.cloudCost ?? calibration?.cost?.cloudPerRun;
  const cloudAccuracy = options.cloudAccuracy ?? calibration?.expected.cloudAccuracy ?? 1;
  if (!(errorCost > 0 && Number.isFinite(errorCost))) throw new BelayError('invalid-task', 'costAwareThreshold: errorCost must be a finite number > 0');
  if (cloudCost === undefined || !(cloudCost >= 0 && Number.isFinite(cloudCost))) {
    throw new BelayError('invalid-task', 'costAwareThreshold: cloudCost must be a finite number ≥ 0 (or pass a calibration file with cost.cloudPerRun)');
  }
  if (!(cloudAccuracy > 0 && cloudAccuracy <= 1)) throw new BelayError('invalid-task', 'costAwareThreshold: cloudAccuracy must be in (0, 1]');
  if (calibratedAgainst !== 'cloud' && calibratedAgainst !== 'labels') {
    throw new BelayError('invalid-task', 'costAwareThreshold: calibratedAgainst must be "cloud" or "labels"');
  }
  const threshold = calibratedAgainst === 'labels' ? cloudAccuracy - cloudCost / errorCost : 1 - cloudCost / (cloudAccuracy * errorCost);
  return Math.min(1, Math.max(0, threshold));
}
