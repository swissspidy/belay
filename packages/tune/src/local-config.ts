/**
 * The local config: everything tunable about the local side of one task on one backend, as data.
 * Browser-safe (`@swissspidy/belay-tune/config`): an app applies it with `withLocalConfig()`.
 * See ADR 0007 §3.
 */
import { canonicalJson, fnv1a, labelOf, normalizeOptions, parseValue, type LocalRunner, type TaskSchema } from '@swissspidy/belay-core';

export const LOCAL_CONFIG_VERSION = 1;

export interface LocalConfigExample {
  input: string;
  label: unknown;
}

export interface LocalConfig {
  version: typeof LOCAL_CONFIG_VERSION;
  task: string;
  /** Which local runner (and model) this config was tuned for. A config is not portable. */
  backend: { runner: string; model?: string };
  /** Rewordings for the local model only. The task's schema and the cloud's prompt do not change. */
  wording?: { prompt?: string; options?: Record<string, string> };
  /** Replaces the task's context for the local model. */
  context?: string;
  /** Short rules, each with the action to take. */
  rules?: string[];
  /** Few-shot examples, in order. */
  examples?: LocalConfigExample[];
}

/** The parts of a config a candidate may change, per rung of the ladder. */
export const TUNABLE_ROOTS = ['wording', 'context', 'rules', 'examples'] as const;
export type TunableRoot = (typeof TUNABLE_ROOTS)[number];

/** An RFC 6902 operation on a local config (`add`, `remove` and `replace` only). */
export interface ConfigPatchOp {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: unknown;
}

export function emptyLocalConfig(task: string, backend: LocalConfig['backend']): LocalConfig {
  return { version: LOCAL_CONFIG_VERSION, task, backend };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Validates an unknown value as a local config of this task. Throws on anything else. */
export function parseLocalConfig(value: unknown, task: string, schema: TaskSchema): LocalConfig {
  if (!isObject(value)) throw new Error('local config is not an object');
  if (value['version'] !== LOCAL_CONFIG_VERSION) throw new Error(`unsupported local config version ${JSON.stringify(value['version'])}`);
  if (value['task'] !== task) throw new Error(`local config is for task ${JSON.stringify(value['task'])}, not "${task}"`);
  const backend = value['backend'];
  if (!isObject(backend) || typeof backend['runner'] !== 'string') throw new Error('local config has no backend.runner');
  for (const key of Object.keys(value)) {
    if (!['version', 'task', 'backend', ...TUNABLE_ROOTS].includes(key)) throw new Error(`local config has an unknown field "${key}"`);
  }
  const config: LocalConfig = { version: LOCAL_CONFIG_VERSION, task, backend: { runner: backend['runner'], ...(typeof backend['model'] === 'string' ? { model: backend['model'] } : {}) } };
  if (value['context'] !== undefined) {
    if (typeof value['context'] !== 'string') throw new Error('local config: context must be a string');
    config.context = value['context'];
  }
  if (value['rules'] !== undefined) {
    if (!Array.isArray(value['rules']) || value['rules'].some((r) => typeof r !== 'string' || !r.trim())) throw new Error('local config: rules must be non-empty strings');
    config.rules = value['rules'].map((r: string) => r.trim());
  }
  if (value['examples'] !== undefined) {
    if (!Array.isArray(value['examples'])) throw new Error('local config: examples must be an array');
    config.examples = value['examples'].map((e: unknown, i) => {
      if (!isObject(e) || typeof e['input'] !== 'string') throw new Error(`local config: example ${i + 1} has no input`);
      const label = parseValue(schema, e['label']);
      if (!label.ok) throw new Error(`local config: example ${i + 1}: ${label.error}`);
      return { input: e['input'], label: label.value };
    });
  }
  if (value['wording'] !== undefined) {
    const wording = value['wording'];
    if (!isObject(wording)) throw new Error('local config: wording must be an object');
    const out: NonNullable<LocalConfig['wording']> = {};
    if (wording['prompt'] !== undefined) {
      if (typeof wording['prompt'] !== 'string') throw new Error('local config: wording.prompt must be a string');
      out.prompt = wording['prompt'];
    }
    if (wording['options'] !== undefined) {
      if (schema.type !== 'categorical' && schema.type !== 'ordinal') throw new Error('local config: wording.options needs a task with options');
      const labels = new Set(normalizeOptions(schema.options).map((o) => o.label));
      if (!isObject(wording['options'])) throw new Error('local config: wording.options must be an object');
      for (const [label, description] of Object.entries(wording['options'])) {
        // Labels are the task's values: they can be described differently, never renamed.
        if (!labels.has(label)) throw new Error(`local config: wording.options names "${label}", which is not an option of the task`);
        if (typeof description !== 'string') throw new Error(`local config: wording.options["${label}"] must be a string`);
      }
      out.options = wording['options'] as Record<string, string>;
    }
    config.wording = out;
  }
  return config;
}

/** A hash of what the config does. Two configs with the same fingerprint behave the same. */
export function localConfigFingerprint(config: LocalConfig): string {
  const { wording, context, rules, examples } = config;
  return `fnv1a:${fnv1a(canonicalJson({ wording: wording ?? null, context: context ?? null, rules: rules?.length ? rules : null, examples: examples?.length ? examples : null }))}`;
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The context the local model is given: the context, then the rules, then the examples. */
export function renderContext(schema: TaskSchema, taskContext: string | undefined, config: LocalConfig): string | undefined {
  const parts: string[] = [];
  const context = config.context ?? taskContext;
  if (context) parts.push(context);
  if (config.rules?.length) parts.push(['Rules:', ...config.rules.map((r) => `- ${r}`)].join('\n'));
  if (config.examples?.length) {
    parts.push(
      ['Examples:', ...config.examples.map((e) => `"${clip(e.input, 160)}" -> ${labelOf(schema, e.label) ?? JSON.stringify(e.label)}`)].join('\n'),
    );
  }
  return parts.length ? parts.join('\n\n') : undefined;
}

/** What the local model sees under a config: the reworded schema and the rendered context. */
export function applyLocalConfig<S extends TaskSchema>(schema: S, taskContext: string | undefined, config: LocalConfig): { schema: S; context?: string } {
  let effective: TaskSchema = schema;
  const wording = config.wording;
  if (wording) {
    if (wording.prompt !== undefined) effective = { ...effective, prompt: wording.prompt } as TaskSchema;
    if (wording.options && (effective.type === 'categorical' || effective.type === 'ordinal')) {
      const descriptions = wording.options;
      effective = {
        ...effective,
        options: normalizeOptions(effective.options).map((o) => (Object.hasOwn(descriptions, o.label) ? { label: o.label, description: descriptions[o.label]! } : o)),
      };
    }
  }
  const context = renderContext(schema, taskContext, config);
  return { schema: effective as S, ...(context ? { context } : {}) };
}

/** How much the config adds to the local model's input, in characters: the stand-in for a token count. */
export function contextSize(schema: TaskSchema, taskContext: string | undefined, config: LocalConfig): number {
  const applied = applyLocalConfig(schema, taskContext, config);
  const options = applied.schema.type === 'categorical' || applied.schema.type === 'ordinal' ? normalizeOptions(applied.schema.options) : [];
  return (applied.context?.length ?? 0) + ((applied.schema as { prompt?: string }).prompt?.length ?? 0) + options.reduce((n, o) => n + o.label.length + (o.description?.length ?? 0), 0);
}

/**
 * Wraps a local runner so that it runs under a local config: it is handed the reworded schema and
 * the rendered context. The task itself, its values and the cloud's prompt are untouched.
 *
 * ```ts
 * task({ name, schema, local: withLocalConfig(classifierApi(), config), cloud, calibration });
 * ```
 */
export function withLocalConfig<S extends TaskSchema>(runner: LocalRunner<S>, config: LocalConfig): LocalRunner<S> {
  type Ctx = Parameters<LocalRunner<S>['run']>[1];
  const map = (ctx: Ctx): Ctx => {
    const applied = applyLocalConfig(ctx.schema, ctx.context, config);
    const { context: _dropped, ...rest } = ctx;
    return { ...rest, schema: applied.schema, ...(applied.context ? { context: applied.context } : {}) };
  };
  return {
    id: runner.id,
    availability: (ctx) => runner.availability(map(ctx)),
    run: (input, ctx) => runner.run(input, map(ctx)),
    ...(runner.prepare ? { prepare: (ctx, options) => runner.prepare!(map(ctx), options) } : {}),
    ...(runner.destroy ? { destroy: () => runner.destroy!() } : {}),
    // Learning is about the task, not the wording: the original context is passed on.
    ...(runner.learn ? { learn: (example, ctx) => runner.learn!(example, ctx) } : {}),
  };
}

function pointer(path: string): string[] {
  if (!path.startsWith('/')) throw new Error(`patch path "${path}" must start with "/"`);
  return path.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/**
 * Applies a patch and returns the new config. Only the roots in `allowed` may be touched; the
 * result is validated like a config read from disk.
 */
export function applyConfigPatch(config: LocalConfig, patch: readonly ConfigPatchOp[], schema: TaskSchema, allowed: readonly TunableRoot[] = TUNABLE_ROOTS): LocalConfig {
  const next = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  for (const op of patch) {
    const parts = pointer(op.path);
    const root = parts[0] as TunableRoot;
    if (!allowed.includes(root)) throw new Error(`a candidate may not change "${op.path}" (allowed: ${allowed.join(', ')})`);
    let parent: unknown = next;
    for (const part of parts.slice(0, -1)) {
      if (Array.isArray(parent)) parent = parent[Number(part)];
      else if (isObject(parent)) parent = parent[part];
      else throw new Error(`patch path "${op.path}" does not exist`);
    }
    const key = parts[parts.length - 1]!;
    if (Array.isArray(parent)) {
      const index = key === '-' ? parent.length : Number(key);
      if (!(Number.isInteger(index) && index >= 0 && index <= parent.length - (op.op === 'add' ? 0 : 1))) throw new Error(`patch path "${op.path}" is out of range`);
      if (op.op === 'add') parent.splice(index, 0, op.value);
      else if (op.op === 'remove') parent.splice(index, 1);
      else parent[index] = op.value;
    } else if (isObject(parent)) {
      if (op.op === 'remove') delete parent[key];
      else parent[key] = op.value;
    } else {
      throw new Error(`patch path "${op.path}" does not exist`);
    }
  }
  return parseLocalConfig(next, config.task, schema);
}
