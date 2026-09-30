import { BelayError } from './errors.js';
import type { CalibrationFile } from './types.js';

export const CALIBRATION_VERSION = 1;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isProb = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 1;
/** A threshold above 1 keeps nothing local: every run escalates. */
const isThreshold = (v: unknown): v is number => isNum(v) && v >= 0;

/**
 * Validates an unknown value as a v1 calibration file. When `task` is given, also checks
 * that the file belongs to that task. Throws `BelayError('invalid-calibration')`.
 */
export function parseCalibration(data: unknown, task?: string): CalibrationFile {
  const fail = (msg: string): never => {
    throw new BelayError('invalid-calibration', `Invalid calibration file: ${msg}`);
  };
  if (!data || typeof data !== 'object') fail('not an object');
  const c = data as Partial<CalibrationFile>;
  if (c.version !== CALIBRATION_VERSION) fail(`unsupported version ${String(c.version)}`);
  if (typeof c.task !== 'string') fail('missing task');
  if (task !== undefined && c.task !== task) fail(`file is for task "${c.task}", not "${task}"`);
  if (typeof c.schemaFingerprint !== 'string') fail('missing schemaFingerprint');
  if (!isThreshold(c.threshold)) fail('threshold must be a number ≥ 0');
  if (c.thresholds !== undefined) {
    if (typeof c.thresholds !== 'object' || c.thresholds === null) fail('thresholds must be an object');
    for (const [label, t] of Object.entries(c.thresholds as object)) {
      if (!isThreshold(t)) fail(`thresholds["${label}"] must be a number ≥ 0`);
    }
  }
  if (!c.expected || !isProb(c.expected.localShare) || !isProb(c.expected.accuracy)) {
    fail('expected.accuracy and expected.localShare must be numbers in [0, 1]');
  }
  if (!Array.isArray(c.curve)) fail('curve must be an array');
  if (!c.confidenceHistogram || !Array.isArray(c.confidenceHistogram.edges) || !Array.isArray(c.confidenceHistogram.counts)) {
    fail('confidenceHistogram must have edges and counts');
  } else if (c.confidenceHistogram.edges.length !== c.confidenceHistogram.counts.length + 1) {
    fail('confidenceHistogram.edges must have one more entry than counts');
  }
  return c as CalibrationFile;
}

/** Threshold for a local top label: the per-label override if present, else the global one. */
export function thresholdFor(calibration: Pick<CalibrationFile, 'threshold' | 'thresholds'>, label?: string): number {
  if (label !== undefined && calibration.thresholds && Object.hasOwn(calibration.thresholds, label)) {
    return calibration.thresholds[label]!;
  }
  return calibration.threshold;
}

export async function loadCalibration(
  source: CalibrationFile | string | URL | (() => Promise<CalibrationFile>),
  task?: string,
): Promise<CalibrationFile> {
  if (typeof source === 'function') return parseCalibration(await source(), task);
  if (typeof source === 'string' || source instanceof URL) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new BelayError('invalid-calibration', `Failed to fetch calibration ${String(source)}: HTTP ${res.status}`);
    }
    return parseCalibration(await res.json(), task);
  }
  return parseCalibration(source, task);
}
