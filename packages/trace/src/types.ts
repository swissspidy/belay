/**
 * The trace format (v1). See docs/adr/0007-belay-tune-foundations.md.
 */
import type { CloudUsage, EscalationBlock, EscalationPolicy, EscalationReason, ProbabilityEntry } from '@swissspidy/belay-core';

export const TRACE_VERSION = 1;

/**
 * - `gold`: a person or a labeled dataset said so.
 * - `silver`: a model said so (the cloud's answer, or a teacher's synthetic example).
 */
export type LabelKind = 'gold' | 'silver';

/**
 * Where a label came from:
 * - `cloud`: the cloud runner's answer on an escalated or explored run (silver);
 * - `feedback`: a correction passed to `task.feedback()` (gold);
 * - `dataset`: an existing labeled dataset (gold);
 * - `synthetic`: a teacher model wrote the example from the task description (silver). Never
 *   part of a holdout.
 */
export type LabelOrigin = 'cloud' | 'feedback' | 'dataset' | 'synthetic';

export interface TraceLabel {
  value: unknown;
  kind: LabelKind;
  origin: LabelOrigin;
}

/** Where a run happened. Free-form extras (e.g. a model version) go in `extra`. */
export interface TraceEnvironment {
  /** `LocalRunner.id`, e.g. "classifier-api". */
  localRunner: string;
  cloudRunner: string | null;
  /** `navigator.userAgent`, which names the browser and its version. */
  userAgent?: string;
  /** Model names or versions, when the app knows them. */
  localModel?: string;
  cloudModel?: string;
  /** `createdAt` of the calibration file in use. */
  calibratedAt?: string;
  extra?: Record<string, string>;
}

/** The local attempt of a run. */
export interface TraceLocal {
  /** `null` when the content was withheld (structured tasks only; labels are always kept). */
  value: unknown;
  confidence: number;
  latencyMs: number;
  probabilities?: ProbabilityEntry[];
}

/**
 * One recorded run, or one label given outside a run.
 *
 * `input` is `null` when the run's content was withheld: by default a trace only holds the text
 * of inputs that were sent to the cloud anyway (see `TraceOptions.content`). Such a trace still
 * counts towards local share and the confidence distribution, like a telemetry event.
 */
export interface Trace {
  version: typeof TRACE_VERSION;
  /** Unique per trace. */
  id: string;
  /**
   * - `run`: one `task.run()`;
   * - `label`: a label for an input outside a run (`task.feedback()`, an imported dataset, a
   *   synthetic example).
   */
  kind: 'run' | 'label';
  task: string;
  /** `schemaFingerprint()` of the task, so traces of an older schema can be told apart. */
  schemaFingerprint: string;
  /** Milliseconds since the epoch. */
  timestamp: number;
  /** The input after redaction, or `null` when withheld. */
  input: string | null;
  /** Whether a redact hook ran over the content. */
  redacted: boolean;
  /** The label, when there is one: the cloud's answer, or the value given as feedback. */
  label: TraceLabel | null;
  /** Absent on labels that did not come from a task (`labelTrace()`). */
  environment?: TraceEnvironment;

  // ---- `run` traces only ---------------------------------------------------
  /** Which side's answer the run returned. */
  source?: 'local' | 'cloud';
  local?: TraceLocal | null;
  /** The cloud's answer, when the run reached it. */
  cloud?: { value: unknown; confidence: number | null; latencyMs?: number; usage?: CloudUsage[] } | null;
  threshold?: number;
  escalationReason?: EscalationReason | null;
  escalationBlocked?: EscalationBlock | null;
  /** The escalation policy in effect for the run. */
  policy?: EscalationPolicy;
  latencyMs?: number;
  /**
   * `exploration` runs only: how many confident runs this one stands for
   * (`explorationWeight / rate`). A dataset weighs the run by it, so that the confident runs,
   * which are only checked at the exploration rate, count as often as they occur.
   */
  weight?: number;
}

/** Receives traces. Write to your own storage: Belay hosts nothing. */
export interface TraceSink {
  write(trace: Trace): void | Promise<void>;
  /** Resolves once everything written so far is stored. */
  flush?(): Promise<void>;
}
