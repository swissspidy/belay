import { BelayError, LocalUnavailableError, optionLabels, schemaFingerprint } from '@swissspidy/belay-core';
import type {
  Availability,
  BinarySchema,
  CategoricalSchema,
  LearnExample,
  LocalOutput,
  LocalRunner,
  OrdinalSchema,
  PrepareOptions,
  RunnerContext,
  TaskSchema,
} from '@swissspidy/belay-core';
import { applyPlatt, fitPlatt, type CalibrationPair, type PlattScaling } from './calibrator.js';
import type { Embedder } from './embedder.js';
import { knnPredict, nearestSimilarity, quantile, softmaxPredict, softmaxTrain, type HeadExample, type SoftmaxModel } from './head.js';
import { loadSeed, type SeedFile } from './seed.js';
import { parseLearnedState, type LearnedState } from './state.js';
import { memoryStore, type ExampleStore, type StoredExample, type StoredMeta } from './store.js';
import { decodeInt8, encodeInt8 } from './vector.js';

export type LearnedTaskSchema = BinarySchema | CategoricalSchema | OrdinalSchema;
export type HeadKind = 'knn' | 'softmax';

export interface LearnedClassifierOptions {
  embedder: Embedder;
  /** Where examples are kept. Defaults to `memoryStore()`; use `indexedDbStore()` to keep them across reloads. */
  store?: ExampleStore;
  /** Labeled embeddings to start from (see `buildSeed()`): an object, a URL or a loader. */
  seed?: SeedFile | string | URL | (() => Promise<SeedFile>);
  /**
   * - `auto` (default): whichever head was more often right on the recent inputs it had not seen
   *   yet; kNN until the softmax head has enough data and calibration pairs of its own.
   * - `knn`, `softmax`: always that head (softmax falls back to kNN until it is trained).
   */
  head?: 'auto' | HeadKind;
  knn?: { k?: number; temperature?: number };
  softmax?: {
    /** Train the softmax head from this many examples on. Defaults to 50. */
    minExamples?: number;
    /** Defaults to 150 (from scratch) and 40 (warm start from the previous fit). */
    epochs?: number;
    warmEpochs?: number;
    l2?: number;
    /** Debounce between a new example and retraining. Defaults to 200 ms. */
    retrainDelayMs?: number;
  };
  /**
   * Cold start: the confidence is 0 (so the task escalates) until there are this many examples
   * in all (default 10), its top label has `minPerLabel` (default 3), and its head has
   * `calibration.minPairs` calibration pairs.
   */
  minExamples?: number;
  minPerLabel?: number;
  calibration?: {
    /** Defaults to 30. */
    minPairs?: number;
    /** Fit on the most recent pairs only, since the head improves as it learns. Defaults to 300. */
    window?: number;
    /**
     * Within the window, a pair's weight halves every `halfLife` newer pairs, so the confidence
     * follows a head that improves, or one that starts going wrong. Defaults to 50.
     */
    halfLife?: number;
  };
  /**
   * Out-of-distribution check: an input whose `k`-th nearest stored example is less similar
   * than a threshold escalates, however confident the vote among its neighbors (`raw.gate` is
   * `'distance'`). See ADR 0005.
   * - `{ k, quantile, minSamples }` (default `{ k: 5, quantile: 0.05, minSamples: 30 }`): the
   *   threshold is that quantile of the same score for the stored examples, each left out in
   *   turn (up to 300 of them, recomputed as it learns), so about 95% of inputs like those it
   *   learned from pass. Off until there are `minSamples` stored examples.
   * - a number: a fixed cosine similarity (with k = 5).
   * - `false`: off.
   */
  distanceGate?: false | number | { k?: number; quantile?: number; minSamples?: number };
  /** Weight of a `task.feedback()` correction relative to a cloud answer. Defaults to 3. */
  feedbackWeight?: number;
  /** Ignore cloud answers whose reported confidence is below this. Defaults to 0 (learn from all). */
  minCloudConfidence?: number;
  /** Keep at most this many learned examples; the oldest cloud answers go first. Defaults to 5,000. */
  maxExamples?: number;
  /** Runner id in telemetry. Defaults to "learned". */
  id?: string;
}

export interface LearnedStats {
  task: string;
  /** Learned and seed examples. */
  examples: number;
  seedExamples: number;
  perLabel: Record<string, number>;
  /** The head that answers right now. */
  head: HeadKind;
  /** Whether the answering head is past the cold start, i.e. may report a confidence above 0. */
  ready: boolean;
  heads: Record<HeadKind, { pairs: number; recentAccuracy: number | null; scaling: PlattScaling | null; trained: boolean }>;
  /** Labeled inputs waiting for the embedding model. */
  pending: number;
  /** The distance gate: its current threshold (null while off) and how many runs it sent to the cloud. */
  gate: { threshold: number | null; samples: number; gated: number };
  /** Incremented whenever the classifier learns. */
  version: number;
}

/**
 * A learned classifier: a local runner (typed `any`, like `classifierApi()`, since one runner serves
 * binary, categorical and ordinal tasks) with methods to inspect and manage what it learned.
 */
export type LearnedClassifier = LocalRunner<any> & {
  /** Learning progress of a task (the first one used if omitted). */
  stats(task?: string): Promise<LearnedStats | null>;
  /** Resolves once queued learning and retraining are done. */
  flush(): Promise<void>;
  /** Forgets everything learned for a task (seed examples stay). */
  reset(task?: string): Promise<void>;
  /** The seed and the learned examples as a seed file, e.g. to ship what a classifier learned in development. */
  exportSeed(task?: string): Promise<SeedFile>;
  /**
   * Everything a task learned (not the seed) as a JSON-serializable snapshot: for backups,
   * moving to another device, or syncing to your server. Holds embeddings, never text.
   */
  exportState(task?: string): Promise<LearnedState>;
  /**
   * Restores a snapshot from `exportState()` into the store, merging with what is there (a
   * correction wins over a cloud answer for the same input) or, with `{ replace: true }`,
   * replacing it. Works before the task's first run: the snapshot names its task and schema.
   */
  importState(state: LearnedState, options?: { replace?: boolean }): Promise<{ examples: number }>;
};

interface Prediction {
  label: number;
  score: number;
}

interface Example extends HeadExample {
  id: string;
  source: 'seed' | 'cloud' | 'feedback';
  createdAt: number;
}

interface State {
  task: string;
  scope: string;
  schema: LearnedTaskSchema;
  labels: string[];
  fingerprint: string;
  seed: Example[];
  /** The seed file's leave-one-out pairs, which a reset goes back to. */
  seedPairs: CalibrationPair[];
  learned: Map<string, Example>;
  pairs: Record<HeadKind, CalibrationPair[]>;
  scaling: Record<HeadKind, PlattScaling | null>;
  softmax: (SoftmaxModel & { examples: number }) | null;
  /** The last predictions per input id, for calibration pairs when the label arrives. */
  predictions: Map<string, Partial<Record<HeadKind, Prediction>>>;
  embeddings: Map<string, Float32Array>;
  pending: { id: string; input: string; label: number; source: 'cloud' | 'feedback' }[];
  /** The distance gate's threshold, and the example count it was computed at. */
  gate: { threshold: number | null; at: number; samples: number };
  gated: number;
  version: number;
  /** Incremented by reset(): learning that started before it must not land after it. */
  generation: number;
  retrainTimer: ReturnType<typeof setTimeout> | undefined;
  /** Settles the promise `flush()` waits on for the scheduled retrain. */
  releaseRetrain: (() => void) | undefined;
  training: Promise<void> | null;
  dirty: boolean;
}

const MAX_PAIRS = 1000;
/** Stored examples scored (left out in turn) for the distance gate's threshold. */
const GATE_SAMPLE = 300;
/** Recompute the gate's threshold after this share of new examples. */
const GATE_REFRESH = 0.1;
const MAX_CACHED = 512;
const MAX_PENDING = 256;

/** 64-bit FNV-1a over UTF-16 code units (two 32-bit lanes), hex encoded. */
function inputId(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

const argmax = (p: Float64Array): number => {
  let top = 0;
  for (let i = 1; i < p.length; i++) if (p[i]! > p[top]!) top = i;
  return top;
};

/**
 * A local runner that learns: it embeds each input with an on-device model and classifies it with
 * a small head trained on the cloud's answers to earlier escalations and on users' corrections.
 * Its confidence is the head's score mapped to P(correct) by Platt scaling, fitted on the head's
 * own record on inputs it had not seen yet, so the task's threshold keeps meaning "accept when at
 * least this likely right" while the head improves. See ADR 0004.
 */
export function learnedClassifier(options: LearnedClassifierOptions): LearnedClassifier {
  const { embedder } = options;
  const store = options.store ?? memoryStore();
  const headMode = options.head ?? 'auto';
  const k = options.knn?.k ?? 7;
  const temperature = options.knn?.temperature ?? 0.1;
  const softmaxMin = options.softmax?.minExamples ?? 50;
  const epochs = options.softmax?.epochs ?? 150;
  const warmEpochs = options.softmax?.warmEpochs ?? 40;
  const l2 = options.softmax?.l2 ?? 1e-3;
  const retrainDelayMs = options.softmax?.retrainDelayMs ?? 200;
  const minExamples = options.minExamples ?? 10;
  const minPerLabel = options.minPerLabel ?? 3;
  const minPairs = options.calibration?.minPairs ?? 30;
  const window = options.calibration?.window ?? 300;
  const halfLife = options.calibration?.halfLife ?? 50;
  const feedbackWeight = options.feedbackWeight ?? 3;
  const minCloudConfidence = options.minCloudConfidence ?? 0;
  const maxExamples = options.maxExamples ?? 5000;
  const gateOption = options.distanceGate ?? {};
  const gateQuantile = typeof gateOption === 'object' ? (gateOption.quantile ?? 0.05) : 0;
  const gateMinSamples = typeof gateOption === 'object' ? (gateOption.minSamples ?? 30) : 0;
  const gateK = Math.max(1, (typeof gateOption === 'object' ? gateOption.k : undefined) ?? 5);
  /** The gate's score: similarity to the k-th nearest example (fewer examples: the farthest). */
  const gateScore = (examples: readonly HeadExample[], v: Float32Array, skip = -1): number =>
    nearestSimilarity(examples, v, Math.min(gateK, Math.max(1, examples.length - (skip >= 0 ? 1 : 0))), skip);

  const states = new Map<string, Promise<State>>();
  let firstTask: string | undefined;
  const background = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    background.add(p);
    p.finally(() => background.delete(p)).catch(() => {});
    return p;
  };
  // Store writes run one at a time, in order.
  let writes: Promise<void> = Promise.resolve();
  const write = (fn: () => Promise<void>): Promise<void> => track((writes = writes.then(fn, fn)));

  const scopeOf = (task: string, fingerprint: string): string => `${task}|${fingerprint}|${embedder.id}`;

  function labelsOf(schema: TaskSchema): string[] {
    if (schema.type === 'structured') {
      throw new BelayError('invalid-task', 'the learned classifier supports binary, categorical and ordinal tasks, not "structured"');
    }
    return optionLabels(schema);
  }

  function stateFor(ctx: RunnerContext<TaskSchema>): Promise<State> {
    const labels = labelsOf(ctx.schema);
    const fingerprint = schemaFingerprint(ctx.schema);
    const key = `${ctx.task}|${fingerprint}`;
    firstTask ??= ctx.task;
    let state = states.get(key);
    if (!state) {
      state = (async (): Promise<State> => {
        const scope = scopeOf(ctx.task, fingerprint);
        const [saved, seedFile] = await Promise.all([store.load(scope), options.seed ? loadSeed(options.seed) : Promise.resolve(null)]);
        const seed: Example[] = [];
        let seedPairs: CalibrationPair[] = [];
        if (seedFile) {
          if (seedFile.embedder !== embedder.id) {
            throw new Error(`seed file was made with embedder "${seedFile.embedder}", not "${embedder.id}"`);
          }
          if (seedFile.schemaFingerprint !== fingerprint) {
            throw new Error(`seed file was made for a different schema (${seedFile.schemaFingerprint}, expected ${fingerprint})`);
          }
          seedFile.examples.forEach((e, i) => {
            const label = labels.indexOf(e.label);
            if (label >= 0) seed.push({ id: `seed:${i}`, label, embedding: decodeInt8(e.embedding), weight: 1, source: 'seed', createdAt: 0 });
          });
          seedPairs = seedFile.pairs?.knn ?? [];
        }
        const learned = new Map<string, Example>();
        for (const e of saved.examples) {
          const label = labels.indexOf(e.label);
          if (label < 0) continue;
          learned.set(e.id, { ...e, label, weight: e.source === 'feedback' ? feedbackWeight : 1 });
        }
        const meta = saved.meta;
        const pairs = { knn: meta?.pairs.knn ?? [...seedPairs], softmax: meta?.pairs.softmax ?? [] };
        const s: State = {
          task: ctx.task,
          scope,
          schema: ctx.schema as LearnedTaskSchema,
          labels,
          fingerprint,
          seed,
          seedPairs,
          learned,
          pairs,
          scaling: { knn: null, softmax: null },
          softmax: meta?.softmax && meta.softmax.labels === labels.length ? meta.softmax : null,
          predictions: new Map(),
          embeddings: new Map(),
          pending: [],
          gate: { threshold: null, at: -1, samples: 0 },
          gated: 0,
          version: 0,
          generation: 0,
          retrainTimer: undefined,
          releaseRetrain: undefined,
          training: null,
          dirty: false,
        };
        refit(s, 'knn');
        refit(s, 'softmax');
        if (!s.softmax || s.softmax.examples < size(s)) scheduleRetrain(s);
        return s;
      })();
      state.catch(() => states.delete(key));
      states.set(key, state);
    }
    return state;
  }

  const size = (s: State): number => s.seed.length + s.learned.size;
  const allExamples = (s: State): Example[] => [...s.seed, ...s.learned.values()];

  function countsOf(s: State): number[] {
    const counts = new Array<number>(s.labels.length).fill(0);
    for (const e of s.seed) counts[e.label]!++;
    for (const e of s.learned.values()) counts[e.label]!++;
    return counts;
  }

  function refit(s: State, head: HeadKind): void {
    const recent = s.pairs[head].slice(-window);
    s.scaling[head] = recent.length >= minPairs ? fitPlatt(recent, { halfLife }) : null;
  }

  function recentAccuracy(s: State, head: HeadKind): number | null {
    const recent = s.pairs[head].slice(-window);
    if (!recent.length) return null;
    return recent.filter((p) => p.correct).length / recent.length;
  }

  function activeHead(s: State): HeadKind {
    if (headMode === 'knn' || !s.softmax) return 'knn';
    if (headMode === 'softmax') return 'softmax';
    if (!s.scaling.softmax) return 'knn';
    // Compare on the same inputs: the last `window` labels both heads predicted.
    const n = Math.min(s.pairs.knn.length, s.pairs.softmax.length, window);
    const acc = (h: HeadKind) => s.pairs[h].slice(-n).filter((p) => p.correct).length;
    return acc('softmax') > acc('knn') ? 'softmax' : 'knn';
  }

  function scheduleRetrain(s: State): void {
    if (headMode === 'knn' || size(s) < softmaxMin) return;
    s.dirty = true;
    if (s.retrainTimer !== undefined) return;
    track(new Promise<void>((r) => (s.releaseRetrain = r)));
    s.retrainTimer = setTimeout(() => {
      const release = s.releaseRetrain;
      s.retrainTimer = undefined;
      s.releaseRetrain = undefined;
      track(retrain(s)).finally(release).catch(() => {});
    }, retrainDelayMs);
  }

  function cancelRetrain(s: State): void {
    if (s.retrainTimer !== undefined) clearTimeout(s.retrainTimer);
    s.retrainTimer = undefined;
    s.releaseRetrain?.();
    s.releaseRetrain = undefined;
  }

  async function retrain(s: State): Promise<void> {
    if (s.training) await s.training.catch(() => {});
    if (!s.dirty) return;
    s.dirty = false;
    const examples = allExamples(s);
    const dimensions = examples[0]?.embedding.length ?? 0;
    if (!dimensions) return;
    const init = s.softmax && s.softmax.dimensions === dimensions && s.softmax.labels === s.labels.length ? s.softmax : undefined;
    s.training = (async () => {
      const model = await softmaxTrain(examples, s.labels.length, dimensions, {
        epochs: init ? warmEpochs : epochs,
        l2,
        ...(init ? { init } : {}),
        yieldEvery: () => new Promise((r) => setTimeout(r, 0)),
      });
      s.softmax = { ...model, examples: examples.length };
      s.version++;
      saveMeta(s);
    })();
    try {
      await s.training;
    } finally {
      s.training = null;
    }
    if (s.dirty) scheduleRetrain(s);
  }

  function saveMeta(s: State): void {
    const meta: StoredMeta = {
      version: 1,
      pairs: { knn: s.pairs.knn.slice(-MAX_PAIRS), softmax: s.pairs.softmax.slice(-MAX_PAIRS) },
      ...(s.softmax
        ? { softmax: { labels: s.softmax.labels, dimensions: s.softmax.dimensions, weights: s.softmax.weights, bias: s.softmax.bias, examples: s.softmax.examples } }
        : {}),
    };
    void write(() => store.putMeta(s.scope, meta));
  }

  function predict(s: State, v: Float32Array): Record<HeadKind, Float64Array | null> {
    const examples = allExamples(s);
    return {
      knn: examples.length ? knnPredict(examples, v, s.labels.length, { k, temperature }) : null,
      softmax: s.softmax && s.softmax.dimensions === v.length ? softmaxPredict(s.softmax, v) : null,
    };
  }

  async function embedOne(s: State, id: string, input: string, signal?: AbortSignal): Promise<Float32Array> {
    const cached = s.embeddings.get(id);
    if (cached) return cached;
    const [v] = await embedder.embed([input], signal ? { signal } : {});
    if (!v) throw new Error('the embedder returned no vector');
    remember(s.embeddings, id, v, MAX_CACHED);
    return v;
  }

  /** Adds a labeled, embedded example. */
  function addExample(s: State, id: string, label: number, embedding: Float32Array, source: 'cloud' | 'feedback'): void {
    const existing = s.learned.get(id);
    // A user's correction outranks a later cloud answer for the same input.
    if (existing?.source === 'feedback' && source === 'cloud') return;
    const example: Example = { id, label, embedding, weight: source === 'feedback' ? feedbackWeight : 1, source, createdAt: Date.now() };
    s.learned.delete(id);
    s.learned.set(id, example);
    const stored: StoredExample = { id, label: s.labels[label]!, embedding, source, createdAt: example.createdAt };
    void write(() => store.put(s.scope, [stored]));
    if (s.learned.size > maxExamples) {
      const evict: string[] = [];
      for (const e of s.learned.values()) {
        if (s.learned.size - evict.length <= maxExamples) break;
        if (e.source === 'cloud') evict.push(e.id);
      }
      for (const e of evict) s.learned.delete(e);
      if (evict.length) void write(() => store.delete(s.scope, evict));
    }
    s.version++;
    scheduleRetrain(s);
  }

  /** Records how the heads did on this input before they learned it. */
  function recordPairs(s: State, id: string, label: number, weight?: number): void {
    const prediction = s.predictions.get(id);
    if (!prediction) return;
    s.predictions.delete(id);
    // Inverse-probability weight of an explored run, clipped so one rare pick cannot dominate.
    const w = weight === undefined || weight === 1 ? undefined : Math.min(20, Math.max(0.05, weight));
    for (const head of ['knn', 'softmax'] as const) {
      const p = prediction[head];
      if (!p) continue;
      s.pairs[head].push({ score: p.score, correct: p.label === label, ...(w !== undefined ? { weight: w } : {}) });
      if (s.pairs[head].length > MAX_PAIRS) s.pairs[head].splice(0, s.pairs[head].length - MAX_PAIRS);
      refit(s, head);
    }
  }

  async function drainPending(s: State): Promise<void> {
    if (!s.pending.length) return;
    const generation = s.generation;
    const batch = s.pending.splice(0);
    let vectors: Float32Array[];
    try {
      vectors = await embedder.embed(batch.map((p) => p.input));
    } catch (err) {
      // Keep the labels for the next attempt (unless a reset dropped them meanwhile).
      if (generation === s.generation) s.pending.unshift(...batch);
      throw err;
    }
    if (generation !== s.generation) return;
    batch.forEach((p, i) => addExample(s, p.id, p.label, vectors[i]!, p.source));
    saveMeta(s);
  }

  async function learnOne(example: LearnExample<unknown>, ctx: RunnerContext<TaskSchema>): Promise<void> {
    const s = await stateFor(ctx);
    const generation = s.generation;
    const label = s.labels.indexOf(String(example.value));
    if (label < 0) return;
    if (example.source === 'cloud' && example.cloudConfidence !== undefined && example.cloudConfidence < minCloudConfidence) return;
    const id = inputId(example.input);
    recordPairs(s, id, label, example.explorationWeight);
    const cached = s.embeddings.get(id);
    if (cached) {
      addExample(s, id, label, cached, example.source);
    } else if ((await embedder.availability()) === 'available') {
      const embedding = await embedOne(s, id, example.input, ctx.signal);
      if (generation !== s.generation) return; // reset() ran while embedding
      addExample(s, id, label, embedding, example.source);
    } else {
      // The model is not loaded yet (e.g. before the first prepare()): learn once it is.
      s.pending.push({ id, input: example.input, label, source: example.source });
      if (s.pending.length > MAX_PENDING) s.pending.splice(0, s.pending.length - MAX_PENDING);
    }
    saveMeta(s);
  }

  /**
   * The distance gate's threshold right now, or null while it is off: the `gateQuantile` of the
   * leave-one-out score of up to GATE_SAMPLE stored examples (Sun et al.: keep ~95% of
   * in-distribution data), recomputed once the example count moved by GATE_REFRESH.
   */
  function gateThreshold(s: State): number | null {
    if (gateOption === false) return null;
    if (typeof gateOption === 'number') return gateOption;
    const n = size(s);
    if (n < Math.max(2, gateMinSamples)) return null;
    if (s.gate.at < 0 || Math.abs(n - s.gate.at) >= Math.max(5, s.gate.at * GATE_REFRESH)) {
      const examples = allExamples(s);
      const step = Math.max(1, Math.ceil(examples.length / GATE_SAMPLE));
      const scores: number[] = [];
      for (let i = 0; i < examples.length; i += step) scores.push(gateScore(examples, examples[i]!.embedding, i));
      s.gate = { threshold: quantile(scores, gateQuantile), at: n, samples: scores.length };
    }
    return s.gate.threshold;
  }

  async function stateOf(task?: string): Promise<State | null> {
    const name = task ?? firstTask;
    if (name === undefined) return null;
    for (const [key, state] of states) if (key.startsWith(`${name}|`)) return state;
    return null;
  }

  return {
    id: options.id ?? 'learned',

    async availability(ctx) {
      labelsOf(ctx.schema); // throws for unsupported schemas
      return embedder.availability();
    },

    async prepare(ctx, prepareOptions?: PrepareOptions) {
      await embedder.prepare?.(prepareOptions);
      const s = await stateFor(ctx);
      await drainPending(s);
    },

    async run(input: string, ctx: RunnerContext<TaskSchema>): Promise<LocalOutput<any>> {
      const s = await stateFor(ctx);
      if ((await embedder.availability()) !== 'available') throw new LocalUnavailableError(`embedding model is not available`);
      if (s.pending.length) await track(drainPending(s));
      if (size(s) === 0) throw new LocalUnavailableError('the learned classifier has no examples yet');

      const id = inputId(input);
      const v = await embedOne(s, id, input, ctx.signal);
      ctx.signal?.throwIfAborted();
      const predictions = predict(s, v);
      const recorded: Partial<Record<HeadKind, Prediction>> = {};
      for (const head of ['knn', 'softmax'] as const) {
        const p = predictions[head];
        if (p) {
          const label = argmax(p);
          recorded[head] = { label, score: p[label]! };
        }
      }
      remember(s.predictions, id, recorded, MAX_CACHED);

      const head = predictions[activeHead(s)] ? activeHead(s) : 'knn';
      const p = predictions[head]!;
      const top = recorded[head]!;
      const counts = countsOf(s);
      const scaling = s.scaling[head];
      const ready = size(s) >= minExamples && counts[top.label]! >= minPerLabel && scaling !== null;
      // Distance gate: nothing stored is close enough to vouch for this input.
      const nearest = gateScore(allExamples(s), v);
      const gateAt = gateThreshold(s);
      const gated = ready && gateAt !== null && nearest < gateAt;
      if (gated) s.gated++;
      const confidence = ready && !gated ? applyPlatt(scaling, top.score) : 0;
      // What a cloud answer would teach: low margin between the top two labels, or heads that disagree.
      let second = 0;
      for (let i = 0; i < p.length; i++) if (i !== top.label && p[i]! > second) second = p[i]!;
      const disagree = recorded.knn && recorded.softmax && recorded.knn.label !== recorded.softmax.label;
      const informativeness = disagree ? 1 : Math.min(1, Math.max(0, 1 - (top.score - second)));
      const label = s.labels[top.label]!;
      return {
        value: s.schema.type === 'binary' ? label === 'true' : label,
        confidence,
        probabilities: s.labels.map((l, i) => ({ label: l, probability: p[i]! })),
        informativeness,
        raw: { head, score: top.score, ready, nearest, ...(gated ? { gate: 'distance' } : {}), examples: size(s), version: s.version },
      };
    },

    learn(example: LearnExample<unknown>, ctx) {
      // Tracked, so flush() waits for an embedding that is still running.
      return track(learnOne(example, ctx));
    },

    async stats(task) {
      const s = await stateOf(task);
      if (!s) return null;
      const counts = countsOf(s);
      const head = activeHead(s);
      return {
        task: s.task,
        examples: size(s),
        seedExamples: s.seed.length,
        perLabel: Object.fromEntries(s.labels.map((l, i) => [l, counts[i]!])),
        head,
        ready: size(s) >= minExamples && s.scaling[head] !== null,
        heads: {
          knn: { pairs: s.pairs.knn.length, recentAccuracy: recentAccuracy(s, 'knn'), scaling: s.scaling.knn, trained: size(s) > 0 },
          softmax: { pairs: s.pairs.softmax.length, recentAccuracy: recentAccuracy(s, 'softmax'), scaling: s.scaling.softmax, trained: s.softmax !== null },
        },
        pending: s.pending.length,
        gate: { threshold: gateThreshold(s), samples: s.gate.samples, gated: s.gated },
        version: s.version,
      };
    },

    async flush() {
      while (background.size) await Promise.allSettled([...background]);
    },

    async reset(task) {
      const s = await stateOf(task);
      if (!s) return;
      cancelRetrain(s);
      await s.training?.catch(() => {});
      s.generation++;
      s.learned.clear();
      s.pairs = { knn: [...s.seedPairs], softmax: [] };
      s.scaling = { knn: null, softmax: null };
      refit(s, 'knn');
      s.softmax = null;
      s.predictions.clear();
      s.pending = [];
      s.gate = { threshold: null, at: -1, samples: 0 };
      s.gated = 0;
      s.dirty = false;
      s.version++;
      await write(() => store.clear(s.scope));
      scheduleRetrain(s);
    },

    async exportSeed(task) {
      const s = await stateOf(task);
      if (!s) throw new BelayError('invalid-task', 'the learned classifier has not been used for this task');
      const examples = allExamples(s);
      return {
        version: 1,
        task: s.task,
        schemaFingerprint: s.fingerprint,
        embedder: embedder.id,
        dimensions: examples[0]?.embedding.length ?? 0,
        createdAt: new Date().toISOString(),
        examples: examples.map((e) => ({ label: s.labels[e.label]!, embedding: encodeInt8(e.embedding) })),
        ...(s.pairs.knn.length ? { pairs: { knn: s.pairs.knn.slice(-window) } } : {}),
      };
    },

    async exportState(task) {
      const s = await stateOf(task);
      if (!s) throw new BelayError('invalid-task', 'the learned classifier has not been used for this task');
      await this.flush();
      return {
        kind: 'belay-learn-state',
        version: 1,
        task: s.task,
        schemaFingerprint: s.fingerprint,
        embedder: embedder.id,
        createdAt: new Date().toISOString(),
        examples: [...s.learned.values()].map((e) => ({
          id: e.id,
          label: s.labels[e.label]!,
          source: e.source as 'cloud' | 'feedback',
          createdAt: e.createdAt,
          embedding: encodeInt8(e.embedding),
        })),
        pairs: { knn: s.pairs.knn.slice(-MAX_PAIRS), softmax: s.pairs.softmax.slice(-MAX_PAIRS) },
        };
    },

    async importState(value, importOptions = {}) {
      const snapshot = parseLearnedState(value);
      if (snapshot.embedder !== embedder.id) {
        throw new BelayError('invalid-task', `snapshot was made with embedder "${snapshot.embedder}", not "${embedder.id}"`);
      }
      const scope = scopeOf(snapshot.task, snapshot.schemaFingerprint);
      const key = `${snapshot.task}|${snapshot.schemaFingerprint}`;
      // Settle in-flight learning, then let the task reload from the store on its next run.
      await this.flush();
      const loaded = states.get(key);
      let schema: LearnedTaskSchema | undefined;
      if (loaded) {
        const s = await loaded.catch(() => null);
        if (s) {
          cancelRetrain(s);
          await s.training?.catch(() => {});
          s.generation++;
          schema = s.schema;
        }
        states.delete(key);
      }
      const current = importOptions.replace ? { examples: [], meta: null } : await store.load(scope);
      const byId = new Map(current.examples.map((e) => [e.id, e]));
      for (const e of snapshot.examples) {
        const existing = byId.get(e.id);
        if (existing?.source === 'feedback' && e.source === 'cloud') continue;
        byId.set(e.id, { id: e.id, label: e.label, source: e.source, createdAt: e.createdAt, embedding: decodeInt8(e.embedding) });
      }
      const meta: StoredMeta = {
        version: 1,
        pairs: current.meta?.pairs.knn.length ? current.meta.pairs : snapshot.pairs,
      };
      await write(async () => {
        if (importOptions.replace) await store.clear(scope);
        await store.put(scope, [...byId.values()]);
        await store.putMeta(scope, meta);
      });
      // A task that was loaded reloads from the store now, so stats() and runs see the import.
      if (schema) await stateFor({ task: snapshot.task, schema });
      return { examples: byId.size };
    },

    destroy() {
      for (const state of states.values()) {
        state.then(cancelRetrain, () => {});
      }
      embedder.destroy?.();
    },
  };
}
