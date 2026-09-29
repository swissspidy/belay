import type { CalibrationCurvePoint, CalibrationFile } from '@belay/core';

/** One labeled example after both runners have seen it. */
export interface Sample {
  id: string;
  input: string;
  /** Ground-truth label (for classifier tasks, the label string; "true"/"false" for binary). */
  truth: string;
  /** Local prediction, or `null` if the local runner failed / was unavailable (always escalated). */
  local: { label: string; confidence: number; correct: boolean } | null;
  /** Cloud prediction, or `null` if the cloud runner failed (counted as wrong). */
  cloud: { label: string; correct: boolean } | null;
}

export interface AnalyzeOptions {
  /** Target cascade accuracy in [0, 1]. */
  target: number;
  /** Labels in schema order (for per-label thresholds and the confusion matrix). */
  labels?: string[];
  /** Fit per-label thresholds (see ADR 0001, Decision 4). */
  perLabel?: boolean;
  cost?: { currency: string; cloudPerRun: number };
  histogramBins?: number;
}

export interface OptionStats {
  label: string;
  /** Examples with this true label. */
  count: number;
  localAccuracy: number | null;
  cloudAccuracy: number | null;
  /** At the recommended threshold(s). */
  localShare: number;
  cascadeAccuracy: number;
  threshold: number;
}

export interface Analysis {
  threshold: number;
  thresholds: Record<string, number> | undefined;
  targetMet: boolean;
  expected: CalibrationFile['expected'];
  /** 95% Wilson score interval of the expected cascade accuracy. */
  accuracyInterval: [number, number];
  curve: CalibrationCurvePoint[];
  confidenceHistogram: CalibrationFile['confidenceHistogram'];
  confusion: NonNullable<CalibrationFile['confusion']> | undefined;
  perOption: OptionStats[];
  counts: { total: number; localFailed: number; cloudFailed: number };
  /** Local answers that were wrong but would be accepted at the recommended threshold, most confident first. */
  confidentMistakes: Sample[];
}

const EPS = 1e-12;

/**
 * The shortest decimal `t` with `lo < t <= hi`, so the threshold reads well (0.82 rather than
 * 0.8123456) and sits strictly between two observed confidences, which keeps it from
 * over-fitting to a single sample's exact score. `lo = -Infinity` yields 0.
 */
export function niceThreshold(lo: number, hi: number): number {
  if (lo < 0) return 0;
  for (let d = 1; d <= 15; d++) {
    const scale = 10 ** d;
    let t = Math.ceil(lo * scale) / scale;
    if (t <= lo) t = (Math.round(lo * scale) + 1) / scale;
    if (t > lo && t <= hi) return t;
  }
  return hi;
}

interface Evaluated {
  accuracy: number;
  localShare: number;
  localAccuracy: number | null;
}

function evaluate(samples: readonly Sample[], thresholdOf: (s: Sample) => number): Evaluated {
  let correct = 0;
  let local = 0;
  let localCorrect = 0;
  for (const s of samples) {
    if (s.local && s.local.confidence >= thresholdOf(s)) {
      local++;
      if (s.local.correct) {
        correct++;
        localCorrect++;
      }
    } else if (s.cloud?.correct) {
      correct++;
    }
  }
  const n = samples.length;
  return {
    accuracy: n ? correct / n : 0,
    localShare: n ? local / n : 0,
    localAccuracy: local ? localCorrect / local : null,
  };
}

/**
 * Candidate thresholds: 0, then one per gap between consecutive distinct local confidences,
 * then one above the maximum (if below 1). Every threshold in the same gap routes the samples
 * identically, so this set is exhaustive and deterministic.
 */
export function candidateThresholds(confidences: readonly number[]): number[] {
  const distinct = [...new Set(confidences)].sort((a, b) => a - b);
  const out = [0];
  for (let i = 0; i < distinct.length; i++) {
    const t = niceThreshold(i === 0 ? -Infinity : distinct[i - 1]!, distinct[i]!);
    if (t > out[out.length - 1]!) out.push(t);
  }
  const max = distinct[distinct.length - 1];
  if (max !== undefined && max < 1) out.push(niceThreshold(max, 1));
  return out;
}

export function wilsonInterval(successes: number, n: number, z = 1.959963984540054): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export function analyze(samples: readonly Sample[], options: AnalyzeOptions): Analysis {
  const { target, cost } = options;
  const n = samples.length;
  const confidences = samples.flatMap((s) => (s.local ? [s.local.confidence] : []));
  const candidates = candidateThresholds(confidences);
  const costPer1k = (localShare: number) =>
    cost ? Math.round((1 - localShare) * cost.cloudPerRun * 1000 * 1e6) / 1e6 : undefined;

  const curve: CalibrationCurvePoint[] = candidates.map((threshold) => {
    const e = evaluate(samples, () => threshold);
    const c = costPer1k(e.localShare);
    return { threshold, ...e, ...(c !== undefined ? { costPer1k: c } : {}) };
  });

  // Smallest threshold meeting the target maximizes local share (local share is non-increasing in t).
  let best = curve.find((p) => p.accuracy >= target - EPS);
  const targetMet = best !== undefined;
  if (!best) {
    best = curve.reduce((a, b) => (b.accuracy > a.accuracy + EPS ? b : a));
  }
  const threshold = best.threshold;

  // Per-label thresholds: greedy in label order, each lowered as far as the target allows.
  let thresholds: Record<string, number> | undefined;
  if (options.perLabel && targetMet) {
    const current: Record<string, number> = {};
    const labels = options.labels ?? [...new Set(samples.flatMap((s) => (s.local ? [s.local.label] : [])))].sort();
    const thresholdOf = (s: Sample) => (s.local && Object.hasOwn(current, s.local.label) ? current[s.local.label]! : threshold);
    for (const label of labels) {
      const own = samples.flatMap((s) => (s.local?.label === label ? [s.local.confidence] : []));
      for (const t of candidateThresholds(own)) {
        if (t >= threshold) break;
        current[label] = t;
        if (evaluate(samples, thresholdOf).accuracy >= target - EPS) break;
        delete current[label];
      }
    }
    if (Object.keys(current).length) thresholds = current;
  }

  const thresholdOf = (s: Sample) =>
    s.local && thresholds && Object.hasOwn(thresholds, s.local.label) ? thresholds[s.local.label]! : threshold;
  const final = evaluate(samples, thresholdOf);
  const cloudAnswered = samples.filter((s) => s.cloud);
  const cloudAccuracy = n ? samples.filter((s) => s.cloud?.correct).length / n : null;
  const finalCost = costPer1k(final.localShare);
  const expected: CalibrationFile['expected'] = {
    accuracy: final.accuracy,
    localShare: final.localShare,
    localAccuracy: final.localAccuracy,
    cloudAccuracy,
    ...(finalCost !== undefined ? { costPer1k: finalCost } : {}),
  };

  // Histogram of local confidences.
  const bins = options.histogramBins ?? 10;
  const edges = Array.from({ length: bins + 1 }, (_, i) => Math.round((i / bins) * 1e6) / 1e6);
  const counts = new Array<number>(bins).fill(0);
  for (const c of confidences) counts[Math.min(bins - 1, Math.floor(c * bins))]!++;

  // Confusion matrix (local predictions only).
  let confusion: Analysis['confusion'];
  const labels = options.labels;
  if (labels?.length) {
    const index = new Map(labels.map((l, i) => [l, i]));
    const matrix = labels.map(() => labels.map(() => 0));
    for (const s of samples) {
      const i = index.get(s.truth);
      const j = s.local ? index.get(s.local.label) : undefined;
      if (i !== undefined && j !== undefined) matrix[i]![j]!++;
    }
    confusion = { labels, local: matrix };
  }

  const perOption: OptionStats[] = (labels ?? [...new Set(samples.map((s) => s.truth))].sort()).map((label) => {
    const group = samples.filter((s) => s.truth === label);
    const withLocal = group.filter((s) => s.local);
    const withCloud = group.filter((s) => s.cloud);
    const e = evaluate(group, thresholdOf);
    return {
      label,
      count: group.length,
      localAccuracy: withLocal.length ? withLocal.filter((s) => s.local!.correct).length / withLocal.length : null,
      cloudAccuracy: withCloud.length ? withCloud.filter((s) => s.cloud!.correct).length / group.length : null,
      localShare: e.localShare,
      cascadeAccuracy: e.accuracy,
      threshold: thresholds?.[label] ?? threshold,
    };
  });

  const confidentMistakes = samples
    .filter((s) => s.local && !s.local.correct && s.local.confidence >= thresholdOf(s))
    .sort((a, b) => b.local!.confidence - a.local!.confidence || (a.id < b.id ? -1 : 1));

  return {
    threshold,
    thresholds,
    targetMet,
    expected,
    accuracyInterval: wilsonInterval(Math.round(final.accuracy * n), n),
    curve,
    confidenceHistogram: { edges, counts },
    confusion,
    perOption,
    counts: { total: n, localFailed: n - confidences.length, cloudFailed: n - cloudAnswered.length },
    confidentMistakes,
  };
}
