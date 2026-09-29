import { BelayError } from './errors.js';
import { canonicalJson, fnv1a } from './hash.js';
import type { OptionInput, OptionSpec, TaskSchema, ValueOf } from './types.js';

export function normalizeOptions(options: readonly OptionInput[]): OptionSpec[] {
  return options.map((o) => (typeof o === 'string' ? { label: o } : { ...o }));
}

export function optionLabels(schema: TaskSchema): string[] {
  switch (schema.type) {
    case 'binary':
      return ['true', 'false'];
    case 'categorical':
    case 'ordinal':
      return normalizeOptions(schema.options).map((o) => o.label);
    case 'structured':
      return [];
  }
}

/** Throws `BelayError('invalid-task')` if the schema is malformed. */
export function assertValidSchema(schema: TaskSchema): void {
  const fail = (msg: string): never => {
    throw new BelayError('invalid-task', msg);
  };
  if (!schema || typeof schema !== 'object') fail('schema must be an object');
  switch (schema.type) {
    case 'binary':
      if (typeof schema.prompt !== 'string' || !schema.prompt.trim()) fail('binary schema needs a prompt');
      return;
    case 'categorical':
    case 'ordinal': {
      if (!Array.isArray(schema.options) || schema.options.length < 2) {
        fail(`${schema.type} schema needs at least two options`);
      }
      const labels = optionLabels(schema);
      if (labels.some((l) => typeof l !== 'string' || !l)) fail('option labels must be non-empty strings');
      if (new Set(labels).size !== labels.length) fail('option labels must be unique');
      return;
    }
    case 'structured':
      if (!schema.jsonSchema || typeof schema.jsonSchema !== 'object') fail('structured schema needs jsonSchema');
      if (typeof schema.validate !== 'function') fail('structured schema needs a validate function');
      return;
    default:
      fail(`unknown schema type ${(schema as { type: unknown }).type as string}`);
  }
}

/**
 * Fingerprint of everything in the schema that influences model behavior (type, prompt,
 * option labels and descriptions, JSON Schema). Stored in calibration files so a task can
 * tell when its calibration was produced for a different schema.
 */
export function schemaFingerprint(schema: TaskSchema): string {
  const { type, prompt } = schema as { type: string; prompt?: string };
  const shape: Record<string, unknown> = { type, prompt: prompt ?? null };
  if (schema.type === 'categorical' || schema.type === 'ordinal') shape['options'] = normalizeOptions(schema.options);
  if (schema.type === 'structured') shape['jsonSchema'] = schema.jsonSchema;
  return `fnv1a:${fnv1a(canonicalJson(shape))}`;
}

/**
 * JSON Schema of the output. Non-structured outputs are wrapped as `{ "value": ... }`
 * because many providers require an object at the root.
 */
export function toJsonSchema(schema: TaskSchema): Record<string, unknown> {
  const wrap = (value: Record<string, unknown>) => ({
    type: 'object',
    properties: { value },
    required: ['value'],
    additionalProperties: false,
  });
  switch (schema.type) {
    case 'binary':
      return wrap({ type: 'boolean' });
    case 'categorical':
    case 'ordinal':
      return wrap({ type: 'string', enum: optionLabels(schema) });
    case 'structured':
      return schema.jsonSchema;
  }
}

/** A provider-neutral instruction for cloud runners that build their own prompt from it. */
export function buildInstruction(schema: TaskSchema, context?: string): string {
  const lines: string[] = [];
  if (context) lines.push(context);
  switch (schema.type) {
    case 'binary':
      lines.push(`Answer the question about the input with true or false: ${schema.prompt}`);
      lines.push('Respond with JSON: {"value": true} or {"value": false}.');
      break;
    case 'categorical':
    case 'ordinal': {
      lines.push(schema.prompt ?? 'Classify the input into exactly one of the options.');
      lines.push(schema.type === 'ordinal' ? 'Options, ordered from lowest to highest:' : 'Options:');
      for (const o of normalizeOptions(schema.options)) {
        lines.push(o.description ? `- ${o.label}: ${o.description}` : `- ${o.label}`);
      }
      lines.push('Respond with JSON: {"value": "<one option label>"}.');
      break;
    }
    case 'structured':
      if (schema.prompt) lines.push(schema.prompt);
      lines.push('Respond with JSON matching this JSON Schema:');
      lines.push(JSON.stringify(schema.jsonSchema));
      break;
  }
  return lines.join('\n');
}

export type ParseResult<V> = { ok: true; value: V } | { ok: false; error: string };

/**
 * Coerces a runner output into the schema's value type. Accepts the bare value or the
 * `{ value }` wrapper from {@link toJsonSchema}, and JSON strings of either.
 */
export function parseValue<S extends TaskSchema>(schema: S, raw: unknown): ParseResult<ValueOf<S>> {
  const ok = (value: unknown): ParseResult<ValueOf<S>> => ({ ok: true, value: value as ValueOf<S> });
  const err = (error: string): ParseResult<ValueOf<S>> => ({ ok: false, error });

  let candidate = raw;
  if (typeof candidate === 'string' && schema.type === 'structured') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return err('output is not valid JSON');
    }
  }
  if (typeof candidate === 'string' && /^\s*\{/.test(candidate)) {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      // fall through: treat as a plain string
    }
  }

  if (schema.type === 'structured') {
    return schema.validate(candidate) ? ok(candidate) : err('output failed schema validation');
  }

  if (candidate && typeof candidate === 'object' && 'value' in candidate) {
    candidate = (candidate as { value: unknown }).value;
  }

  if (schema.type === 'binary') {
    if (typeof candidate === 'boolean') return ok(candidate);
    if (typeof candidate === 'string') {
      const s = candidate.trim().toLowerCase();
      if (s === 'true' || s === 'yes') return ok(true);
      if (s === 'false' || s === 'no') return ok(false);
    }
    return err(`expected a boolean, got ${JSON.stringify(candidate)}`);
  }

  const labels = optionLabels(schema);
  if (typeof candidate === 'number' && schema.type === 'ordinal') candidate = String(candidate);
  if (typeof candidate !== 'string') return err(`expected one of ${labels.join(', ')}`);
  if (labels.includes(candidate)) return ok(candidate);
  const folded = candidate.trim().toLowerCase();
  const match = labels.find((l) => l.toLowerCase() === folded);
  return match !== undefined ? ok(match) : err(`"${candidate}" is not one of ${labels.join(', ')}`);
}

/** Label of a value for telemetry and per-label thresholds; `undefined` for structured tasks. */
export function labelOf(schema: TaskSchema, value: unknown): string | undefined {
  if (schema.type === 'structured') return undefined;
  return String(value);
}
