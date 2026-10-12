import { BelayError, labelOf, optionLabels, parseValue, schemaFingerprint } from '@swissspidy/belay-core';
import type { TaskSchema } from '@swissspidy/belay-core';
import type { CalibrationPair } from './calibrator.js';
import type { Embedder } from './embedder.js';
import { knnPredict, type HeadExample } from './head.js';
import { decodeInt8, encodeInt8 } from './vector.js';

export const SEED_VERSION = 1;

/**
 * Labeled embeddings shipped with an app, so a learned classifier starts with some knowledge
 * instead of none (`belay-seed.json`). Holds no input text.
 */
export interface SeedFile {
  version: 1;
  task: string;
  /** `schemaFingerprint()` of the task schema. */
  schemaFingerprint: string;
  /** `Embedder.id` of the model that made the embeddings. */
  embedder: string;
  dimensions: number;
  createdAt: string;
  /** Embeddings as base64 int8 (see `encodeInt8()`). */
  examples: { label: string; embedding: string }[];
  /** Leave-one-out kNN calibration pairs, so confidences are calibrated from the first run. */
  pairs?: { knn: CalibrationPair[] };
}

export interface BuildSeedOptions<S extends TaskSchema> {
  task: string;
  schema: S;
  embedder: Embedder;
  /** Labeled inputs; `value` is validated against the schema like a cloud answer. */
  examples: readonly { input: string; value: unknown }[];
  /** kNN settings for the leave-one-out pairs; use the classifier's. Defaults to k 7, temperature 0.1. */
  knn?: { k?: number; temperature?: number };
  /** Defaults to now; pass a fixed date for reproducible files. */
  createdAt?: string | Date;
  signal?: AbortSignal;
}

/**
 * Embeds labeled inputs into a seed file. Runs wherever the embedder runs: in Node at build time
 * with the same transformers.js model the page uses, or in the page itself.
 */
export async function buildSeed<S extends TaskSchema>(options: BuildSeedOptions<S>): Promise<SeedFile> {
  const { schema, embedder } = options;
  const labels = optionLabels(schema);
  if (!labels.length) throw new BelayError('invalid-task', 'seed files are for binary, categorical and ordinal tasks');
  const items = options.examples.map((e, i) => {
    const parsed = parseValue(schema, e.value);
    if (!parsed.ok) throw new BelayError('invalid-task', `seed example ${i + 1}: value does not match the schema`);
    return { input: e.input, label: labelOf(schema, parsed.value)! };
  });
  if ((await embedder.availability()) !== 'available') await embedder.prepare?.(options.signal ? { signal: options.signal } : {});
  const vectors = await embedder.embed(
    items.map((e) => e.input),
    options.signal ? { signal: options.signal } : {},
  );
  const encoded = vectors.map((v) => encodeInt8(v));
  // Pairs from the decoded (quantized) vectors: what the classifier will see.
  const head: HeadExample[] = encoded.map((e, i) => ({ embedding: decodeInt8(e), label: labels.indexOf(items[i]!.label), weight: 1 }));
  const k = options.knn?.k ?? 7;
  const temperature = options.knn?.temperature ?? 0.1;
  const pairs: CalibrationPair[] = head.map((e, i) => {
    const others = head.filter((_, j) => j !== i);
    const p = knnPredict(others, e.embedding, labels.length, { k, temperature });
    let top = 0;
    for (let l = 1; l < p.length; l++) if (p[l]! > p[top]!) top = l;
    return { score: p[top]!, correct: top === e.label };
  });
  const createdAt = new Date(options.createdAt ?? Date.now()).toISOString();
  return {
    version: SEED_VERSION,
    task: options.task,
    schemaFingerprint: schemaFingerprint(schema),
    embedder: embedder.id,
    dimensions: vectors[0]?.length ?? 0,
    createdAt,
    examples: items.map((e, i) => ({ label: e.label, embedding: encoded[i]! })),
    ...(items.length > 1 ? { pairs: { knn: pairs } } : {}),
  };
}

/** Checks a parsed seed file's shape. */
export function parseSeed(value: unknown): SeedFile {
  const s = value as SeedFile;
  if (!s || typeof s !== 'object' || s.version !== SEED_VERSION || !Array.isArray(s.examples) || typeof s.embedder !== 'string') {
    throw new BelayError('invalid-task', `not a Belay seed file (version ${SEED_VERSION})`);
  }
  return s;
}

/** Loads a seed from an object, a URL or a loader. */
export async function loadSeed(source: SeedFile | string | URL | (() => Promise<SeedFile>)): Promise<SeedFile> {
  if (typeof source === 'function') return parseSeed(await source());
  if (typeof source === 'string' || source instanceof URL) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`could not load seed file ${String(source)}: HTTP ${res.status}`);
    return parseSeed(await res.json());
  }
  return parseSeed(source);
}
