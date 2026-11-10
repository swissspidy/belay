import { TRACE_VERSION, type Trace } from './types.js';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Checks the fields every reader relies on and returns the value as a `Trace`. Throws on anything
 * else: a sink is the developer's own storage, so its contents are not trusted blindly.
 */
export function parseTrace(value: unknown): Trace {
  if (!isObject(value)) throw new Error('trace is not an object');
  if (value['version'] !== TRACE_VERSION) throw new Error(`unsupported trace version ${JSON.stringify(value['version'])} (expected ${TRACE_VERSION})`);
  if (typeof value['id'] !== 'string' || !value['id']) throw new Error('trace has no id');
  if (value['kind'] !== 'run' && value['kind'] !== 'label') throw new Error(`trace ${value['id']}: kind must be "run" or "label"`);
  if (typeof value['task'] !== 'string' || !value['task']) throw new Error(`trace ${value['id']}: no task`);
  if (typeof value['schemaFingerprint'] !== 'string') throw new Error(`trace ${value['id']}: no schemaFingerprint`);
  if (typeof value['timestamp'] !== 'number' || !Number.isFinite(value['timestamp'])) throw new Error(`trace ${value['id']}: no timestamp`);
  if (value['input'] !== null && typeof value['input'] !== 'string') throw new Error(`trace ${value['id']}: input must be a string or null`);
  const label = value['label'];
  if (label !== null) {
    if (!isObject(label) || !('value' in label)) throw new Error(`trace ${value['id']}: malformed label`);
    if (label['kind'] !== 'gold' && label['kind'] !== 'silver') throw new Error(`trace ${value['id']}: label kind must be "gold" or "silver"`);
    if (!['cloud', 'feedback', 'dataset', 'synthetic'].includes(label['origin'] as string)) throw new Error(`trace ${value['id']}: unknown label origin`);
  }
  if (value['weight'] !== undefined && !(typeof value['weight'] === 'number' && value['weight'] > 0 && Number.isFinite(value['weight']))) {
    throw new Error(`trace ${value['id']}: weight must be a positive number`);
  }
  return value as unknown as Trace;
}
