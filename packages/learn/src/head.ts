import { dot, softmaxInPlace } from './vector.js';

/** One training example of a head: a unit embedding, a label index and a weight. */
export interface HeadExample {
  embedding: Float32Array;
  label: number;
  weight: number;
}

/**
 * k-nearest neighbors: the top `k` examples by cosine similarity vote with weight
 * `weight · exp(similarity / temperature)`. Returns a distribution over `labels` labels.
 * Works from the first example, so it is the head while there is little data.
 */
export function knnPredict(
  examples: readonly HeadExample[],
  v: Float32Array,
  labels: number,
  options: { k: number; temperature: number },
): Float64Array {
  const k = Math.min(options.k, examples.length);
  // Partial selection of the top k by similarity: k is small, so insertion into a sorted array.
  const topSim: number[] = [];
  const topIdx: number[] = [];
  for (let i = 0; i < examples.length; i++) {
    const s = dot(examples[i]!.embedding, v);
    if (topSim.length === k && s <= topSim[k - 1]!) continue;
    let j = topSim.length === k ? k - 1 : topSim.length;
    while (j > 0 && topSim[j - 1]! < s) {
      topSim[j] = topSim[j - 1]!;
      topIdx[j] = topIdx[j - 1]!;
      j--;
    }
    topSim[j] = s;
    topIdx[j] = i;
  }
  const p = new Float64Array(labels);
  if (k === 0) return p.fill(1 / labels);
  const best = topSim[0]!;
  let total = 0;
  for (let j = 0; j < topSim.length; j++) {
    const e = examples[topIdx[j]!]!;
    // Shifted by the best similarity so exp() cannot overflow at small temperatures.
    const w = e.weight * Math.exp((topSim[j]! - best) / options.temperature);
    p[e.label]! += w;
    total += w;
  }
  for (let i = 0; i < labels; i++) p[i]! /= total;
  return p;
}

/** A multinomial logistic regression (softmax) layer: `labels × dimensions` weights and a bias. */
export interface SoftmaxModel {
  labels: number;
  dimensions: number;
  /** Row-major: `weights[label * dimensions + d]`. */
  weights: Float64Array;
  bias: Float64Array;
}

export function softmaxPredict(model: SoftmaxModel, v: Float32Array): Float64Array {
  const { labels, dimensions, weights, bias } = model;
  const z = new Float64Array(labels);
  for (let k = 0; k < labels; k++) {
    let a = bias[k]!;
    const row = k * dimensions;
    for (let d = 0; d < dimensions; d++) a += weights[row + d]! * v[d]!;
    z[k] = a;
  }
  return softmaxInPlace(z);
}

export interface SoftmaxTrainOptions {
  epochs: number;
  learningRate?: number;
  /** L2 penalty on the weights. */
  l2?: number;
  /** Starts from these weights (a previous fit) instead of zeros. */
  init?: SoftmaxModel;
  /** Called between epochs; awaiting it lets a page stay responsive while a head trains. */
  yieldEvery?: () => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Fits a softmax layer with full-batch Adam on weighted cross-entropy. Small enough for the main
 * thread: a few thousand 384-d examples and a handful of labels take well under a second.
 */
export async function softmaxTrain(
  examples: readonly HeadExample[],
  labels: number,
  dimensions: number,
  options: SoftmaxTrainOptions,
): Promise<SoftmaxModel> {
  const lr = options.learningRate ?? 0.05;
  const l2 = options.l2 ?? 1e-3;
  const weights = options.init ? Float64Array.from(options.init.weights) : new Float64Array(labels * dimensions);
  const bias = options.init ? Float64Array.from(options.init.bias) : new Float64Array(labels);
  const model: SoftmaxModel = { labels, dimensions, weights, bias };
  const mW = new Float64Array(weights.length);
  const vW = new Float64Array(weights.length);
  const mB = new Float64Array(labels);
  const vB = new Float64Array(labels);
  const gW = new Float64Array(weights.length);
  const gB = new Float64Array(labels);
  const b1 = 0.9;
  const b2 = 0.999;
  let totalWeight = 0;
  for (const e of examples) totalWeight += e.weight;
  if (totalWeight === 0) return model;

  for (let epoch = 1; epoch <= options.epochs; epoch++) {
    options.signal?.throwIfAborted();
    gW.fill(0);
    gB.fill(0);
    for (const e of examples) {
      const p = softmaxPredict(model, e.embedding);
      p[e.label]! -= 1;
      for (let k = 0; k < labels; k++) {
        const g = p[k]! * e.weight;
        if (g === 0) continue;
        gB[k]! += g;
        const row = k * dimensions;
        for (let d = 0; d < dimensions; d++) gW[row + d]! += g * e.embedding[d]!;
      }
    }
    const c1 = 1 - b1 ** epoch;
    const c2 = 1 - b2 ** epoch;
    for (let j = 0; j < weights.length; j++) {
      const g = gW[j]! / totalWeight + l2 * weights[j]!;
      mW[j] = b1 * mW[j]! + (1 - b1) * g;
      vW[j] = b2 * vW[j]! + (1 - b2) * g * g;
      weights[j]! -= (lr * (mW[j]! / c1)) / (Math.sqrt(vW[j]! / c2) + 1e-8);
    }
    for (let k = 0; k < labels; k++) {
      const g = gB[k]! / totalWeight;
      mB[k] = b1 * mB[k]! + (1 - b1) * g;
      vB[k] = b2 * vB[k]! + (1 - b2) * g * g;
      bias[k]! -= (lr * (mB[k]! / c1)) / (Math.sqrt(vB[k]! / c2) + 1e-8);
    }
    if (options.yieldEvery) await options.yieldEvery();
  }
  return model;
}
