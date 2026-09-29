import {
  BelayError,
  LocalUnavailableError,
  clamp01,
  normalizeOptions,
  topProbability,
} from '@belay/core';
import type {
  Availability,
  BinarySchema,
  CategoricalSchema,
  LocalOutput,
  LocalRunner,
  OrdinalSchema,
  PrepareOptions,
  ProbabilityEntry,
  RunnerContext,
  TaskSchema,
} from '@belay/core';
import type {
  ClassifierDecision,
  ClassifierExpectedInput,
  ClassifierInstance,
  ClassifierSchema,
  ClassifierStatic,
} from './classifier-types.js';

export type ClassifierTaskSchema = BinarySchema | CategoricalSchema | OrdinalSchema;

export interface ClassifierApiOptions {
  /**
   * Which number becomes the task confidence:
   * - `label-probability` (default): the calibrated probability of the returned label
   *   (the top option). For binary questions this is max(P(true), P(false)).
   * - `model`: the decision's own `confidence` field.
   * See ADR 0001 for why the default is the probability.
   */
  confidence?: 'label-probability' | 'model';
  /** Defaults to `[{ type: 'text', languages: ['en'] }]`. */
  expectedInputs?: ClassifierExpectedInput[];
  /** Question id used in the Classifier schema. Defaults to "answer". */
  questionId?: string;
  /**
   * The `Classifier` implementation. Defaults to `globalThis.Classifier` (Chrome's built-in API or
   * the WebAI Studio extension polyfill). Injectable for tests and custom polyfills.
   */
  classifier?: ClassifierStatic;
  /** Max number of cached sessions (one per distinct context). Defaults to 4. */
  maxSessions?: number;
}

type Ctx = RunnerContext<TaskSchema>;

const DEFAULT_PROMPTS = {
  categorical: 'Which option best describes the input?',
  ordinal: 'Which level best describes the input?',
} as const;

/** Maps a Belay schema to a Classifier API schema with a single question. */
export function toClassifierSchema(
  schema: TaskSchema,
  options: { questionId?: string; context?: string; expectedInputs?: ClassifierExpectedInput[] } = {},
): ClassifierSchema {
  const id = options.questionId ?? 'answer';
  const base = {
    ...(options.context ? { context: options.context } : {}),
    expectedInputs: options.expectedInputs ?? [{ type: 'text' as const, languages: ['en'] }],
  };
  switch (schema.type) {
    case 'binary':
      return { ...base, questions: [{ id, type: 'binary', prompt: schema.prompt }] };
    case 'categorical':
    case 'ordinal':
      return {
        ...base,
        questions: [
          {
            id,
            type: schema.type,
            prompt: schema.prompt ?? DEFAULT_PROMPTS[schema.type],
            options: normalizeOptions(schema.options),
          },
        ],
      };
    default:
      throw new BelayError(
        'invalid-task',
        `the Classifier API runner supports binary, categorical and ordinal tasks, not "${schema.type}"`,
      );
  }
}

/** Extracts value, confidence and distribution from a Classifier decision. */
export function readDecision(
  schema: ClassifierTaskSchema,
  decision: ClassifierDecision | undefined,
  mode: 'label-probability' | 'model' = 'label-probability',
): LocalOutput<string | boolean> {
  if (!decision || typeof decision !== 'object') {
    throw new Error('Classifier result is missing the decision');
  }

  let probabilities: ProbabilityEntry[] | undefined = Array.isArray(decision.probabilities)
    ? decision.probabilities.filter((p) => typeof p?.label === 'string' && typeof p.probability === 'number')
    : undefined;
  if (schema.type === 'binary' && typeof decision.probability === 'number') {
    const pTrue = clamp01(decision.probability);
    probabilities = [
      { label: 'true', probability: pTrue },
      { label: 'false', probability: 1 - pTrue },
    ];
  }

  let label = typeof decision.label === 'string' ? decision.label : undefined;
  if (label === undefined && probabilities?.length) {
    label = probabilities.reduce((a, b) => (b.probability > a.probability ? b : a)).label;
  }
  if (label === undefined) throw new Error('Classifier decision has no label');

  let confidence: number | undefined;
  if (mode === 'label-probability' && probabilities?.length) {
    const own = probabilities.find((p) => p.label === label);
    confidence = own ? clamp01(own.probability) : topProbability(probabilities);
  }
  if (confidence === undefined && typeof decision.confidence === 'number') confidence = clamp01(decision.confidence);
  if (confidence === undefined) throw new Error('Classifier decision has neither probabilities nor confidence');

  const value = schema.type === 'binary' ? label.trim().toLowerCase() === 'true' : label;
  return { value, confidence, ...(probabilities ? { probabilities } : {}), raw: decision };
}

/**
 * Local runner backed by the Classifier API. It never triggers a model download from `run()`:
 * while the model is "downloadable" or "downloading" the task escalates with reason
 * `local-unavailable`. Call `task.prepare()` from a user gesture to download the model.
 */
export function classifierApi(options: ClassifierApiOptions = {}): LocalRunner<any> {
  const mode = options.confidence ?? 'label-probability';
  const maxSessions = Math.max(1, options.maxSessions ?? 4);
  const sessions = new Map<string, Promise<ClassifierInstance>>();

  const api = (): ClassifierStatic | undefined =>
    options.classifier ?? (globalThis as { Classifier?: ClassifierStatic }).Classifier;

  const schemaFor = (ctx: Ctx): ClassifierSchema =>
    toClassifierSchema(ctx.schema, {
      ...(options.questionId ? { questionId: options.questionId } : {}),
      ...(ctx.context ? { context: ctx.context } : {}),
      ...(options.expectedInputs ? { expectedInputs: options.expectedInputs } : {}),
    });

  const keyFor = (schema: ClassifierSchema): string => JSON.stringify(schema);

  function session(ctx: Ctx, prepare?: PrepareOptions): Promise<ClassifierInstance> {
    const Classifier = api();
    if (!Classifier) return Promise.reject(new LocalUnavailableError('Classifier API is not available'));
    const schema = schemaFor(ctx);
    const key = keyFor(schema);
    const cached = sessions.get(key);
    if (cached) {
      sessions.delete(key); // refresh LRU position
      sessions.set(key, cached);
      return cached;
    }
    // Only prepare()'s signal: the session is cached and shared, so a per-run abort must not destroy it.
    const signal = prepare?.signal;
    const created = Classifier.create({
      ...schema,
      ...(signal ? { signal } : {}),
      ...(prepare?.onProgress
        ? {
            monitor: (m: EventTarget) =>
              m.addEventListener('downloadprogress', (e) => prepare.onProgress!((e as Event & { loaded: number }).loaded)),
          }
        : {}),
    });
    sessions.set(key, created);
    created.catch(() => {
      if (sessions.get(key) === created) sessions.delete(key);
    });
    while (sessions.size > maxSessions) {
      const [oldestKey, oldest] = sessions.entries().next().value as [string, Promise<ClassifierInstance>];
      sessions.delete(oldestKey);
      oldest.then((s) => s.destroy(), () => {});
    }
    return created;
  }

  async function availability(ctx: Ctx): Promise<Availability> {
    const Classifier = api();
    if (!Classifier) return 'unavailable';
    const schema = schemaFor(ctx); // throws for unsupported schemas
    if (sessions.has(keyFor(schema))) return 'available';
    try {
      return await Classifier.availability(schema);
    } catch {
      return 'unavailable';
    }
  }

  return {
    id: 'classifier-api',
    availability,

    async run(input: string, ctx: Ctx) {
      const schema = schemaFor(ctx);
      if (!sessions.has(keyFor(schema))) {
        // Creating a session while the model is not downloaded would start a download.
        const state = await availability(ctx);
        if (state !== 'available') throw new LocalUnavailableError(`Classifier model is ${state}`);
      }
      const classifier = await session(ctx);
      const result = await classifier.classify(input, ctx.signal ? { signal: ctx.signal } : {});
      const questionId = schema.questions[0]!.id;
      return readDecision(ctx.schema as ClassifierTaskSchema, result?.[questionId], mode);
    },

    async prepare(ctx: Ctx, prepareOptions?: PrepareOptions) {
      const state = await availability(ctx);
      if (state === 'unavailable') throw new LocalUnavailableError('Classifier model is unavailable on this device');
      await session(ctx, prepareOptions);
    },

    destroy() {
      for (const s of sessions.values()) s.then((c) => c.destroy(), () => {});
      sessions.clear();
    },
  };
}
