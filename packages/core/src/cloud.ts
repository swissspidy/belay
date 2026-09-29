import type { CloudOutput, CloudRequest, CloudRunner, CloudUsage, TaskSchema } from './types.js';

export type CloudFn<S extends TaskSchema = TaskSchema> = (
  request: CloudRequest<S>,
  options: {
    signal?: AbortSignal;
    /** Report the call's token usage, so calibration and `savingsMeter()` can measure its cost. */
    reportUsage: (usage: CloudUsage | CloudUsage[]) => void;
  },
) => Promise<unknown>;

/**
 * Wraps a plain async function as a cloud runner. The function returns the raw output:
 * the bare value, the `{ value }` wrapper, or a JSON string of either. The task validates it.
 * Token usage goes through `reportUsage`, since the output itself may be a `{ value }` object.
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
      let usage: CloudUsage | CloudUsage[] | undefined;
      const value = await fn(request, { ...opts, reportUsage: (u) => void (usage = u) });
      return usage ? { value, usage } : { value };
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
  /** Extracts token usage from the parsed JSON response, if your backend passes it through. */
  usage?: (json: unknown) => CloudUsage | CloudUsage[] | undefined;
  id?: string;
  fetch?: typeof fetch;
}

/** A cloud runner that POSTs the request as JSON to your endpoint. */
export function fetchAdapter<S extends TaskSchema = TaskSchema>(options: FetchAdapterOptions<S>): CloudRunner<S> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  return cloudAdapter<S>(
    async (request, { signal, reportUsage }) => {
      const body = options.body ? options.body(request) : request;
      const res = await doFetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`Cloud endpoint responded with HTTP ${res.status}`);
      const json: unknown = await res.json();
      const usage = options.usage?.(json);
      if (usage) reportUsage(usage);
      return options.select ? options.select(json) : json;
    },
    { id: options.id ?? 'fetch' },
  );
}
