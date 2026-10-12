/**
 * One prequential observation: the head's raw score for its top label, and whether that label
 * turned out right. Recorded before the head learns the input, so it measures the head on data it
 * had not seen.
 */
export interface CalibrationPair {
  score: number;
  correct: boolean;
}

/** `P(correct) = sigmoid(a · logit(score) + b)`. */
export interface PlattScaling {
  a: number;
  b: number;
  /** How many pairs it was fitted on. */
  n: number;
}

const EPS = 1e-6;
const logit = (p: number): number => {
  const q = Math.min(1 - EPS, Math.max(EPS, p));
  return Math.log(q / (1 - q));
};
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** Applies a fitted scaling to a raw score. */
export function applyPlatt(scaling: PlattScaling, score: number): number {
  return sigmoid(scaling.a * logit(score) + scaling.b);
}

/**
 * Platt scaling of raw scores to P(correct), with Platt's smoothed targets
 * (`(n₊ + 1) / (n₊ + 2)` and `1 / (n₋ + 2)`), so a run of only right (or only wrong) answers
 * never yields a confidence of exactly 1 (or 0). A weak L2 prior pulls `(a, b)` towards the
 * identity. Fitted by Newton's method with step halving, which cannot diverge.
 */
export function fitPlatt(pairs: readonly CalibrationPair[], prior = 0.01): PlattScaling {
  const positives = pairs.filter((p) => p.correct).length;
  const tPos = (positives + 1) / (positives + 2);
  const tNeg = 1 / (pairs.length - positives + 2);
  const x = pairs.map((p) => logit(p.score));
  const t = pairs.map((p) => (p.correct ? tPos : tNeg));

  const loss = (a: number, b: number): number => {
    let l = (prior / 2) * ((a - 1) ** 2 + b * b);
    for (let i = 0; i < x.length; i++) {
      const z = a * x[i]! + b;
      // -[t log σ(z) + (1 - t) log(1 - σ(z))], written stably.
      l += Math.max(z, 0) - z * t[i]! + Math.log1p(Math.exp(-Math.abs(z)));
    }
    return l;
  };

  let a = 1;
  let b = 0;
  let current = loss(a, b);
  for (let iteration = 0; iteration < 100; iteration++) {
    let ga = prior * (a - 1);
    let gb = prior * b;
    let haa = prior;
    let hab = 0;
    let hbb = prior;
    for (let i = 0; i < x.length; i++) {
      const q = sigmoid(a * x[i]! + b);
      const g = q - t[i]!;
      const w = Math.max(q * (1 - q), 1e-12);
      ga += g * x[i]!;
      gb += g;
      haa += w * x[i]! * x[i]!;
      hab += w * x[i]!;
      hbb += w;
    }
    const det = haa * hbb - hab * hab;
    let da = (hbb * ga - hab * gb) / det;
    let db = (haa * gb - hab * ga) / det;
    if (!Number.isFinite(da) || !Number.isFinite(db)) {
      da = ga;
      db = gb;
    }
    let step = 1;
    let improved = false;
    while (step > 1e-6) {
      const na = a - step * da;
      const nb = b - step * db;
      const next = loss(na, nb);
      if (next < current) {
        a = na;
        b = nb;
        current = next;
        improved = true;
        break;
      }
      step /= 2;
    }
    if (!improved || Math.abs(step * da) + Math.abs(step * db) < 1e-9) break;
  }
  return { a, b, n: pairs.length };
}
