import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseTrace } from '../parse.js';
import type { Trace, TraceSink } from '../types.js';

/**
 * The reference sink: appends one JSON line per trace to a file. Use it behind the endpoint your
 * app posts traces to, or directly in Node. Writes are serialized, so lines never interleave.
 */
export function jsonlSink(path: string): TraceSink & { flush(): Promise<void> } {
  let ready: Promise<unknown> | undefined;
  let tail: Promise<void> = Promise.resolve();
  return {
    write(trace: Trace): Promise<void> {
      const line = JSON.stringify(trace) + '\n';
      const job = tail.then(async () => {
        await (ready ??= mkdir(dirname(path), { recursive: true }));
        await appendFile(path, line);
      });
      // One failed write must not block the ones after it; the caller still sees the failure.
      tail = job.catch(() => {});
      return job;
    },
    flush: () => tail,
  };
}

export interface ReadTracesResult {
  traces: Trace[];
  /** Lines that are not valid traces, e.g. a line cut short by a crash. They are skipped. */
  invalid: { file: string; line: number; error: string }[];
}

/**
 * Reads traces from a JSONL file, or from every `.jsonl` file in a directory (in name order).
 * A trace id that occurs twice (a retried write) is read once.
 */
export async function readTraces(path: string): Promise<ReadTracesResult> {
  const files = (await stat(path)).isDirectory()
    ? (await readdir(path))
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
        .map((name) => join(path, name))
    : [path];
  const traces: Trace[] = [];
  const invalid: ReadTracesResult['invalid'] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        const trace = parseTrace(JSON.parse(line));
        if (seen.has(trace.id)) continue;
        seen.add(trace.id);
        traces.push(trace);
      } catch (err) {
        invalid.push({ file, line: i + 1, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { traces, invalid };
}
