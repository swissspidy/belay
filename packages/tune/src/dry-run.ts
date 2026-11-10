import { canonicalJson, labelOf, schemaFingerprint, type TaskSchema } from '@swissspidy/belay-core';
import { evaluateLocal, type CalibrationTaskConfig, type LocalBackend, type OutputCache } from '@swissspidy/belay-calibrate';
import { score, type Score, type ScoredExample } from './score.js';
import type { SplitFile } from './split.js';

export const BASELINE_VERSION = 1;

export interface DryRunOptions {
  name: string;
  /** The task's config: its schema, context and `correct` are used. The local side is the backend. */
  config: CalibrationTaskConfig<any>;
  split: SplitFile;
  backend: LocalBackend;
  cache: OutputCache;
  /** The cascade accuracy to hold, in (0, 1]. */
  target: number;
  seed?: string | number;
  resamples?: number;
  /**
   * How often to run the examples. Runs after the first never read the output cache, so they
   * show how much the score moves between runs. Defaults to 1.
   */
  repeat?: number;
  /** Ignore cached local outputs on the first run too. */
  refresh?: boolean;
  /**
   * How often the cloud is right, for gold examples without a recorded cloud answer. Defaults to
   * its accuracy on the gold examples that have one, or 1 without any.
   */
  cloudAccuracy?: number;
  /** Runs agree when their local shares differ by at most this much. Defaults to 0.01 (1 point). */
  tolerance?: number;
  createdAt?: string;
  onProgress?: (event: { phase: 'prepare' | 'local'; done: number; total: number; run: number }) => void;
  log?: (message: string) => void;
}

/** The score of the current config, with what it was measured on. Written as `baseline.json`. */
export interface Baseline {
  version: typeof BASELINE_VERSION;
  task: string;
  schemaFingerprint: string;
  createdAt: string;
  /** Where the examples ran: the runner, and for a browser its user agent. */
  environment: { runner: string; model?: string; userAgent?: string };
  dataset: { size: number; fingerprint: string };
  seed: string;
  /** How the cloud's answers were scored on gold examples. */
  cloud: { known: number; assumed: number; assumedAccuracy: number };
  /** The first run's score. */
  score: Score;
  /** One score per run. */
  runs: Score[];
  /** Largest difference in local share between two runs. */
  spread: number;
  /** `spread` is within the tolerance. Always true for a single run. */
  stable: boolean;
  /** Examples the local runner gave no valid answer for, in the first run. */
  localFailures: number;
  /** Examples of the first run answered from the output cache. */
  cached: number;
}

function isCorrect(config: CalibrationTaskConfig<any>, schema: TaskSchema, value: unknown, expected: unknown): boolean {
  if (config.correct) return config.correct(value, expected);
  if (schema.type === 'structured') return canonicalJson(value) === canonicalJson(expected);
  return labelOf(schema, value) === labelOf(schema, expected);
}

/**
 * Scores the task's current local side on a split, without calling the cloud: the examples run
 * through the local backend (a real Chrome for browser runners) and are compared with their
 * labels. The cloud's side of the cascade comes from the traces: for a silver label the cloud's
 * answer is the label, for a gold label it is the recorded answer.
 */
export async function dryRun(options: DryRunOptions): Promise<Baseline> {
  const { name, config, split, target } = options;
  const { schema } = config;
  const repeat = options.repeat ?? 1;
  if (!(Number.isInteger(repeat) && repeat >= 1)) throw new Error('repeat must be a positive integer');
  const tolerance = options.tolerance ?? 0.01;
  const seed = String(options.seed ?? 0);

  // ---- The cloud's side, from the labels -----------------------------------
  const known = new Map<string, number>();
  for (const e of split.examples) {
    if (e.labelKind === 'gold' && 'cloud' in e) known.set(e.id, isCorrect(config, schema, e.cloud, e.label) ? 1 : 0);
  }
  const goldWithout = split.examples.filter((e) => e.labelKind === 'gold' && !known.has(e.id)).length;
  let assumedAccuracy = options.cloudAccuracy;
  if (assumedAccuracy === undefined) {
    let weight = 0;
    let right = 0;
    for (const e of split.examples) {
      if (!known.has(e.id)) continue;
      weight += e.weight;
      right += e.weight * known.get(e.id)!;
    }
    assumedAccuracy = weight > 0 ? right / weight : 1;
  }
  if (!(assumedAccuracy >= 0 && assumedAccuracy <= 1)) throw new Error('cloudAccuracy must be in [0, 1]');

  // ---- The local side, measured ---------------------------------------------
  const runs: Score[] = [];
  let environment: Baseline['environment'] | undefined;
  let localFailures = 0;
  let cached = 0;
  for (let run = 0; run < repeat; run++) {
    const evaluation = await evaluateLocal({
      name,
      config,
      dataset: split.dataset,
      backend: options.backend,
      cache: options.cache,
      ...(run > 0 || options.refresh ? { refresh: true } : {}),
      ...(options.onProgress ? { onProgress: (e) => options.onProgress!({ ...e, run }) } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
    const scored: ScoredExample[] = split.examples.map((e, i) => {
      const local = evaluation.samples[i]!.local;
      return {
        id: e.id,
        weight: e.weight,
        labelKind: e.labelKind,
        local: local ? { confidence: local.confidence, correct: local.correct } : null,
        cloudCorrect: e.labelKind === 'silver' ? 1 : (known.get(e.id) ?? assumedAccuracy!),
      };
    });
    runs.push(score(scored, { target, seed, ...(options.resamples !== undefined ? { resamples: options.resamples } : {}) }));
    if (run === 0) {
      environment = evaluation.local;
      localFailures = evaluation.samples.filter((s) => !s.local).length;
      cached = evaluation.cached;
    }
  }

  const shares = runs.map((r) => r.localShare);
  const spread = Math.max(...shares) - Math.min(...shares);
  const local = config.models?.local ?? environment!.model;
  return {
    version: BASELINE_VERSION,
    task: name,
    schemaFingerprint: schemaFingerprint(schema),
    createdAt: options.createdAt ?? new Date().toISOString(),
    environment: { runner: environment!.runner, ...(local ? { model: local } : {}), ...(environment!.userAgent ? { userAgent: environment!.userAgent } : {}) },
    dataset: { size: split.examples.length, fingerprint: split.dataset.fingerprint },
    seed,
    cloud: { known: known.size, assumed: goldWithout, assumedAccuracy },
    score: runs[0]!,
    runs,
    spread,
    stable: spread <= tolerance + 1e-12,
    localFailures,
    cached,
  };
}
