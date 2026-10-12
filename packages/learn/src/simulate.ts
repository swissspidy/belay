import { cloudAdapter, labelOf, parseValue, task } from '@swissspidy/belay-core';
import type { ExploreOptions, TaskSchema } from '@swissspidy/belay-core';
import { learnedClassifier, type LearnedClassifierOptions, type LearnedStats } from './classifier.js';
import { memoryStore } from './store.js';
import type { Embedder } from './embedder.js';
import type { SeedFile } from './seed.js';

export interface SimulateOptions<S extends TaskSchema> {
  /** The task name and schema your app uses. */
  name: string;
  schema: S;
  embedder: Embedder;
  /** Labeled inputs, in the order the app would see them. */
  stream: readonly { input: string; value: unknown }[];
  /**
   * Answers escalated inputs in place of the cloud. Defaults to the stream's own labels (a cloud
   * that is always right). Pass a function to model a fallible cloud.
   */
  teacher?: (input: string, truth: unknown) => unknown | Promise<unknown>;
  /** Defaults to 0.9. */
  threshold?: number;
  /** Defaults to 0.05 (uniform). */
  explore?: number | ExploreOptions;
  /** Seeds the exploration draws, for reproducible runs. Defaults to 7. */
  randomSeed?: number;
  seed?: SeedFile;
  /** Classifier options. Each simulation learns into its own `memoryStore()`, never a `store` given here. */
  classifier?: Omit<LearnedClassifierOptions, 'embedder' | 'seed' | 'store'>;
  /** Inputs per point of the learning curve. Defaults to 100. */
  window?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface SimulationSummary {
  runs: number;
  /** Share answered on the device. */
  localShare: number;
  /** Accuracy of the device's answers, against the stream's labels; null if it answered none. */
  localAccuracy: number | null;
  /** Accuracy of all answers (device and teacher). */
  accuracy: number;
  cloudCalls: number;
  explored: number;
}

export interface SimulationResult {
  all: SimulationSummary;
  /** The last three windows: after the classifier has learned. */
  last: SimulationSummary;
  curve: (SimulationSummary & { from: number })[];
  stats: LearnedStats;
}

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Streams labeled inputs through a learned classifier with the real `task()`, as an app would
 * see them, and measures how much it answers on the device and how accurately. The way to
 * evaluate a learned classifier on your own data before shipping it (`belay simulate` runs it
 * from the command line).
 */
export async function simulateLearning<S extends TaskSchema>(options: SimulateOptions<S>): Promise<SimulationResult> {
  const { name, schema, stream } = options;
  const windowSize = Math.max(1, options.window ?? 100);
  const truth = new Map<string, unknown>();
  for (const e of stream) {
    const parsed = parseValue(schema, e.value);
    if (!parsed.ok) throw new Error(`simulateLearning: "${e.input.slice(0, 40)}" has a value outside the schema`);
    if (truth.has(e.input)) throw new Error(`simulateLearning: duplicate input "${e.input.slice(0, 40)}"`);
    truth.set(e.input, parsed.value);
  }
  const teacher = options.teacher ?? ((_input: string, value: unknown) => value);
  const local = learnedClassifier({
    embedder: options.embedder,
    ...options.classifier,
    // A fresh store: a simulation must neither start from nor write to an app's learned state.
    store: memoryStore(),
    // The loop flushes after every input, so retraining needs no debounce.
    softmax: { retrainDelayMs: 0, ...options.classifier?.softmax },
    ...(options.seed ? { seed: options.seed } : {}),
  });
  const random = mulberry32(options.randomSeed ?? 7);
  const explore = options.explore ?? 0.05;
  const t = task({
    name,
    schema,
    local,
    cloud: cloudAdapter(async ({ input }) => teacher(input, truth.get(input))),
    threshold: options.threshold ?? 0.9,
    explore: typeof explore === 'number' ? { rate: explore, random } : { random, ...explore },
  });

  const rows: { local: boolean; explored: boolean; correct: boolean }[] = [];
  for (const [i, example] of stream.entries()) {
    options.signal?.throwIfAborted();
    const result = await t.run(example.input, options.signal ? { signal: options.signal } : {});
    await local.flush();
    rows.push({
      local: result.source === 'local',
      explored: result.escalationReason === 'exploration',
      correct: labelOf(schema, result.value) === labelOf(schema, truth.get(example.input)),
    });
    options.onProgress?.(i + 1, stream.length);
  }
  const summarize = (part: typeof rows): SimulationSummary => {
    const kept = part.filter((r) => r.local);
    return {
      runs: part.length,
      localShare: part.length ? kept.length / part.length : 0,
      localAccuracy: kept.length ? kept.filter((r) => r.correct).length / kept.length : null,
      accuracy: part.length ? part.filter((r) => r.correct).length / part.length : 0,
      cloudCalls: part.length - kept.length,
      explored: part.filter((r) => r.explored).length,
    };
  };
  const curve: SimulationResult['curve'] = [];
  for (let i = 0; i < rows.length; i += windowSize) curve.push({ from: i + 1, ...summarize(rows.slice(i, i + windowSize)) });
  // Not destroy(): it would unload the embedder, which the caller may reuse.
  const stats = (await local.stats(name))!;
  return { all: summarize(rows), last: summarize(rows.slice(-windowSize * 3)), curve, stats };
}
