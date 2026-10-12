/**
 * The embedding model the learned-classifier examples use, with an on-disk cache.
 *
 * `cachedEmbedder(task)` has the same id as `transformersEmbedder({ model: MODEL })`, so seed
 * files it builds work in a page that uses that embedder. It reads embeddings from
 * `<task>/.belay-cache/<task>.embeddings.<model>.jsonl` (int8, as a learned classifier stores
 * them) and embeds what is missing with transformers.js, which then has to be installed:
 * `npm install --no-save @huggingface/transformers`.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { decodeInt8, encodeInt8, transformersEmbedder } from '@swissspidy/belay-learn';

export const MODEL = 'Xenova/bge-small-en-v1.5';

const root = new URL('../', import.meta.url);
const key = (text) => createHash('sha256').update(text).digest('hex').slice(0, 32);

export const readJsonl = async (url) => (await readFile(url, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));

/** @returns {Promise<import('@swissspidy/belay-learn').Embedder>} */
export async function cachedEmbedder(task) {
  const real = transformersEmbedder({ model: MODEL });
  const path = new URL(`${task}/.belay-cache/${task}.embeddings.${MODEL.replace('/', '_')}.jsonl`, root);
  const cache = new Map();
  try {
    for (const { key: k, e } of await readJsonl(path)) cache.set(k, decodeInt8(e));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  let loaded = false;
  return {
    id: real.id,
    availability: async () => 'available',
    async embed(texts) {
      const missing = [...new Set(texts.filter((t) => !cache.has(key(t))))];
      if (missing.length) {
        if (!loaded) {
          console.error(`${task}: embedding ${missing.length} inputs with ${MODEL}…`);
          await real.prepare();
          loaded = true;
        }
        const vectors = await real.embed(missing);
        await mkdir(new URL('.', path), { recursive: true });
        await appendFile(path, missing.map((t, i) => JSON.stringify({ key: key(t), e: encodeInt8(vectors[i]) })).join('\n') + '\n');
        // Read back quantized, as a re-run will.
        missing.forEach((t, i) => cache.set(key(t), decodeInt8(encodeInt8(vectors[i]))));
      }
      return texts.map((t) => cache.get(key(t)));
    },
  };
}
