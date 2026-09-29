import type { CloudOutput, CloudRequest, CloudRunner, TaskSchema } from './types.js';

export type CloudFn<S extends TaskSchema = TaskSchema> = (
  request: CloudRequest<S>,
  options: { signal?: AbortSignal },
) => Promise<unknown>;

/**
 * Wraps a plain async function as a cloud runner. The function returns the raw output:
 * the bare value, the `{ value }` wrapper, or a JSON string of either. The task validates it.
 *
 * ```ts
 * cloudAdapter(async ({ instruction, input, jsonSchema }, { signal }) => {
 *   const res = await fetch('/api/classify', { method: 'POST', body: JSON.stringify({ instruction, input, jsonSchema }), signal });
 *   return res.json();
 * });
 * ```
 */
export function cloudAdapter<S extends TaskSchema = TaskSchema>(
  fn: CloudFn<S>,
  options: { id?: string } = {},
): CloudRunner<S> {
  return {
    id: options.id ?? 'cloud',
    async run(request, opts): Promise<CloudOutput> {
      return { value: await fn(request, opts) };
    },
  };
}

export interface FetchAdapterOptions<S extends TaskSchema = TaskSchema> {
  /** Your backend endpoint. Never put provider API keys in the browser. */
  url: string | URL;
  headers?: Record<string, string>;
  /** Builds the request body. Defaults to the JSON-serialized request (functions dropped). */
  body?: (request: CloudRequest<S>) => unknown;
  /** Extracts the output from the parsed JSON response. Defaults to the whole response. */
  select?: (json: unknown) => unknown;
  id?: string;
  fetch?: typeof fetch;
}

/** A cloud runner that POSTs the request as JSON to your endpoint. */
export function fetchAdapter<S extends TaskSchema = TaskSchema>(options: FetchAdapterOptions<S>): CloudRunner<S> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  return cloudAdapter<S>(
    async (request, { signal }) => {
      const body = options.body ? options.body(request) : request;
      const res = await doFetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`Cloud endpoint responded with HTTP ${res.status}`);
      const json: unknown = await res.json();
      return options.select ? options.select(json) : json;
    },
    { id: options.id ?? 'fetch' },
  );
}
