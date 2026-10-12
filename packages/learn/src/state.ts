import { BelayError } from '@swissspidy/belay-core';
import type { CalibrationPair } from './calibrator.js';

export const STATE_VERSION = 1;

/**
 * A snapshot of what a learned classifier learned for one task (`exportState()`): its learned
 * examples as int8 embeddings, never as text, and its calibration record. JSON-serializable, so it
 * can be downloaded, uploaded to your server, or imported on another device with
 * `importState()`. The softmax head is not included: it is retrained from the examples.
 */
export interface LearnedState {
  kind: 'belay-learn-state';
  version: 1;
  task: string;
  /** `schemaFingerprint()` of the task schema. */
  schemaFingerprint: string;
  /** `Embedder.id` of the model that made the embeddings. */
  embedder: string;
  createdAt: string;
  examples: { id: string; label: string; source: 'cloud' | 'feedback'; createdAt: number; embedding: string }[];
  pairs: { knn: CalibrationPair[]; softmax: CalibrationPair[] };
}

const isPair = (p: unknown): p is CalibrationPair => {
  if (!p || typeof p !== 'object') return false;
  const { score, correct, weight } = p as CalibrationPair;
  return Number.isFinite(score) && typeof correct === 'boolean' && (weight === undefined || (Number.isFinite(weight) && weight > 0));
};

/** Checks a parsed snapshot's shape. Throws `BelayError('invalid-task')`. */
export function parseLearnedState(value: unknown): LearnedState {
  const s = value as LearnedState;
  const ok =
    !!s &&
    typeof s === 'object' &&
    s.kind === 'belay-learn-state' &&
    s.version === STATE_VERSION &&
    typeof s.task === 'string' &&
    typeof s.schemaFingerprint === 'string' &&
    typeof s.embedder === 'string' &&
    Array.isArray(s.examples) &&
    s.examples.every(
      (e) =>
        e &&
        typeof e.id === 'string' &&
        typeof e.label === 'string' &&
        (e.source === 'cloud' || e.source === 'feedback') &&
        typeof e.createdAt === 'number' &&
        typeof e.embedding === 'string' &&
        e.embedding.length > 0,
    ) &&
    !!s.pairs &&
    Array.isArray(s.pairs.knn) &&
    Array.isArray(s.pairs.softmax) &&
    s.pairs.knn.every(isPair) &&
    s.pairs.softmax.every(isPair);
  if (!ok) throw new BelayError('invalid-task', `not a Belay learned-classifier snapshot (version ${STATE_VERSION})`);
  return s;
}
