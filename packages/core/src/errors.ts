export type BelayErrorCode =
  /** No local output and escalation was not possible or not permitted. */
  | 'no-result'
  /** The cloud runner threw or returned an output that does not match the schema. */
  | 'cloud-error'
  | 'cloud-invalid-output'
  /** The task definition is invalid. */
  | 'invalid-task'
  /** The calibration file is malformed or does not belong to this task. */
  | 'invalid-calibration';

export class BelayError extends Error {
  override readonly name = 'BelayError';
  readonly code: BelayErrorCode;

  constructor(code: BelayErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/**
 * Thrown by a local runner from `run()` when the model is not usable (e.g. it would need
 * a download). The cascade treats it as escalation reason `local-unavailable`.
 */
export class LocalUnavailableError extends Error {
  override readonly name = 'LocalUnavailableError';
}
