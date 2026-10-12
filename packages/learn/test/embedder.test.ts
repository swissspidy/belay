import { describe, expect, it, vi } from 'vitest';
import { transformersEmbedder, type FeatureExtractor, type TransformersModule } from '../src/index.js';

function fakeTransformers({ cached = false } = {}) {
  const extractor = vi.fn(async (texts: string[]) => ({
    data: Float32Array.from(texts.flatMap((t) => [t.length, 1, 0])),
    dims: [texts.length, 3],
  })) as unknown as FeatureExtractor & ReturnType<typeof vi.fn>;
  const pipeline = vi.fn(async (_task: string, _model: string, options: Record<string, unknown> = {}) => {
    if (options.local_files_only && !cached) throw new Error('not cached');
    const progress = options.progress_callback as ((e: unknown) => void) | undefined;
    progress?.({ status: 'progress', file: 'model.onnx', loaded: 50, total: 100 });
    progress?.({ status: 'progress', file: 'tokenizer.json', loaded: 10, total: 10 });
    progress?.({ status: 'done', file: 'model.onnx' });
    cached = true;
    return extractor;
  });
  return { module: { pipeline } as unknown as TransformersModule, pipeline, extractor };
}

describe('transformersEmbedder', () => {
  it('is downloadable until prepare(), which reports progress across files', async () => {
    const t = fakeTransformers();
    const embedder = transformersEmbedder({ transformers: t.module });
    expect(await embedder.availability()).toBe('downloadable');
    expect(t.pipeline).toHaveBeenCalledWith('feature-extraction', 'Xenova/bge-small-en-v1.5', expect.objectContaining({ dtype: 'q8', local_files_only: true }));
    const progress: number[] = [];
    await embedder.prepare!({ onProgress: (p) => progress.push(p) });
    expect(progress).toEqual([0.5, 60 / 110, 1]);
    expect(await embedder.availability()).toBe('available');
  });

  it('is available without prepare() when the model loads from the cache', async () => {
    const t = fakeTransformers({ cached: true });
    const embedder = transformersEmbedder({ transformers: async () => t.module });
    expect(await embedder.availability()).toBe('available');
    expect(await embedder.embed(['ab'])).toHaveLength(1);
    expect(t.pipeline).toHaveBeenCalledTimes(1);
  });

  it('embeds in batches, with the prefix, as unit vectors', async () => {
    const t = fakeTransformers({ cached: true });
    const embedder = transformersEmbedder({ transformers: t.module, batchSize: 2, prefix: 'query: ', model: 'Xenova/e5', pooling: 'cls', device: 'wasm' });
    await embedder.prepare!();
    const out = await embedder.embed(['a', 'bb', 'ccc']);
    expect(out).toHaveLength(3);
    expect(t.extractor).toHaveBeenCalledTimes(2);
    expect(t.extractor.mock.calls[0]![0]).toEqual(['query: a', 'query: bb']);
    expect(t.extractor.mock.calls[0]![1]).toEqual({ pooling: 'cls', normalize: true });
    expect(t.pipeline.mock.calls[0]![2]).toMatchObject({ device: 'wasm' });
    for (const v of out) expect(Math.hypot(...v)).toBeCloseTo(1, 5);
    expect(embedder.id).toMatch(/^transformers\.js:Xenova\/e5:q8:cls:[0-9a-f]{8}$/);
  });

  it('in a browser, checks the Cache API before loading, and never loads an uncached model', async () => {
    const stored = new Set<string>();
    const cacheStorage = {
      open: vi.fn(async (_name: string) => ({ match: async (url: string) => (stored.has(url) ? new Response('') : undefined) })),
    };
    vi.stubGlobal('caches', cacheStorage);
    try {
      const t = fakeTransformers({ cached: true });
      const embedder = transformersEmbedder({ transformers: { ...t.module, pipeline: t.pipeline, env: { remoteHost: 'https://hf.test/' } } });
      expect(await embedder.availability()).toBe('downloadable');
      expect(t.pipeline).not.toHaveBeenCalled();
      expect(cacheStorage.open).toHaveBeenCalledWith('transformers-cache');

      const base = 'https://hf.test/Xenova/bge-small-en-v1.5/resolve/main/';
      for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']) stored.add(base + f);
      const again = transformersEmbedder({ transformers: { ...t.module, pipeline: t.pipeline, env: { remoteHost: 'https://hf.test/' } } });
      expect(await again.availability()).toBe('available');
      expect(t.pipeline.mock.calls[0]![2]).not.toHaveProperty('local_files_only');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses to embed before the model is loaded, and is unavailable without the library', async () => {
    const embedder = transformersEmbedder({ transformers: fakeTransformers().module });
    await expect(embedder.embed(['x'])).rejects.toThrow(/not loaded/);
    const missing = transformersEmbedder({ transformers: async () => Promise.reject(new Error('no module')) });
    expect(await missing.availability()).toBe('unavailable');
  });
});
