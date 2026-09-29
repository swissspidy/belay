import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalJson } from '@belay/core';

/**
 * Append-only JSONL cache of model outputs. Re-running a calibration replays cached outputs,
 * so results are reproducible even though cloud models are not deterministic.
 */
export class OutputCache {
  private entries = new Map<string, unknown>();
  private constructor(private readonly path: string | null) {}

  static async open(path: string | null): Promise<OutputCache> {
    const cache = new OutputCache(path);
    if (path) {
      let text = '';
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const { key, output } = JSON.parse(line) as { key: string; output: unknown };
          cache.entries.set(key, output);
        } catch {
          // ignore a torn last line from an interrupted run
        }
      }
    }
    return cache;
  }

  static key(parts: unknown): string {
    return createHash('sha256').update(canonicalJson(parts)).digest('hex').slice(0, 32);
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get<T>(key: string): T | undefined {
    return this.entries.get(key) as T | undefined;
  }

  async set(key: string, output: unknown): Promise<void> {
    this.entries.set(key, output);
    if (this.path) {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, JSON.stringify({ key, output }) + '\n');
    }
  }
}
