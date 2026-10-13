import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BelayConfig } from './config.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(path: string | undefined): Promise<{ config: BelayConfig; path: string }> {
  const candidates = path ? [path] : ['belay.config.mjs', 'belay.config.js', 'belay.config.ts'];
  for (const candidate of candidates) {
    const full = resolve(candidate);
    if (!(await exists(full))) continue;
    try {
      const mod = (await import(pathToFileURL(full).href)) as { default?: BelayConfig };
      if (!mod.default?.tasks) throw new Error('the config must `export default { tasks: { ... } }`');
      return { config: mod.default, path: full };
    } catch (err) {
      if (full.endsWith('.ts') && (err as NodeJS.ErrnoException).code === 'ERR_UNKNOWN_FILE_EXTENSION') {
        throw new Error(`${candidate}: this Node version cannot import TypeScript; use belay.config.mjs or Node >= 22.18`);
      }
      throw err;
    }
  }
  throw new Error(path ? `config file not found: ${path}` : 'no belay.config.{mjs,js,ts} in the current directory (or pass --config)');
}

