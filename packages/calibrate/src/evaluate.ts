import {
  buildInstruction,
  canonicalJson,
  combineConfidence,
  costOf,
  usageParts,
  labelOf,
  parseValue,
  schemaFingerprint,
  toJsonSchema,
  type Availability,
  type CloudUsage,
  type LocalOutput,
  type LocalRunner,
  type Judge,
  type TaskSchema,
} from '@swissspidy/belay-core';
import type { Sample } from './analyze.js';
import { OutputCache } from './cache.js';
import type { CalibrationTaskConfig, RunnableTaskConfig } from './config.js';
import type { Dataset } from './dataset.js';

/** Where local inference happens: in Node (a LocalRunner object) or in a real browser. */
export interface LocalBackend {
  /** Stable description used in cache keys and in the calibration file. */
  readonly spec: unknown;
  info(): Promise<{ runner: string; model?: string; userAgent?: string }>;
  availability(): Promise<Availability>;
  /** May download the model. */
  prepare(onProgress?: (loaded: number) => void): Promise<void>;
  run(input: string): Promise<LocalOutput>;
  judge?(input: string, value: unknown): Promise<number>;
  /**
   * The same runner and model, given another schema and context: how `belay tune` runs a changed
   * local side without starting a second browser. Closing the derived backend does nothing.
   */
  derive?(task: { schema: TaskSchema; context?: string }): LocalBackend;
  close(): Promise<void>;
}

/** Runs a `LocalRunner` (and optional judge function) in Node. */
export function nodeBackend(
  runner: LocalRunner<any>,
  ctx: { task: string; schema: TaskSchema; context?: string },
  judge?: Judge<any>,
): LocalBackend {
  const make = (c: typeof ctx, owner: boolean): LocalBackend => ({
    // The judge's score is cached with the local output, so the judge is part of the key.
    spec: { node: runner.id, judge: judge ? judge.name || 'judge' : null },
    async info() {
      return { runner: runner.id };
    },
    availability: () => runner.availability(c),
    async prepare(onProgress) {
      await runner.prepare?.(c, onProgress ? { onProgress } : {});
    },
    run: (input) => runner.run(input, c),
    ...(judge ? { judge: (input: string, value: unknown) => judge({ input, value, task: c.task }) } : {}),
    derive: (task) => make({ task: c.task, schema: task.schema, ...(task.context ? { context: task.context } : {}) }, false),
    async close() {
      if (owner) runner.destroy?.();
    },
  });
  return make(ctx, true);
}

type LocalRecord =
  | { ok: true; value: unknown; confidence?: number; judge?: number; /** Wall-clock time of the run (and its judge), in ms. */ latencyMs?: number }
  | { ok: false; reason: string };

/** A cached cloud output. Entries from before usage was recorded have only `value`. */
interface CloudRecord {
  value: unknown;
  usage?: CloudUsage[];
  confidence?: number;
}

export interface EvaluateOptions {
  name: string;
  config: RunnableTaskConfig<any>;
  dataset: Dataset;
  backend: LocalBackend;
  cache: OutputCache;
  /** Ignore cached outputs for these sides (fresh outputs are still written). */
  refresh?: { local?: boolean; cloud?: boolean };
  cloudConcurrency?: number;
  cloudRetries?: number;
  onProgress?: (event: { phase: 'prepare' | 'local' | 'cloud'; done: number; total: number }) => void;
  log?: (message: string) => void;
}

export interface Evaluation {
  samples: Sample[];
  local: { runner: string; model?: string; userAgent?: string };
  cached: { local: number; cloud: number };
}

function isCorrect(config: CalibrationTaskConfig<any>, value: unknown, expected: unknown): boolean {
  if (config.correct) return config.correct(value, expected);
  if (config.schema.type === 'structured') return canonicalJson(value) === canonicalJson(expected);
  return labelOf(config.schema, value) === labelOf(config.schema, expected);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pool<T>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
}

export interface EvaluateLocalOptions {
  name: string;
  /** Only the schema, context and `correct` are used: the local side is the backend. */
  config: CalibrationTaskConfig<any>;
  dataset: Dataset;
  backend: LocalBackend;
  cache: OutputCache;
  /** Ignore cached local outputs (fresh outputs are still written). */
  refresh?: boolean;
  /** Added to the cache key, e.g. the fingerprint of a local config the backend applies. */
  cacheKey?: unknown;
  onProgress?: (event: { phase: 'prepare' | 'local'; done: number; total: number }) => void;
  log?: (message: string) => void;
}

export interface LocalEvaluation {
  /** One sample per example, with `cloud: null`. */
  samples: Sample[];
  local: { runner: string; model?: string; userAgent?: string };
  /** Examples answered from the output cache. */
  cached: number;
}

async function runLocal(options: EvaluateLocalOptions): Promise<LocalEvaluation & { records: LocalRecord[] }> {
  const { name, config, dataset, backend, cache, onProgress, log = () => {} } = options;
  const { schema } = config;
  const fingerprint = schemaFingerprint(schema);
  const total = dataset.examples.length;
  let cached = 0;
  const localKey = (input: string) =>
    OutputCache.key({
      side: 'local',
      task: name,
      backend: backend.spec,
      schema: fingerprint,
      context: config.context ?? null,
      input,
      ...(options.cacheKey !== undefined ? { extra: options.cacheKey } : {}),
    });

  const needsLocal = options.refresh || dataset.examples.some((e) => !cache.has(localKey(e.input)));
  if (needsLocal) {
    const state = await backend.availability();
    if (state === 'unavailable') {
      throw new Error(`The local runner reports "unavailable" for task "${name}". Is the API enabled (or the extension loaded)?`);
    }
    if (state !== 'available') {
      log(`Local model is ${state}; downloading…`);
      onProgress?.({ phase: 'prepare', done: 0, total: 1 });
      await backend.prepare((loaded) => onProgress?.({ phase: 'prepare', done: loaded, total: 1 }));
    }
  }
  const info = await backend.info();

  const records: LocalRecord[] = [];
  for (const [i, example] of dataset.examples.entries()) {
    const key = localKey(example.input);
    let record = options.refresh ? undefined : cache.get<LocalRecord>(key);
    if (record) {
      cached++;
    } else {
      try {
        const started = performance.now();
        const output = await backend.run(example.input);
        const parsed = parseValue(schema, output.value);
        let judged: number | undefined;
        if (parsed.ok && backend.judge) judged = await backend.judge(example.input, parsed.value);
        record = {
          ok: true,
          value: output.value,
          latencyMs: Math.round((performance.now() - started) * 100) / 100,
          ...(typeof output.confidence === 'number' ? { confidence: output.confidence } : {}),
          ...(judged !== undefined ? { judge: judged } : {}),
        };
        await cache.set(key, record);
      } catch (err) {
        // Failures are not cached: they are usually transient.
        record = { ok: false, reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
        log(`local failed on example ${example.id}: ${record.reason}`);
      }
    }
    records.push(record);
    onProgress?.({ phase: 'local', done: i + 1, total });
  }

  const samples: Sample[] = dataset.examples.map((example, i) => {
    const record = records[i]!;
    let local: Sample['local'] = null;
    if (record.ok) {
      const parsed = parseValue(schema, record.value);
      if (parsed.ok) {
        const confidence = combineConfidence({ valid: true, runner: record.confidence, judge: record.judge });
        if (confidence === undefined) {
          throw new Error(`Task "${name}": the local runner reports no confidence and no judge is configured`);
        }
        local = {
          label: labelOf(schema, parsed.value) ?? '(structured)',
          confidence,
          correct: isCorrect(config, parsed.value, example.expected),
          value: parsed.value,
          ...(typeof record.latencyMs === 'number' ? { latencyMs: record.latencyMs } : {}),
        };
      }
    }
    return { id: example.id, input: example.input, truth: example.truth, local, cloud: null };
  });
  return { samples, local: info, cached, records };
}

/**
 * Runs every example through the local runner only (sequentially; one model, one device), with
 * the output cache in front. No cloud call is made: for scoring against labels already known.
 */
export async function evaluateLocal(options: EvaluateLocalOptions): Promise<LocalEvaluation> {
  const { samples, local, cached } = await runLocal(options);
  return { samples, local, cached };
}

/**
 * Runs every example through the local runner (sequentially; one model, one device) and the
 * cloud runner (concurrently), with an output cache in front of both.
 */
export async function evaluate(options: EvaluateOptions): Promise<Evaluation> {
  const { name, config, dataset, cache, onProgress, log = () => {} } = options;
  const { schema } = config;
  const fingerprint = schemaFingerprint(schema);
  const total = dataset.examples.length;
  const { samples, records, local: info, cached: cachedLocal } = await runLocal({
    name,
    config,
    dataset,
    backend: options.backend,
    cache,
    ...(options.refresh?.local ? { refresh: true } : {}),
    ...(onProgress ? { onProgress } : {}),
    log,
  });
  const cached = { local: cachedLocal, cloud: 0 };

  // ---- Cloud ---------------------------------------------------------------
  const jsonSchema = toJsonSchema(schema);
  const instruction = buildInstruction(schema, config.context);
  const retries = options.cloudRetries ?? 2;
  // Measured cost needs the usage of every call, so a cached output without it is fetched again.
  const needsUsage = config.cost?.prices !== undefined;
  const usages: (CloudUsage[] | undefined)[] = new Array(total);
  let done = 0;
  await pool(dataset.examples, options.cloudConcurrency ?? 4, async (example, i) => {
    const input = config.redact ? await config.redact(example.input) : example.input;
    const record = records[i]!;
    const localSummary =
      record.ok && samples[i]!.local ? { value: parseValue(schema, record.value).ok ? record.value : null, confidence: samples[i]!.local!.confidence } : undefined;
    const key = OutputCache.key({ side: 'cloud', task: name, cloud: config.cloud.id, schema: fingerprint, context: config.context ?? null, input, local: localSummary ?? null });
    let value = options.refresh?.cloud ? undefined : cache.get<CloudRecord>(key);
    if (value && needsUsage && !value.usage) value = undefined;
    if (value) {
      cached.cloud++;
    } else {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const output = await config.cloud.run(
            {
              task: name,
              schema,
              jsonSchema,
              instruction,
              input,
              ...(config.context ? { context: config.context } : {}),
              ...(localSummary ? { local: localSummary } : {}),
            },
            {},
          );
          const usage = usageParts(output.usage);
          value = {
            value: output.value,
            ...(usage.length ? { usage } : {}),
            ...(typeof output.confidence === 'number' ? { confidence: output.confidence } : {}),
          };
          await cache.set(key, value);
          break;
        } catch (err) {
          if (attempt === retries) log(`cloud failed on example ${example.id}: ${err instanceof Error ? err.message : String(err)}`);
          else await sleep(500 * 2 ** attempt);
        }
      }
    }
    if (value) {
      usages[i] = value.usage;
      const parsed = parseValue(schema, value.value);
      samples[i]!.cloud = parsed.ok
        ? { label: labelOf(schema, parsed.value) ?? '(structured)', correct: isCorrect(config, parsed.value, example.expected) }
        : { label: '(invalid)', correct: false };
      if (typeof value.confidence === 'number') samples[i]!.cloud!.confidence = value.confidence;
    }
    onProgress?.({ phase: 'cloud', done: ++done, total });
  });

  // Priced after all calls, so a missing price fails the run once with every output cached.
  const prices = config.cost?.prices;
  if (prices) {
    for (const [i, sample] of samples.entries()) {
      if (!sample.cloud) continue;
      const usage = usages[i];
      if (!usage?.length) {
        throw new Error(`Task "${name}": cost.prices is set, but the cloud runner "${config.cloud.id}" reported no token usage. Report it (CloudOutput.usage) or use cost.cloudPerRun.`);
      }
      sample.cloud.usage = usage;
      sample.cloud.cost = costOf(usage, prices);
    }
  }

  return { samples, local: info, cached };
}
