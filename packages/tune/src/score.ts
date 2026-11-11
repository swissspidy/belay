/**
 * The one metric of Belay Tune: local share at a fixed target accuracy. See ADR 0007 §8.
 */

/** One labeled example after the local runner has seen it. */
export interface ScoredExample {
  id: string;
  /** How many runs the example stands for (see `DatasetExample.weight`). */
  weight: number;
  labelKind: 'gold' | 'silver';
  /** The local answer; `null` when the runner failed or its output was invalid (always escalated). */
  local: { confidence: number; correct: boolean } | null;
  /**
   * How right the cloud's answer is: 1 or 0 when it is known, else the assumed cloud accuracy.
   * For a silver label it is 1: the label is the cloud's answer.
   */
  cloudCorrect: number;
  /** The label, for per-class recall. */
  truth?: string;
  /** Wall-clock time of the local run, when it was measured. */
  latencyMs?: number;
}

export interface ScoreOptions {
  /** The cascade accuracy to hold, in (0, 1]. */
  target: number;
  /** Seed of the bootstrap. The same seed and examples give the same intervals. */
  seed?: string | number;
  /** Bootstrap resamples for the 95% intervals. Defaults to 1000; 0 turns them off. */
  resamples?: number;
}

export interface Score {
  target: number;
  /** Whether any threshold reaches the target. If not, the threshold is the most accurate one. */
  targetMet: boolean;
  /** The lowest threshold that holds the target; `null` when every run must go to the cloud. */
  threshold: number | null;
  /** Share of runs answered on the device at that threshold: the metric. */
  localShare: number;
  /** 95% interval, with the threshold fitted again on every resample. */
  localShareInterval: [number, number] | null;
  /** Accuracy of the cascade at that threshold, against all labels. */
  accuracy: number;
  accuracyInterval: [number, number] | null;
  /** Accuracy of the answers kept on the device. */
  localAccuracy: number | null;
  /** Accuracy when every run goes to the cloud. */
  cloudOnlyAccuracy: number;
  /** The cascade's accuracy on the examples with a gold label; `null` without any. */
  goldAccuracy: number | null;
  /** The cascade's agreement with the cloud on the examples with a silver label; `null` without any. */
  cloudAgreement: number | null;
  /** Share of the local runner's mistakes that the threshold sends to the cloud. */
  catchRate: number | null;
  examples: number;
  gold: number;
  silver: number;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(seed: string | number): number {
  const text = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface Fit {
  /** How many of the examples, in order of falling confidence, stay on the device. */
  kept: number;
  met: boolean;
  share: number;
  accuracy: number;
}

/**
 * Fits the threshold: of the cut points between distinct confidences, the one that keeps the most
 * on the device while the cascade accuracy holds the target; if none does, the most accurate one.
 * `order` lists the examples with a local answer by falling confidence; `times` is how often each
 * example counts (its multiplicity in a bootstrap resample).
 */
function fit(examples: readonly ScoredExample[], order: readonly number[], times: ArrayLike<number> | null, target: number): Fit {
  let total = 0;
  let cloudRight = 0;
  for (let i = 0; i < examples.length; i++) {
    const w = examples[i]!.weight * (times ? times[i]! : 1);
    total += w;
    cloudRight += w * examples[i]!.cloudCorrect;
  }
  if (!(total > 0)) return { kept: 0, met: false, share: 0, accuracy: 0 };
  const eps = 1e-9;
  let best: Fit = { kept: 0, met: cloudRight / total >= target - eps, share: 0, accuracy: cloudRight / total };
  let keptWeight = 0;
  let gain = 0;
  for (let k = 0; k < order.length; k++) {
    const example = examples[order[k]!]!;
    const w = example.weight * (times ? times[order[k]!]! : 1);
    keptWeight += w;
    gain += w * ((example.local!.correct ? 1 : 0) - example.cloudCorrect);
    // A threshold cannot separate equal confidences.
    const next = order[k + 1];
    if (next !== undefined && examples[next]!.local!.confidence === example.local!.confidence) continue;
    const accuracy = (cloudRight + gain) / total;
    const met = accuracy >= target - eps;
    if (met ? true : !best.met && accuracy > best.accuracy + eps) {
      best = { kept: k + 1, met, share: keptWeight / total, accuracy };
    }
  }
  return best;
}

const percentile = (sorted: readonly number[], p: number): number => {
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
};

/**
 * Scores a set of examples: the lowest threshold whose cascade accuracy holds the target, the
 * local share at it, and bootstrap intervals for both.
 */
export function score(examples: readonly ScoredExample[], options: ScoreOptions): Score {
  const { target } = options;
  if (!(target > 0 && target <= 1)) throw new Error(`target must be in (0, 1], got ${String(target)}`);
  if (!examples.length) throw new Error('no examples to score');
  for (const e of examples) {
    if (!(e.weight > 0) || !Number.isFinite(e.weight)) throw new Error(`example ${e.id}: weight must be a positive number`);
  }
  const order = examples
    .map((e, i) => (e.local ? i : -1))
    .filter((i) => i >= 0)
    .sort((a, b) => examples[b]!.local!.confidence - examples[a]!.local!.confidence || (examples[a]!.id < examples[b]!.id ? -1 : 1));

  const best = fit(examples, order, null, target);
  const kept = new Set(order.slice(0, best.kept));
  const sums = { keptWeight: 0, keptRight: 0, gold: 0, goldRight: 0, silver: 0, silverRight: 0, wrong: 0, caught: 0, total: 0, cloudRight: 0 };
  let gold = 0;
  for (const [i, e] of examples.entries()) {
    const local = kept.has(i);
    const right = local ? (e.local!.correct ? 1 : 0) : e.cloudCorrect;
    sums.total += e.weight;
    sums.cloudRight += e.weight * e.cloudCorrect;
    if (local) {
      sums.keptWeight += e.weight;
      sums.keptRight += e.weight * right;
    }
    if (e.labelKind === 'gold') {
      gold++;
      sums.gold += e.weight;
      sums.goldRight += e.weight * right;
    } else {
      sums.silver += e.weight;
      sums.silverRight += e.weight * right;
    }
    if (e.local && !e.local.correct) {
      sums.wrong += e.weight;
      if (!local) sums.caught += e.weight;
    }
  }

  let localShareInterval: Score['localShareInterval'] = null;
  let accuracyInterval: Score['accuracyInterval'] = null;
  const resamples = options.resamples ?? 1000;
  if (resamples > 0) {
    const random = mulberry32(seedOf(options.seed ?? 0));
    const shares: number[] = [];
    const accuracies: number[] = [];
    const times = new Uint32Array(examples.length);
    for (let r = 0; r < resamples; r++) {
      times.fill(0);
      for (let i = 0; i < examples.length; i++) times[Math.floor(random() * examples.length)]!++;
      const f = fit(examples, order, times, target);
      shares.push(f.share);
      accuracies.push(f.accuracy);
    }
    shares.sort((a, b) => a - b);
    accuracies.sort((a, b) => a - b);
    localShareInterval = [percentile(shares, 0.025), percentile(shares, 0.975)];
    accuracyInterval = [percentile(accuracies, 0.025), percentile(accuracies, 0.975)];
  }

  return {
    target,
    targetMet: best.met,
    threshold: best.kept ? examples[order[best.kept - 1]!]!.local!.confidence : null,
    localShare: best.share,
    localShareInterval,
    accuracy: best.accuracy,
    accuracyInterval,
    localAccuracy: sums.keptWeight > 0 ? sums.keptRight / sums.keptWeight : null,
    cloudOnlyAccuracy: sums.cloudRight / sums.total,
    goldAccuracy: sums.gold > 0 ? sums.goldRight / sums.gold : null,
    cloudAgreement: sums.silver > 0 ? sums.silverRight / sums.silver : null,
    catchRate: sums.wrong > 0 ? sums.caught / sums.wrong : null,
    examples: examples.length,
    gold,
    silver: examples.length - gold,
  };
}

/** What a cascade does at a given threshold, with nothing fitted. */
export interface FixedScore {
  threshold: number | null;
  localShare: number;
  accuracy: number;
  localAccuracy: number | null;
  goldAccuracy: number | null;
  cloudAgreement: number | null;
  /** Per label: the share of its examples the cascade answers right. */
  recall: Record<string, number>;
  /** Expected calibration error of the local confidence, over ten bins. */
  calibrationError: number | null;
  /** 95th percentile of the local runs' latency, when it was measured. */
  latencyP95Ms: number | null;
  gold: number;
  examples: number;
}

const keptAt = (e: ScoredExample, threshold: number | null): boolean => threshold !== null && !!e.local && e.local.confidence >= threshold;

/** Scores examples at a threshold fitted elsewhere (`null`: everything goes to the cloud). */
export function scoreAt(examples: readonly ScoredExample[], threshold: number | null): FixedScore {
  if (!examples.length) throw new Error('no examples to score');
  const sums = { total: 0, right: 0, kept: 0, keptRight: 0, gold: 0, goldRight: 0, silver: 0, silverRight: 0 };
  const perLabel = new Map<string, { weight: number; right: number }>();
  const bins = Array.from({ length: 10 }, () => ({ weight: 0, confidence: 0, right: 0 }));
  const latencies: number[] = [];
  let gold = 0;
  for (const e of examples) {
    const local = keptAt(e, threshold);
    const right = local ? (e.local!.correct ? 1 : 0) : e.cloudCorrect;
    sums.total += e.weight;
    sums.right += e.weight * right;
    if (local) {
      sums.kept += e.weight;
      sums.keptRight += e.weight * right;
    }
    if (e.labelKind === 'gold') {
      gold++;
      sums.gold += e.weight;
      sums.goldRight += e.weight * right;
    } else {
      sums.silver += e.weight;
      sums.silverRight += e.weight * right;
    }
    if (e.truth !== undefined) {
      const entry = perLabel.get(e.truth) ?? { weight: 0, right: 0 };
      entry.weight += e.weight;
      entry.right += e.weight * right;
      perLabel.set(e.truth, entry);
    }
    if (e.local) {
      const bin = bins[Math.min(9, Math.floor(e.local.confidence * 10))]!;
      bin.weight += e.weight;
      bin.confidence += e.weight * e.local.confidence;
      bin.right += e.weight * (e.local.correct ? 1 : 0);
    }
    if (typeof e.latencyMs === 'number') latencies.push(e.latencyMs);
  }
  const binned = bins.reduce((n, b) => n + b.weight, 0);
  latencies.sort((a, b) => a - b);
  return {
    threshold,
    localShare: sums.kept / sums.total,
    accuracy: sums.right / sums.total,
    localAccuracy: sums.kept > 0 ? sums.keptRight / sums.kept : null,
    goldAccuracy: sums.gold > 0 ? sums.goldRight / sums.gold : null,
    cloudAgreement: sums.silver > 0 ? sums.silverRight / sums.silver : null,
    recall: Object.fromEntries([...perLabel].sort(([a], [b]) => (a < b ? -1 : 1)).map(([label, v]) => [label, v.right / v.weight])),
    calibrationError: binned > 0 ? bins.reduce((n, b) => n + (b.weight > 0 ? Math.abs(b.right - b.confidence) : 0), 0) / binned : null,
    latencyP95Ms: latencies.length ? percentile(latencies, 0.95) : null,
    gold,
    examples: examples.length,
  };
}

export interface PairedDifference {
  /** Candidate minus baseline, on the examples as they are. */
  accuracy: number;
  localShare: number;
  /** 95% intervals of the differences. */
  accuracyInterval: [number, number];
  localShareInterval: [number, number];
}

/**
 * A paired bootstrap of candidate minus baseline: both ran the same examples (same order), so
 * each resample draws the same examples for both, and what the two share cancels out.
 */
export function pairedBootstrap(
  baseline: { examples: readonly ScoredExample[]; threshold: number | null },
  candidate: { examples: readonly ScoredExample[]; threshold: number | null },
  options: { seed?: string | number; resamples?: number } = {},
): PairedDifference {
  const n = baseline.examples.length;
  if (n !== candidate.examples.length || baseline.examples.some((e, i) => e.id !== candidate.examples[i]!.id)) {
    throw new Error('a paired comparison needs the same examples in the same order');
  }
  const rows = baseline.examples.map((b, i) => {
    const c = candidate.examples[i]!;
    const bKept = keptAt(b, baseline.threshold);
    const cKept = keptAt(c, candidate.threshold);
    return {
      weight: b.weight,
      accuracy: (cKept ? (c.local!.correct ? 1 : 0) : c.cloudCorrect) - (bKept ? (b.local!.correct ? 1 : 0) : b.cloudCorrect),
      share: (cKept ? 1 : 0) - (bKept ? 1 : 0),
    };
  });
  const total = rows.reduce((sum, r) => sum + r.weight, 0);
  const point = { accuracy: rows.reduce((sum, r) => sum + r.weight * r.accuracy, 0) / total, share: rows.reduce((sum, r) => sum + r.weight * r.share, 0) / total };
  const resamples = options.resamples ?? 1000;
  const random = mulberry32(seedOf(options.seed ?? 0));
  const accuracies: number[] = [];
  const shares: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let weight = 0;
    let accuracy = 0;
    let share = 0;
    for (let i = 0; i < n; i++) {
      const row = rows[Math.floor(random() * n)]!;
      weight += row.weight;
      accuracy += row.weight * row.accuracy;
      share += row.weight * row.share;
    }
    accuracies.push(accuracy / weight);
    shares.push(share / weight);
  }
  accuracies.sort((a, b) => a - b);
  shares.sort((a, b) => a - b);
  const interval = (sorted: number[], fallback: number): [number, number] => (sorted.length ? [percentile(sorted, 0.025), percentile(sorted, 0.975)] : [fallback, fallback]);
  return { accuracy: point.accuracy, localShare: point.share, accuracyInterval: interval(accuracies, point.accuracy), localShareInterval: interval(shares, point.share) };
}
