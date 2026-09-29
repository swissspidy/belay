/**
 * Public types for @belay/core. See docs/adr/0001-public-api-confidence-and-calibration.md.
 */

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

/** An option of a categorical or ordinal task. Plain strings are shorthand for `{ label }`. */
export interface OptionSpec {
  /** Stable identifier returned as the task value. */
  label: string;
  /** Optional natural-language hint for the model(s). */
  description?: string;
}

export type OptionInput = string | OptionSpec;

export interface BinarySchema {
  type: 'binary';
  /** The yes/no question, e.g. "Does this comment contain a personal attack?" */
  prompt: string;
}

export interface CategoricalSchema<L extends string = string> {
  type: 'categorical';
  options: readonly (L | (OptionSpec & { label: L }))[];
  /** Optional question, e.g. "Which department should handle this ticket?" */
  prompt?: string;
}

export interface OrdinalSchema<L extends string = string> {
  type: 'ordinal';
  /** Ordered from lowest to highest. */
  options: readonly (L | (OptionSpec & { label: L }))[];
  prompt?: string;
}

export type ValidationResult = true | { valid: false; errors: string[] };

export interface StructuredSchema<T = unknown> {
  type: 'structured';
  /** JSON Schema handed to the Prompt API (`responseConstraint`) and to the cloud adapter. */
  jsonSchema: Record<string, unknown>;
  /**
   * Validates a parsed candidate. @belay/core has no runtime dependencies and therefore
   * no JSON Schema validator; plug in your own (Ajv, Zod, a hand-written guard, ...).
   */
  validate: (value: unknown) => value is T;
  prompt?: string;
}

export type TaskSchema =
  | BinarySchema
  | CategoricalSchema
  | OrdinalSchema
  | StructuredSchema<any>;

/** The value type a schema produces. */
export type ValueOf<S extends TaskSchema> = S extends BinarySchema
  ? boolean
  : S extends CategoricalSchema<infer L>
    ? L
    : S extends OrdinalSchema<infer L>
      ? L
      : S extends StructuredSchema<infer T>
        ? T
        : never;

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

/** Mirrors the availability states used by Chrome's built-in AI APIs. */
export type Availability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

export interface ProbabilityEntry {
  label: string;
  probability: number;
}

export interface RunnerContext<S extends TaskSchema = TaskSchema> {
  task: string;
  schema: S;
  /** Optional task-level context shared by local and cloud runners. */
  context?: string;
  signal?: AbortSignal;
}

export interface LocalOutput<V = unknown> {
  value: V;
  /**
   * Confidence in [0, 1]. Classifier runners report the calibrated probability of the
   * top option. Generation runners may omit it and let the task's `judge` compute it.
   */
  confidence?: number;
  /** Full distribution when the runner has one (classifier tasks). */
  probabilities?: ProbabilityEntry[];
  /** Runner-specific diagnostics; never sent to telemetry. */
  raw?: unknown;
}

export interface LocalRunner<S extends TaskSchema = TaskSchema> {
  /** Short identifier used in telemetry and calibration files, e.g. "classifier-api". */
  readonly id: string;
  /** Must never trigger a model download. */
  availability(ctx: RunnerContext<S>): Promise<Availability>;
  /**
   * Called only when `availability()` resolved to "available". Must never trigger a model download.
   * May throw {@link LocalUnavailableError} if the model became unavailable meanwhile.
   */
  run(input: string, ctx: RunnerContext<S>): Promise<LocalOutput<ValueOf<S>>>;
  /**
   * Download / warm up the model. Call from a user gesture (click handler).
   * Optional: runners without a download step may omit it.
   */
  prepare?(ctx: RunnerContext<S>, options?: PrepareOptions): Promise<void>;
  /** Release resources. */
  destroy?(): void;
}

export interface PrepareOptions {
  /** Download progress in [0, 1]. */
  onProgress?: (loaded: number) => void;
  signal?: AbortSignal;
}

export interface CloudRequest<S extends TaskSchema = TaskSchema> {
  task: string;
  schema: S;
  /** JSON Schema of the expected output, for providers with structured output. */
  jsonSchema: Record<string, unknown>;
  /** A ready-to-use instruction describing the task and the output format. */
  instruction: string;
  /** Input after redaction. */
  input: string;
  context?: string;
  /** The local attempt, when there was one. Lets a cloud prompt say "a small model guessed X". */
  local?: { value: unknown; confidence: number | null };
}

export interface CloudOutput<V = unknown> {
  value: V;
  /** Optional confidence if the provider exposes one (e.g. from logprobs). */
  confidence?: number;
  raw?: unknown;
}

export interface CloudRunner<S extends TaskSchema = TaskSchema> {
  readonly id: string;
  /** The returned `value` is validated against the schema by the task (see `parseValue()`). */
  run(request: CloudRequest<S>, options: { signal?: AbortSignal }): Promise<CloudOutput>;
}

/** Judges a generated output: resolves to P(output is correct and complete) in [0, 1]. */
export type Judge<V = unknown> = (
  args: { input: string; value: V; task: string; signal?: AbortSignal },
) => Promise<number>;

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

/**
 * - `auto`: escalate whenever the cascade decides to (default).
 * - `never`: never send anything to the cloud runner.
 * - `consent`: ask the `consent` callback before every escalation.
 */
export type EscalationPolicy = 'auto' | 'never' | 'consent';

export interface ConsentRequest {
  task: string;
  reason: EscalationReason;
  /** The redacted input that would be sent. */
  input: string;
  local: { value: unknown; confidence: number | null } | null;
}

export interface PrivacyOptions {
  escalation?: EscalationPolicy;
  /** Required when `escalation` is `consent`. */
  consent?: (request: ConsentRequest) => boolean | Promise<boolean>;
  /** Applied to the input before any cloud call (and before `consent`). */
  redact?: (input: string) => string | Promise<string>;
}

// ---------------------------------------------------------------------------
// Tasks and results
// ---------------------------------------------------------------------------

export type EscalationReason =
  /** Local confidence was below the threshold. */
  | 'low-confidence'
  /** The local runner reported the model is not ready (unavailable / not downloaded). */
  | 'local-unavailable'
  /** The local runner threw. */
  | 'local-error'
  /** The local runner exceeded `localTimeoutMs`. */
  | 'local-timeout'
  /** The local output failed schema validation. */
  | 'invalid-output';

/**
 * Why a wanted escalation did not produce the result:
 * - `policy`: escalation is disabled (`never`, no cloud runner, or the redact hook failed);
 * - `consent-denied`: the consent callback returned false (or threw);
 * - `cloud-error`: the cloud runner failed; the local result is returned instead.
 */
export type EscalationBlock = 'policy' | 'consent-denied' | 'cloud-error';

export interface BelayResult<V = unknown> {
  value: V;
  /**
   * Confidence of the returned value: the local confidence when `source` is "local";
   * the cloud's own confidence (if its adapter reports one) or `null` when `source` is "cloud".
   */
  confidence: number | null;
  source: 'local' | 'cloud';
  /** Total wall-clock time of `run()`. */
  latencyMs: number;
  /** Why the cascade wanted to escalate; `null` if the local result was accepted. */
  escalationReason: EscalationReason | null;
  /** Set when the cascade wanted to escalate but returned the local result instead. */
  escalationBlocked: EscalationBlock | null;
  /** Threshold in effect for this run. */
  threshold: number;
  /** The local attempt, if the local runner produced an output. */
  local: { value: V; confidence: number; latencyMs: number; probabilities?: ProbabilityEntry[] } | null;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Per-run override of the task's escalation policy (can only be stricter: see ADR). */
  escalation?: EscalationPolicy;
  /** Per-run context appended to the task context. */
  context?: string;
}

export interface TaskOptions<S extends TaskSchema> {
  name: string;
  schema: S;
  local: LocalRunner<NoInfer<S>>;
  /** Optional: without a cloud runner the task behaves as `escalation: 'never'`. */
  cloud?: CloudRunner<NoInfer<S>>;
  /** Fixed threshold. Also used as the fallback when a calibration fails to load. */
  threshold?: number;
  /** A calibration file object, a URL to fetch it from, or a loader. */
  calibration?: CalibrationFile | string | URL | (() => Promise<CalibrationFile>);
  /** Context shared by local and cloud runners, e.g. "Support tickets for a SaaS billing product". */
  context?: string;
  /** For generation tasks: estimates P(correct). Combined with schema validation. */
  judge?: Judge<ValueOf<NoInfer<S>>>;
  privacy?: PrivacyOptions;
  /** Escalate if the local runner takes longer than this. */
  localTimeoutMs?: number;
  onEvent?: (event: BelayEvent) => void;
}

export interface Task<S extends TaskSchema> {
  readonly name: string;
  readonly schema: S;
  run(input: string, options?: RunOptions): Promise<BelayResult<ValueOf<S>>>;
  availability(): Promise<Availability>;
  /** Downloads the local model. Call from a user gesture. */
  prepare(options?: PrepareOptions): Promise<void>;
  /** Resolves the threshold (loading the calibration if needed). */
  threshold(): Promise<number>;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** Emitted once per run. Never contains the input or the output text of structured tasks. */
export interface RunEvent {
  type: 'run';
  task: string;
  timestamp: number;
  source: 'local' | 'cloud';
  /** Categorical/ordinal/binary label of the returned value (omitted for structured tasks). */
  label?: string;
  confidence: number | null;
  localConfidence: number | null;
  threshold: number;
  thresholdSource: 'calibration' | 'manual';
  /** `createdAt` of the calibration file in use, to correlate metrics with calibrations. */
  calibratedAt: string | null;
  escalationReason: EscalationReason | null;
  escalationBlocked: EscalationBlock | null;
  latencyMs: number;
  localLatencyMs: number | null;
  cloudLatencyMs: number | null;
  localRunner: string;
  cloudRunner: string | null;
}

export interface ErrorEvent {
  type: 'error';
  task: string;
  timestamp: number;
  stage: 'local' | 'cloud' | 'calibration' | 'consent' | 'redact';
  message: string;
}

export type BelayEvent = RunEvent | ErrorEvent;

// ---------------------------------------------------------------------------
// Calibration file (v1). See the ADR for semantics.
// ---------------------------------------------------------------------------

export interface CalibrationCurvePoint {
  threshold: number;
  /** Accuracy of the whole cascade at this threshold. */
  accuracy: number;
  /** Fraction of examples answered locally. */
  localShare: number;
  /** Accuracy on the examples answered locally. */
  localAccuracy: number | null;
  /** Estimated cloud cost per 1,000 runs (in `cost.currency`), when cost data was supplied. */
  costPer1k?: number;
}

export interface CalibrationFile {
  version: 1;
  task: string;
  /** Fingerprint of the task schema (see `schemaFingerprint()`); used to detect stale files. */
  schemaFingerprint: string;
  createdAt: string;
  local: { runner: string; model?: string; userAgent?: string };
  cloud: { runner: string; model?: string } | null;
  dataset: { size: number; fingerprint: string };
  target: { metric: 'accuracy'; value: number };
  /** Recommended global threshold. */
  threshold: number;
  /** Optional per-label overrides, keyed by the local top label. */
  thresholds?: Record<string, number>;
  expected: {
    accuracy: number;
    localShare: number;
    localAccuracy: number | null;
    cloudAccuracy: number | null;
    costPer1k?: number;
  };
  cost?: { currency: string; cloudPerRun: number };
  curve: CalibrationCurvePoint[];
  /** Histogram of local confidences over the dataset, for drift detection. */
  confidenceHistogram: { edges: number[]; counts: number[] };
  confusion?: {
    labels: string[];
    /** `matrix[i][j]`: examples with true label i that the local runner predicted as j. */
    local: number[][];
  };
}
