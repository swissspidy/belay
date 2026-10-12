import { fnv1a } from '@swissspidy/belay-core';
import type { Availability, PrepareOptions } from '@swissspidy/belay-core';
import { normalize } from './vector.js';

/** Turns texts into unit vectors. A learned classifier keeps one embedding per example. */
export interface Embedder {
  /**
   * Identifies the model and its settings. Stored examples and seed files are tied to it: vectors
   * from another model are not comparable.
   */
  readonly id: string;
  /** Like `LocalRunner.availability()`: must never download a model. */
  availability(): Promise<Availability>;
  /** Downloads or loads the model. */
  prepare?(options?: PrepareOptions): Promise<void>;
  /** One unit vector per text, all of the same length. */
  embed(texts: readonly string[], options?: { signal?: AbortSignal }): Promise<Float32Array[]>;
  destroy?(): void;
}

/** The subset of `@huggingface/transformers` the embedder uses. */
export interface TransformersModule {
  pipeline(task: 'feature-extraction', model: string, options?: Record<string, unknown>): Promise<FeatureExtractor>;
  env?: { remoteHost?: string; remotePathTemplate?: string; cacheKey?: string; useBrowserCache?: boolean };
}

export interface FeatureExtractor {
  (texts: string[], options: { pooling: 'mean' | 'cls' | 'none'; normalize: boolean }): Promise<{ data: ArrayLike<number>; dims: number[] }>;
  dispose?(): Promise<void> | void;
}

export interface TransformersEmbedderOptions {
  /** A Hugging Face model with ONNX weights. Defaults to "Xenova/bge-small-en-v1.5" (384-d, ~34 MB at q8). */
  model?: string;
  /** Weight precision. Defaults to "q8". */
  dtype?: string;
  /** "webgpu", "wasm", … Defaults to the library's choice. */
  device?: string;
  /** Defaults to "mean". */
  pooling?: 'mean' | 'cls';
  /** Text prepended to every input, for models that expect one (e5: "query: "). */
  prefix?: string;
  /** Texts per model call. Defaults to 16. */
  batchSize?: number;
  /** The library, or a loader for it. Defaults to `import('@huggingface/transformers')`. */
  transformers?: TransformersModule | (() => Promise<TransformersModule>);
}

const DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5';

/** File name suffix of each dtype's ONNX weights, as transformers.js names them. */
const DTYPE_SUFFIX: Record<string, string> = {
  fp32: '',
  fp16: '_fp16',
  q8: '_quantized',
  int8: '_int8',
  uint8: '_uint8',
  q4: '_q4',
  q4f16: '_q4f16',
  bnb4: '_bnb4',
};

/**
 * Whether the model's files are in the browser's Cache API, where transformers.js keeps them.
 * `undefined` outside a browser (or for a dtype it can't name), where the caller asks the library.
 */
async function inBrowserCache(t: TransformersModule, model: string, dtype: string): Promise<boolean | undefined> {
  const cacheStorage = (globalThis as { caches?: CacheStorage }).caches;
  const suffix = DTYPE_SUFFIX[dtype];
  if (!cacheStorage || suffix === undefined || t.env?.useBrowserCache === false) return undefined;
  const host = t.env?.remoteHost ?? 'https://huggingface.co/';
  const path = (t.env?.remotePathTemplate ?? '{model}/resolve/{revision}/').replace('{model}', model).replace('{revision}', 'main');
  const cache = await cacheStorage.open(t.env?.cacheKey ?? 'transformers-cache');
  for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', `onnx/model${suffix}.onnx`]) {
    if (!(await cache.match(new URL(path + file, host).href))) return false;
  }
  return true;
}

/**
 * An embedder backed by transformers.js, which runs the model in the page (WebGPU or WASM) or in
 * Node. The model is downloaded once by `prepare()` and then read from the browser cache:
 * `availability()` reports "available" when the model loads from the cache alone, so a page can
 * start without a user gesture after the first visit. In a browser it looks for the model's files
 * in the Cache API (config, tokenizer and the dtype's weights) before loading it; in Node it
 * loads with `local_files_only`.
 */
export function transformersEmbedder(options: TransformersEmbedderOptions = {}): Embedder {
  const model = options.model ?? DEFAULT_MODEL;
  const dtype = options.dtype ?? 'q8';
  const pooling = options.pooling ?? 'mean';
  const prefix = options.prefix ?? '';
  const batchSize = Math.max(1, options.batchSize ?? 16);
  const id = `transformers.js:${model}:${dtype}:${pooling}${prefix ? `:${fnv1a(prefix)}` : ''}`;

  let library: Promise<TransformersModule> | undefined;
  const lib = (): Promise<TransformersModule> => {
    library ??= (async () => {
      const t = options.transformers;
      if (typeof t === 'function') return t();
      if (t) return t;
      const specifier = '@huggingface/transformers';
      return (await import(/* @vite-ignore */ specifier)) as TransformersModule;
    })();
    library.catch(() => (library = undefined));
    return library;
  };

  let extractor: Promise<FeatureExtractor> | undefined;
  let loaded = false;
  let cacheProbe: Promise<boolean> | undefined;

  const load = (extra: Record<string, unknown>): Promise<FeatureExtractor> => {
    const p = (async () => {
      const t = await lib();
      const fe = await t.pipeline('feature-extraction', model, { dtype, ...(options.device ? { device: options.device } : {}), ...extra });
      loaded = true;
      return fe;
    })();
    return p;
  };

  return {
    id,
    async availability() {
      if (loaded) return 'available';
      let t: TransformersModule;
      try {
        t = await lib();
      } catch {
        return 'unavailable';
      }
      // Loads the model only if every file is already cached: never downloads.
      cacheProbe ??= (async () => {
        try {
          const cached = await inBrowserCache(t, model, dtype);
          if (cached === false) return false;
          const fe = load(cached ? {} : { local_files_only: true });
          await fe;
          extractor ??= fe;
          return true;
        } catch {
          return false;
        }
      })();
      return (await cacheProbe) ? 'available' : 'downloadable';
    },

    async prepare(prepareOptions) {
      if (loaded && extractor) return;
      const files = new Map<string, { loaded: number; total: number }>();
      const onProgress = prepareOptions?.onProgress;
      const fe = load({
        ...(onProgress
          ? {
              progress_callback: (e: { status?: string; file?: string; loaded?: number; total?: number }) => {
                if (e.status !== 'progress' || !e.file || !e.total) return;
                files.set(e.file, { loaded: e.loaded ?? 0, total: e.total });
                let sum = 0;
                let total = 0;
                for (const f of files.values()) {
                  sum += f.loaded;
                  total += f.total;
                }
                onProgress(total ? sum / total : 0);
              },
            }
          : {}),
      });
      extractor = fe;
      fe.catch(() => {
        if (extractor === fe) extractor = undefined;
      });
      await fe;
      cacheProbe = Promise.resolve(true);
      onProgress?.(1);
    },

    async embed(texts, embedOptions) {
      if (!extractor || !loaded) throw new Error(`embedding model ${model} is not loaded; call prepare()`);
      const fe = await extractor;
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        embedOptions?.signal?.throwIfAborted();
        const batch = texts.slice(i, i + batchSize).map((t) => prefix + t);
        const result = await fe(batch, { pooling, normalize: true });
        const dimensions = result.dims.at(-1)!;
        for (let j = 0; j < batch.length; j++) {
          const v = new Float32Array(dimensions);
          for (let d = 0; d < dimensions; d++) v[d] = result.data[j * dimensions + d]!;
          out.push(normalize(v));
        }
      }
      return out;
    },

    destroy() {
      const fe = extractor;
      extractor = undefined;
      loaded = false;
      cacheProbe = undefined;
      fe?.then((f) => f.dispose?.(), () => {});
    },
  };
}
