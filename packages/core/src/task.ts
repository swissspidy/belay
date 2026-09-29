import { loadCalibration, thresholdFor } from './calibration.js';
import { combineConfidence } from './confidence.js';
import { BelayError, LocalUnavailableError } from './errors.js';
import { assertValidSchema, buildInstruction, labelOf, parseValue, schemaFingerprint, toJsonSchema } from './schema.js';
import type {
  Availability,
  BelayEvent,
  BelayResult,
  CalibrationFile,
  EscalationBlock,
  EscalationPolicy,
  EscalationReason,
  PrepareOptions,
  RunnerContext,
  RunOptions,
  Task,
  TaskOptions,
  TaskSchema,
  ValueOf,
} from './types.js';

const STRICTNESS: Record<EscalationPolicy, number> = { auto: 0, consent: 1, never: 2 };

const now = (): number => globalThis.performance?.now() ?? Date.now();

class LocalTimeoutError extends Error {}

interface ThresholdState {
  calibration: CalibrationFile | null;
  fallback: number | undefined;
}

/**
 * Defines a task: run locally first, escalate to the cloud runner only when needed.
 * The cascade is specified in docs/adr/0001-public-api-confidence-and-calibration.md.
 */
export function task<S extends TaskSchema>(options: TaskOptions<S>): Task<S> {
  const { name, schema, local, cloud, judge, privacy = {}, localTimeoutMs, onEvent } = options;

  if (!name || typeof name !== 'string') throw new BelayError('invalid-task', 'task needs a name');
  assertValidSchema(schema);
  if (!local) throw new BelayError('invalid-task', `task "${name}" needs a local runner`);
  if (options.threshold === undefined && options.calibration === undefined) {
    throw new BelayError('invalid-task', `task "${name}" needs a threshold or a calibration`);
  }
  if (options.threshold !== undefined && !(options.threshold >= 0 && options.threshold <= 1)) {
    throw new BelayError('invalid-task', `task "${name}": threshold must be in [0, 1]`);
  }
  if (privacy.escalation === 'consent' && typeof privacy.consent !== 'function') {
    throw new BelayError('invalid-task', `task "${name}": escalation "consent" needs a consent callback`);
  }

  const fingerprint = schemaFingerprint(schema);
  const jsonSchema = toJsonSchema(schema);

  const emit = (event: BelayEvent): void => {
    try {
      onEvent?.(event);
    } catch {
      // Telemetry must never break a run.
    }
  };
  const emitError = (stage: Extract<BelayEvent, { type: 'error' }>['stage'], err: unknown): void => {
    emit({ type: 'error', task: name, timestamp: Date.now(), stage, message: err instanceof Error ? err.message : String(err) });
  };

  let thresholdPromise: Promise<ThresholdState> | undefined;
  const resolveThreshold = (): Promise<ThresholdState> => {
    thresholdPromise ??= (async (): Promise<ThresholdState> => {
      const fallback = options.threshold;
      if (options.calibration === undefined) return { calibration: null, fallback };
      try {
        const calibration = await loadCalibration(options.calibration, name);
        if (calibration.schemaFingerprint !== fingerprint) {
          throw new BelayError(
            'invalid-calibration',
            `calibration for "${name}" was made for a different schema (${calibration.schemaFingerprint}, expected ${fingerprint}); re-run \`belay calibrate\``,
          );
        }
        return { calibration, fallback };
      } catch (err) {
        emitError('calibration', err);
        if (fallback === undefined) {
          thresholdPromise = undefined; // allow a retry on the next run
          throw err;
        }
        return { calibration: null, fallback };
      }
    })();
    return thresholdPromise;
  };

  const thresholdOf = (state: ThresholdState, label?: string): number =>
    state.calibration ? thresholdFor(state.calibration, label) : state.fallback!;

  const contextFor = (runContext?: string): string | undefined =>
    [options.context, runContext].filter(Boolean).join('\n') || undefined;

  async function run(input: string, runOptions: RunOptions = {}): Promise<BelayResult<ValueOf<S>>> {
    const { signal } = runOptions;
    const started = now();
    signal?.throwIfAborted();

    let policy: EscalationPolicy = privacy.escalation ?? 'auto';
    if (runOptions.escalation && STRICTNESS[runOptions.escalation] > STRICTNESS[policy]) policy = runOptions.escalation;
    if (runOptions.escalation === 'consent' && typeof privacy.consent !== 'function') {
      throw new BelayError('invalid-task', `task "${name}": escalation "consent" needs a consent callback`);
    }
    if (!cloud) policy = 'never';

    const thresholdState = await resolveThreshold();
    const context = contextFor(runOptions.context);
    const ctx: RunnerContext<S> = { task: name, schema, ...(context ? { context } : {}), ...(signal ? { signal } : {}) };

    // ---- 1. Local attempt -------------------------------------------------
    let reason: EscalationReason | null = null;
    let localResult: BelayResult<ValueOf<S>>['local'] = null;
    let localConfidence: number | null = null;
    let localLatencyMs: number | null = null;
    let threshold = thresholdOf(thresholdState);

    const localStarted = now();
    const timeout = new AbortController();
    const localSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const availability = await local.availability(ctx);
      if (availability !== 'available') {
        reason = 'local-unavailable';
      } else {
        const runPromise = local.run(input, { ...ctx, signal: localSignal });
        const output = await (localTimeoutMs === undefined
          ? runPromise
          : Promise.race([
              runPromise,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  timeout.abort();
                  reject(new LocalTimeoutError(`local runner exceeded ${localTimeoutMs}ms`));
                }, localTimeoutMs);
              }),
            ]));
        signal?.throwIfAborted();

        const parsed = parseValue(schema, output.value);
        if (!parsed.ok) {
          reason = 'invalid-output';
          localConfidence = 0;
          // Fixed message: the parse error quotes the rejected output, which must not reach telemetry.
          emitError('local', new Error('local output failed schema validation'));
        } else {
          const judged = judge ? await judge({ input, value: parsed.value, task: name, ...(signal ? { signal } : {}) }) : undefined;
          const confidence = combineConfidence({ valid: true, runner: output.confidence, judge: judged });
          if (confidence === undefined) {
            throw new BelayError(
              'invalid-task',
              `task "${name}": local runner "${local.id}" reports no confidence and the task has no judge`,
            );
          }
          localConfidence = confidence;
          localLatencyMs = now() - localStarted;
          localResult = {
            value: parsed.value,
            confidence,
            latencyMs: localLatencyMs,
            ...(output.probabilities ? { probabilities: output.probabilities } : {}),
          };
          threshold = thresholdOf(thresholdState, labelOf(schema, parsed.value));
          // The one rule: accept iff confidence >= threshold.
          if (confidence < threshold) reason = 'low-confidence';
        }
      }
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (err instanceof BelayError && err.code === 'invalid-task') throw err;
      reason =
        err instanceof LocalTimeoutError
          ? 'local-timeout'
          : err instanceof LocalUnavailableError
            ? 'local-unavailable'
            : 'local-error';
      if (reason !== 'local-unavailable') emitError('local', err);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    localLatencyMs ??= now() - localStarted;

    const finish = (
      result: Omit<BelayResult<ValueOf<S>>, 'latencyMs' | 'threshold' | 'local' | 'escalationReason'>,
      cloudLatencyMs: number | null,
    ): BelayResult<ValueOf<S>> => {
      const full: BelayResult<ValueOf<S>> = {
        ...result,
        latencyMs: now() - started,
        threshold,
        escalationReason: reason,
        local: localResult,
      };
      const label = labelOf(schema, full.value);
      emit({
        type: 'run',
        task: name,
        timestamp: Date.now(),
        source: full.source,
        ...(label !== undefined ? { label } : {}),
        confidence: full.confidence,
        localConfidence,
        threshold,
        thresholdSource: thresholdState.calibration ? 'calibration' : 'manual',
        calibratedAt: thresholdState.calibration?.createdAt ?? null,
        escalationReason: reason,
        escalationBlocked: full.escalationBlocked,
        latencyMs: full.latencyMs,
        localLatencyMs,
        cloudLatencyMs,
        localRunner: local.id,
        cloudRunner: cloud?.id ?? null,
      });
      return full;
    };

    const fallBackToLocal = (blocked: EscalationBlock, cause?: unknown): BelayResult<ValueOf<S>> => {
      if (!localResult) {
        const why = blocked === 'policy' ? 'escalation is disabled' : blocked === 'consent-denied' ? 'consent was denied' : 'the cloud runner failed';
        throw new BelayError('no-result', `task "${name}": no local result (${reason}) and ${why}`, { cause });
      }
      return finish(
        { value: localResult.value, confidence: localResult.confidence, source: 'local', escalationBlocked: blocked },
        null,
      );
    };

    if (reason === null) {
      return finish({ value: localResult!.value, confidence: localResult!.confidence, source: 'local', escalationBlocked: null }, null);
    }

    // ---- 2. Escalation gate -----------------------------------------------
    if (policy === 'never' || !cloud) return fallBackToLocal('policy');

    let cloudInput = input;
    if (privacy.redact) {
      try {
        cloudInput = await privacy.redact(input);
      } catch (err) {
        // Failing closed: never send unredacted input.
        emitError('redact', err);
        return fallBackToLocal('policy', err);
      }
    }
    signal?.throwIfAborted();

    const localSummary = localResult ? { value: localResult.value as unknown, confidence: localResult.confidence } : null;
    if (policy === 'consent') {
      let granted = false;
      try {
        granted = (await privacy.consent!({ task: name, reason, input: cloudInput, local: localSummary })) === true;
      } catch (err) {
        emitError('consent', err);
      }
      signal?.throwIfAborted();
      if (!granted) return fallBackToLocal('consent-denied');
    }

    // ---- 3. Cloud ----------------------------------------------------------
    const cloudStarted = now();
    try {
      const output = await cloud.run(
        {
          task: name,
          schema,
          jsonSchema,
          instruction: buildInstruction(schema, context),
          input: cloudInput,
          ...(context ? { context } : {}),
          ...(localSummary ? { local: localSummary } : {}),
        },
        signal ? { signal } : {},
      );
      signal?.throwIfAborted();
      const parsed = parseValue(schema, output.value);
      if (!parsed.ok) throw new BelayError('cloud-invalid-output', `task "${name}": cloud output failed schema validation`);
      return finish(
        {
          value: parsed.value,
          confidence: typeof output.confidence === 'number' ? output.confidence : null,
          source: 'cloud',
          escalationBlocked: null,
        },
        now() - cloudStarted,
      );
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      emitError('cloud', err);
      if (localResult) return fallBackToLocal('cloud-error', err);
      if (err instanceof BelayError) throw err;
      throw new BelayError('cloud-error', `task "${name}": cloud runner failed`, { cause: err });
    }
  }

  return {
    name,
    schema,
    run,
    async availability(): Promise<Availability> {
      const state = await local.availability({ task: name, schema, ...(options.context ? { context: options.context } : {}) });
      // A judge that is not ready makes the local path unusable too: report the less ready of the two.
      if (state !== 'available' || !judge?.availability) return state;
      return judge.availability();
    },
    async prepare(prepareOptions?: PrepareOptions): Promise<void> {
      await local.prepare?.({ task: name, schema, ...(options.context ? { context: options.context } : {}) }, prepareOptions);
      await judge?.prepare?.(prepareOptions);
    },
    async threshold(): Promise<number> {
      return thresholdOf(await resolveThreshold());
    },
    destroy(): void {
      local.destroy?.();
      judge?.destroy?.();
    },
  };
}
