/**
 * The promotion gate: the checks a candidate must pass on the holdout. See ADR 0007 §9.
 */
import { pairedBootstrap, scoreAt, type FixedScore, type PairedDifference, type ScoredExample } from './score.js';

export const GATE_VERSION = 1;

/** The thresholds of the gate. They live in `belay.gate.json`, which the loop cannot write. */
export interface GateConfig {
  version: typeof GATE_VERSION;
  /** Accuracy may be lower than the baseline's by at most this (lower bound of a paired 95% interval). */
  accuracyMargin: number;
  /** Local share must rise by at least this, or stay equal with a smaller prompt. */
  minLocalShareGain: number;
  /** No label's recall may drop by more than this. */
  maxRecallDrop: number;
  /** The calibration error may rise by at most this. */
  calibrationErrorMargin: number;
  /** The 95th percentile latency may rise by at most this share, */
  maxLatencyIncrease: number;
  /** plus this many milliseconds, so that timer noise on fast runners does not fail a candidate. */
  latencySlackMs: number;
  /** The largest prompt, context, rules and examples together, in characters. */
  maxContextChars: number;
  /** Below this many gold labels on the holdout, the gate measures agreement with the cloud and says so. */
  minGold: number;
  resamples: number;
}

export const DEFAULT_GATE: GateConfig = {
  version: GATE_VERSION,
  accuracyMargin: 0.01,
  minLocalShareGain: 0.03,
  maxRecallDrop: 0.05,
  calibrationErrorMargin: 0.01,
  maxLatencyIncrease: 0.1,
  latencySlackMs: 5,
  maxContextChars: 2000,
  minGold: 100,
  resamples: 1000,
};

export function parseGateConfig(value: unknown): GateConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('gate config is not an object');
  const v = value as Record<string, unknown>;
  if (v['version'] !== GATE_VERSION) throw new Error(`unsupported gate config version ${JSON.stringify(v['version'])}`);
  const gate = { ...DEFAULT_GATE };
  for (const key of Object.keys(v)) {
    if (key === 'version') continue;
    if (!Object.hasOwn(DEFAULT_GATE, key)) throw new Error(`gate config has an unknown field "${key}"`);
    const n = v[key];
    if (typeof n !== 'number' || !(n >= 0) || !Number.isFinite(n)) throw new Error(`gate config: ${key} must be a number of at least 0`);
    (gate as unknown as Record<string, number>)[key] = n;
  }
  return gate;
}

export interface GateSide {
  examples: readonly ScoredExample[];
  /** Fitted on validation, never on the holdout. */
  threshold: number | null;
  /** `contextSize()` of the config. */
  contextChars: number;
}

export interface GateCheck {
  name: 'accuracy' | 'local-share' | 'recall' | 'calibration' | 'latency' | 'prompt-size';
  passed: boolean;
  /** `true` when the check could not be made (e.g. no latency was measured) and was let through. */
  skipped?: boolean;
  detail: string;
}

export interface GateResult {
  passed: boolean;
  /** `gold`: accuracy against gold labels. `cloud-agreement`: too few gold labels to say more. */
  basis: 'gold' | 'cloud-agreement';
  checks: GateCheck[];
  baseline: FixedScore;
  candidate: FixedScore;
  difference: PairedDifference;
}

const pct = (v: number, d = 1): string => `${(v * 100).toFixed(d)}%`;
const points = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} points`;

/** Runs every check. A candidate ships only if all of them pass. */
export function runGate(baseline: GateSide, candidate: GateSide, gate: GateConfig, options: { seed?: string | number } = {}): GateResult {
  const b = scoreAt(baseline.examples, baseline.threshold);
  const c = scoreAt(candidate.examples, candidate.threshold);
  const difference = pairedBootstrap(baseline, candidate, { resamples: gate.resamples, ...(options.seed !== undefined ? { seed: options.seed } : {}) });
  const checks: GateCheck[] = [];
  const eps = 1e-9;

  checks.push({
    name: 'accuracy',
    passed: difference.accuracyInterval[0] >= -gate.accuracyMargin - eps,
    detail: `${pct(c.accuracy)} vs ${pct(b.accuracy)} (${points(difference.accuracy)}, 95% CI ${points(difference.accuracyInterval[0])} to ${points(difference.accuracyInterval[1])}); may not be lower by more than ${pct(gate.accuracyMargin, 0)}`,
  });

  const gained = difference.localShare >= gate.minLocalShareGain - eps;
  const equalAndSmaller = difference.localShare >= -0.005 && candidate.contextChars < baseline.contextChars;
  checks.push({
    name: 'local-share',
    passed: gained || equalAndSmaller,
    detail: `${pct(c.localShare)} vs ${pct(b.localShare)} (${points(difference.localShare)}, 95% CI ${points(difference.localShareInterval[0])} to ${points(difference.localShareInterval[1])}); needs ${points(gate.minLocalShareGain)}, or no loss with a smaller prompt${equalAndSmaller && !gained ? ' (met: smaller prompt)' : ''}`,
  });

  const drops = Object.keys(b.recall)
    .map((label) => ({ label, drop: b.recall[label]! - (c.recall[label] ?? 0) }))
    .sort((x, y) => y.drop - x.drop);
  const worst = drops[0];
  checks.push({
    name: 'recall',
    passed: !worst || worst.drop <= gate.maxRecallDrop + eps,
    ...(worst ? {} : { skipped: true }),
    detail: worst ? `largest drop: "${worst.label}" ${points(-worst.drop)}; no label may drop by more than ${pct(gate.maxRecallDrop, 0)}` : 'no labels to compare',
  });

  const calibrated = b.calibrationError !== null && c.calibrationError !== null;
  checks.push({
    name: 'calibration',
    passed: !calibrated || c.calibrationError! <= b.calibrationError! + gate.calibrationErrorMargin + eps,
    ...(calibrated ? {} : { skipped: true }),
    detail: calibrated ? `calibration error ${c.calibrationError!.toFixed(3)} vs ${b.calibrationError!.toFixed(3)}; may rise by at most ${gate.calibrationErrorMargin}` : 'no local answers to measure',
  });

  const timed = b.latencyP95Ms !== null && c.latencyP95Ms !== null;
  checks.push({
    name: 'latency',
    passed: !timed || c.latencyP95Ms! <= b.latencyP95Ms! * (1 + gate.maxLatencyIncrease) + gate.latencySlackMs + eps,
    ...(timed ? {} : { skipped: true }),
    detail: timed ? `p95 ${c.latencyP95Ms!.toFixed(0)} ms vs ${b.latencyP95Ms!.toFixed(0)} ms; may be at most ${pct(gate.maxLatencyIncrease, 0)} (plus ${gate.latencySlackMs} ms) slower` : 'latency was not measured',
  });

  checks.push({
    name: 'prompt-size',
    passed: candidate.contextChars <= gate.maxContextChars,
    detail: `${candidate.contextChars} characters (baseline ${baseline.contextChars}); at most ${gate.maxContextChars}`,
  });

  return { passed: checks.every((check) => check.passed), basis: c.gold >= gate.minGold ? 'gold' : 'cloud-agreement', checks, baseline: b, candidate: c, difference };
}
