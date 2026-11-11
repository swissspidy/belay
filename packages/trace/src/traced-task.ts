import {
  BelayError,
  parseValue,
  schemaFingerprint,
  task,
  type BelayEvent,
  type BelayResult,
  type EscalationPolicy,
  type FeedbackOptions,
  type RunEvent,
  type RunOptions,
  type Task,
  type TaskOptions,
  type TaskSchema,
  type ValueOf,
} from '@swissspidy/belay-core';
import { TRACE_VERSION, type LabelKind, type LabelOrigin, type Trace, type TraceEnvironment, type TraceSink } from './types.js';

export interface TraceOptions {
  /** Where traces go: your own storage. A plain function is a sink without `flush()`. */
  sink: TraceSink | ((trace: Trace) => void | Promise<void>);
  /**
   * Which traces hold the input text (and, for structured tasks, the outputs):
   * - `sent` (default): only runs whose input was sent to the cloud anyway. Nothing else leaves
   *   the device because of tracing; other runs are recorded without content.
   * - `all`: every run under the `auto` escalation policy, and corrections passed to
   *   `task.feedback()`. This sends inputs to your sink that the cascade kept on the device.
   *
   * Under `never`, and when consent was denied, a trace never holds content.
   */
  content?: 'sent' | 'all';
  /**
   * Applied to the content before it is stored: the input, and every string in a structured
   * output. Defaults to the task's `privacy.redact`. If it throws, the content is withheld.
   */
  redact?: (text: string) => string | Promise<string>;
  /** Recorded with every trace, e.g. the model version your app knows it runs. */
  environment?: Pick<TraceEnvironment, 'localModel' | 'cloudModel' | 'userAgent' | 'extra'>;
  /** A failing sink or redact hook never breaks a run; it is reported here. */
  onError?: (error: unknown) => void;
  /** Source of trace ids. Defaults to `crypto.randomUUID()`. */
  id?: () => string;
}

export interface TracedTask<S extends TaskSchema> extends Task<S> {
  /** Resolves once every trace recorded so far has been handed to the sink (and the sink flushed). */
  flush(): Promise<void>;
}

const STRICTNESS: Record<EscalationPolicy, number> = { auto: 0, consent: 1, never: 2 };

function randomId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  // Insecure contexts (plain http) have no randomUUID.
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function redactDeep(value: unknown, redact: (text: string) => string | Promise<string>): Promise<unknown> {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return Promise.all(value.map((v) => redactDeep(v, redact)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await redactDeep(v, redact);
    return out;
  }
  return value;
}

/**
 * `task()` with tracing: every run (and every `feedback()`) is also written to your sink as a
 * {@link Trace}. Takes the same options as `task()`. Tracing is separate from telemetry
 * (`onEvent`), whose events never hold content.
 *
 * Writing is not awaited by `run()`; call `flush()` before a page unloads or a script exits.
 */
export function tracedTask<S extends TaskSchema>(options: TaskOptions<S>, trace: TraceOptions): TracedTask<S> {
  if (!trace || (typeof trace.sink !== 'function' && typeof trace.sink?.write !== 'function')) {
    throw new BelayError('invalid-task', `task "${options.name}": tracing needs a sink`);
  }
  const content = trace.content ?? 'sent';
  if (content !== 'sent' && content !== 'all') {
    throw new BelayError('invalid-task', `task "${options.name}": trace content must be "sent" or "all"`);
  }
  const sink: TraceSink = typeof trace.sink === 'function' ? { write: trace.sink } : trace.sink;
  const redact = trace.redact ?? options.privacy?.redact;
  const newId = trace.id ?? randomId;
  const structured = options.schema.type === 'structured';
  const fingerprint = schemaFingerprint(options.schema);
  const exploreRate = typeof options.explore === 'number' ? options.explore : (options.explore?.rate ?? 0);

  const reportError = (error: unknown): void => {
    try {
      trace.onError?.(error);
    } catch {
      // Tracing must never break a run.
    }
  };

  // Run events carry what the result does not (the exploration weight, the cloud call's usage).
  // An event is emitted in the same turn its run resolves in, and matched to the result by its
  // latency, which both hold as the same number. Runs take their events in the order the events
  // were emitted, so of two events that look alike the first is the right one, as long as none
  // was dropped: the queue holds one event per run that is still under way, however many there are.
  const events: RunEvent[] = [];
  let underWay = 0;
  const inner = task<S>({
    ...options,
    onEvent(event: BelayEvent) {
      if (event.type === 'run') {
        events.push(event);
        // More events than runs under way: the oldest belongs to a run that failed after it.
        if (events.length > underWay) events.shift();
      }
      options.onEvent?.(event);
    },
  });
  const takeEvent = (result: BelayResult<ValueOf<S>>): RunEvent | undefined => {
    const i = events.findIndex((e) => e.latencyMs === result.latencyMs && e.source === result.source && e.threshold === result.threshold);
    return i === -1 ? undefined : events.splice(i, 1)[0];
  };

  const environmentOf = (event?: RunEvent): TraceEnvironment => {
    const userAgent = trace.environment?.userAgent ?? (globalThis.navigator as { userAgent?: string } | undefined)?.userAgent;
    return {
      localRunner: options.local.id,
      cloudRunner: options.cloud?.id ?? null,
      ...(userAgent ? { userAgent } : {}),
      ...(trace.environment?.localModel ? { localModel: trace.environment.localModel } : {}),
      ...(trace.environment?.cloudModel ? { cloudModel: trace.environment.cloudModel } : {}),
      ...(event?.calibratedAt ? { calibratedAt: event.calibratedAt } : {}),
      ...(trace.environment?.extra ? { extra: trace.environment.extra } : {}),
    };
  };

  const pending = new Set<Promise<void>>();
  /** Builds and writes a trace without making the caller wait. */
  const record = (build: () => Promise<Trace | null>): void => {
    const job = (async () => {
      try {
        const built = await build();
        if (built) await sink.write(built);
      } catch (error) {
        reportError(error);
      }
    })();
    pending.add(job);
    void job.finally(() => pending.delete(job));
  };

  /** The content of a trace, redacted; `null` when the redact hook failed (withheld, failing closed). */
  const redacted = async (input: string, values: unknown[]): Promise<{ input: string; values: unknown[] } | null> => {
    if (!redact) return { input, values };
    try {
      return {
        input: await redact(input),
        values: structured ? await Promise.all(values.map((v) => redactDeep(v, redact))) : values,
      };
    } catch (error) {
      reportError(error);
      return null;
    }
  };

  const basePolicy: EscalationPolicy = options.cloud ? (options.privacy?.escalation ?? 'auto') : 'never';

  async function run(input: string, runOptions: RunOptions = {}): Promise<BelayResult<ValueOf<S>>> {
    underWay++;
    let result: BelayResult<ValueOf<S>>;
    let event: RunEvent | undefined;
    try {
      result = await inner.run(input, runOptions);
      event = takeEvent(result);
    } finally {
      // Nothing is under way: what is left belongs to no run.
      if (--underWay === 0) events.length = 0;
    }
    const timestamp = Date.now();
    let policy = basePolicy;
    if (runOptions.escalation && STRICTNESS[runOptions.escalation] > STRICTNESS[policy]) policy = runOptions.escalation;

    record(async () => {
      // A failed cloud call still received the input.
      const sent = result.source === 'cloud' || result.escalationBlocked === 'cloud-error';
      const wanted = sent || (content === 'all' && policy === 'auto');
      const cloudValue = result.source === 'cloud' ? result.value : undefined;
      const shown = wanted ? await redacted(input, [result.local?.value, cloudValue]) : null;
      // Labels of classification tasks are not content: telemetry reports them too.
      const valueOf = (value: unknown, i: number): unknown => (shown ? shown.values[i] : structured ? null : value);

      const built: Trace = {
        version: TRACE_VERSION,
        id: newId(),
        kind: 'run',
        task: options.name,
        schemaFingerprint: fingerprint,
        timestamp,
        input: shown ? shown.input : null,
        redacted: !!shown && !!redact,
        label: null,
        environment: environmentOf(event),
        source: result.source,
        local: result.local
          ? {
              value: valueOf(result.local.value, 0),
              confidence: result.local.confidence,
              latencyMs: result.local.latencyMs,
              ...(result.local.probabilities ? { probabilities: result.local.probabilities } : {}),
            }
          : null,
        cloud:
          result.source === 'cloud'
            ? {
                value: valueOf(result.value, 1),
                confidence: result.confidence,
                ...(typeof event?.cloudLatencyMs === 'number' ? { latencyMs: event.cloudLatencyMs } : {}),
                ...(event?.cloudUsage ? { usage: event.cloudUsage } : {}),
              }
            : null,
        threshold: result.threshold,
        escalationReason: result.escalationReason,
        escalationBlocked: result.escalationBlocked,
        policy,
        latencyMs: result.latencyMs,
      };
      // A structured label whose content was withheld (the redact hook failed) is no label.
      if (result.source === 'cloud' && (shown || !structured)) {
        built.label = { value: built.cloud!.value, kind: 'silver', origin: 'cloud' };
      }
      if (result.escalationReason === 'exploration' && result.source === 'cloud' && exploreRate > 0) {
        // Uniform exploration always weighs 1; the informative strategy's weight is only in the event.
        const weight = event?.explorationWeight ?? (typeof options.explore === 'object' && options.explore.strategy === 'informative' ? undefined : 1);
        if (weight !== undefined) built.weight = weight / exploreRate;
      }
      return built;
    });
    return result;
  }

  async function feedback(input: string, value: ValueOf<S>, feedbackOptions?: FeedbackOptions): Promise<boolean> {
    const learned = await inner.feedback(input, value, feedbackOptions);
    // A correction's input was never sent anywhere, so it is only stored on an explicit `all`.
    if (content === 'all' && basePolicy === 'auto') {
      const timestamp = Date.now();
      record(async () => {
        const parsed = parseValue(options.schema, value);
        if (!parsed.ok) return null;
        const shown = await redacted(input, [parsed.value]);
        if (!shown) return null;
        return {
          version: TRACE_VERSION,
          id: newId(),
          kind: 'label',
          task: options.name,
          schemaFingerprint: fingerprint,
          timestamp,
          input: shown.input,
          redacted: !!redact,
          label: { value: shown.values[0], kind: 'gold', origin: 'feedback' },
          environment: environmentOf(),
        };
      });
    }
    return learned;
  }

  return {
    name: inner.name,
    schema: inner.schema,
    run,
    feedback,
    availability: () => inner.availability(),
    prepare: (prepareOptions) => inner.prepare(prepareOptions),
    threshold: () => inner.threshold(),
    destroy: () => inner.destroy(),
    async flush(): Promise<void> {
      while (pending.size) await Promise.all([...pending]);
      await sink.flush?.();
    },
  };
}

export interface LabelTraceOptions<S extends TaskSchema> {
  task: string;
  schema: S;
  input: string;
  value: ValueOf<S>;
  /** Defaults to `gold` for `dataset` and `feedback`, `silver` for `cloud` and `synthetic`. */
  kind?: LabelKind;
  /** Defaults to `dataset`. */
  origin?: LabelOrigin;
  /** Defaults to 0, so that importing the same dataset twice writes the same traces. */
  timestamp?: number;
  /** Defaults to the origin and the position, e.g. `dataset:12`, when `index` is given; else random. */
  id?: string;
  index?: number;
}

/**
 * A `label` trace for an input that did not come from a run: a row of an existing labeled
 * dataset (gold), or an example a teacher model wrote (`origin: 'synthetic'`, silver).
 */
export function labelTrace<S extends TaskSchema>(options: LabelTraceOptions<S>): Trace {
  const origin = options.origin ?? 'dataset';
  const parsed = parseValue(options.schema, options.value);
  if (!parsed.ok) throw new Error(`labelTrace: value does not match the schema of "${options.task}": ${parsed.error}`);
  return {
    version: TRACE_VERSION,
    id: options.id ?? (options.index !== undefined ? `${origin}:${options.index}` : randomId()),
    kind: 'label',
    task: options.task,
    schemaFingerprint: schemaFingerprint(options.schema),
    timestamp: options.timestamp ?? 0,
    input: options.input,
    redacted: false,
    label: { value: parsed.value, kind: options.kind ?? (origin === 'dataset' || origin === 'feedback' ? 'gold' : 'silver'), origin },
  };
}
