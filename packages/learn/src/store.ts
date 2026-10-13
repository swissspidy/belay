import type { CalibrationPair } from './calibrator.js';

/**
 * A learned example as stored on the device: the embedding of the input, never its text. Note
 * that text embeddings can be partly inverted, so treat them as sensitive data too.
 */
export interface StoredExample {
  /** Hash of the input text: a later label for the same input replaces this one. */
  id: string;
  label: string;
  embedding: Float32Array;
  /** `cloud`: a cloud answer. `feedback`: a correction passed to `task.feedback()`. */
  source: 'cloud' | 'feedback';
  /** Epoch milliseconds. */
  createdAt: number;
}

/** Everything a learned classifier keeps besides its examples. */
export interface StoredMeta {
  version: 1;
  /** Prequential calibration pairs per head (see `CalibrationPair`), oldest first. */
  pairs: { knn: CalibrationPair[]; softmax: CalibrationPair[] };
  /** The last fitted softmax head, so a reload does not retrain it. */
  softmax?: { labels: number; dimensions: number; weights: Float64Array; bias: Float64Array; examples: number };
}

/**
 * Where a learned classifier keeps its examples. Every method takes a `scope` (task, schema and
 * embedder), so one store can hold several tasks.
 */
export interface ExampleStore {
  load(scope: string): Promise<{ examples: StoredExample[]; meta: StoredMeta | null }>;
  /** Inserts or replaces examples by `id`. */
  put(scope: string, examples: readonly StoredExample[]): Promise<void>;
  delete(scope: string, ids: readonly string[]): Promise<void>;
  putMeta(scope: string, meta: StoredMeta): Promise<void>;
  clear(scope: string): Promise<void>;
}

/** Keeps examples in memory: they are gone on reload. The default store. */
export function memoryStore(): ExampleStore {
  const scopes = new Map<string, { examples: Map<string, StoredExample>; meta: StoredMeta | null }>();
  const of = (scope: string) => {
    let s = scopes.get(scope);
    if (!s) scopes.set(scope, (s = { examples: new Map(), meta: null }));
    return s;
  };
  return {
    async load(scope) {
      const s = of(scope);
      return { examples: [...s.examples.values()], meta: s.meta };
    },
    async put(scope, examples) {
      const s = of(scope);
      for (const e of examples) s.examples.set(e.id, e);
    },
    async delete(scope, ids) {
      const s = of(scope);
      for (const id of ids) s.examples.delete(id);
    },
    async putMeta(scope, meta) {
      of(scope).meta = meta;
    },
    async clear(scope) {
      scopes.delete(scope);
    },
  };
}

export interface IndexedDbStoreOptions {
  /** Database name. Defaults to "belay-learn". */
  name?: string;
  /** Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
}

const EXAMPLES = 'examples';
const META = 'meta';

const done = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const complete = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });

/**
 * Keeps examples in IndexedDB, so a classifier keeps what it learned across reloads. Each origin
 * has its own database; the user can clear it with the site's data.
 */
export function indexedDbStore(options: IndexedDbStoreOptions = {}): ExampleStore {
  let db: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    db ??= (async () => {
      const factory = options.indexedDB ?? globalThis.indexedDB;
      if (!factory) throw new Error('IndexedDB is not available');
      const request = factory.open(options.name ?? 'belay-learn', 1);
      request.onupgradeneeded = () => {
        const examples = request.result.createObjectStore(EXAMPLES, { keyPath: ['scope', 'id'] });
        examples.createIndex('scope', 'scope');
        request.result.createObjectStore(META, { keyPath: 'scope' });
      };
      return done(request);
    })();
    db.catch(() => (db = undefined));
    return db;
  };

  return {
    async load(scope) {
      const tx = (await open()).transaction([EXAMPLES, META], 'readonly');
      const [rows, meta] = await Promise.all([
        done(tx.objectStore(EXAMPLES).index('scope').getAll(IDBKeyRange.only(scope))) as Promise<(StoredExample & { scope: string })[]>,
        done(tx.objectStore(META).get(scope)) as Promise<{ scope: string; meta: StoredMeta } | undefined>,
      ]);
      return { examples: rows.map(({ scope: _, ...e }) => e), meta: meta?.meta ?? null };
    },
    async put(scope, examples) {
      const tx = (await open()).transaction(EXAMPLES, 'readwrite');
      const store = tx.objectStore(EXAMPLES);
      for (const e of examples) store.put({ ...e, scope });
      await complete(tx);
    },
    async delete(scope, ids) {
      const tx = (await open()).transaction(EXAMPLES, 'readwrite');
      const store = tx.objectStore(EXAMPLES);
      for (const id of ids) store.delete([scope, id]);
      await complete(tx);
    },
    async putMeta(scope, meta) {
      const tx = (await open()).transaction(META, 'readwrite');
      tx.objectStore(META).put({ scope, meta });
      await complete(tx);
    },
    async clear(scope) {
      const tx = (await open()).transaction([EXAMPLES, META], 'readwrite');
      tx.objectStore(EXAMPLES).delete(IDBKeyRange.bound([scope], [scope, []]));
      tx.objectStore(META).delete(scope);
      await complete(tx);
    },
  };
}

/**
 * Asks the browser to keep this origin's storage (IndexedDB included) instead of evicting it
 * under storage pressure ("best-effort" by default). Browsers decide on their own: Chrome grants
 * it to sites the user engages with or installed, Firefox may ask the user, and Safari may also
 * clear script-written storage of sites the user hasn't visited for a while. Resolves with the
 * outcome and the current usage and quota; `persisted` is false where the API is missing.
 */
export async function persistStorage(): Promise<{ persisted: boolean; usage?: number; quota?: number }> {
  const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage;
  if (!storage?.persist) return { persisted: false };
  // A refused or failing request leaves storage best-effort; it is never an error for the app.
  const persisted = (await storage.persisted?.().catch(() => false)) || (await storage.persist().catch(() => false));
  const estimate = await storage.estimate?.().catch(() => undefined);
  return {
    persisted,
    ...(estimate?.usage !== undefined ? { usage: estimate.usage } : {}),
    ...(estimate?.quota !== undefined ? { quota: estimate.quota } : {}),
  };
}
