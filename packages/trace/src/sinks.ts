import type { Trace, TraceSink } from './types.js';

/** Keeps traces in memory: for tests, or to batch them yourself. */
export function memorySink(): TraceSink & { readonly traces: Trace[] } {
  const traces: Trace[] = [];
  return {
    traces,
    write(trace) {
      traces.push(trace);
    },
  };
}
