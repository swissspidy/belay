/**
 * What the loop cannot change: the gate config, the instructions, the evaluator and the holdout.
 * A lock file records their hashes, and every write of the loop goes through an allowlist.
 * See ADR 0007 §5.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '@swissspidy/belay-core';
import type { DatasetManifest } from '@swissspidy/belay-trace/node';
import { DEFAULT_GATE, parseGateConfig, type GateConfig } from './gate.js';

export const LOCK_VERSION = 1;
export const LOCK_FILE = 'belay.tune.lock.json';
export const GATE_FILE = 'belay.gate.json';
export const INSTRUCTIONS_FILE = 'belay.tune.md';

const sha256 = (data: string | Buffer): string => `sha256:${createHash('sha256').update(data).digest('hex')}`;

/** What one task's tuning is protected by. */
export interface TaskLock {
  /** Hash of the gate config in effect (`belay.gate.json`, or the defaults). */
  gate: string;
  /** Hash of `belay.tune.md`; `null` when there is none. */
  instructions: string | null;
  /** Hash of the built code of the packages that evaluate. */
  evaluator: string;
  /** The holdout's ids when the lock was written. The holdout may grow; these must stay in it. */
  holdout: { fingerprint: string; ids: string[] };
}

export interface LockFile {
  version: typeof LOCK_VERSION;
  tasks: Record<string, TaskLock>;
}

export const lockHash = (lock: TaskLock): string => sha256(canonicalJson(lock));

async function hashDirectory(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.js')) out.push(`${relative(root, path).split(sep).join('/')} ${sha256(await readFile(path))}`);
    }
  };
  await walk(root);
  return out;
}

const EVALUATOR_PACKAGES = ['@swissspidy/belay-core', '@swissspidy/belay-web', '@swissspidy/belay-trace', '@swissspidy/belay-calibrate', '@swissspidy/belay-tune'];

/** Hash of the built JavaScript of every package that takes part in an evaluation. */
export async function evaluatorHash(roots?: readonly string[]): Promise<string> {
  const dirs =
    roots ??
    EVALUATOR_PACKAGES.map((name) =>
      // The entry point is `<package>/dist/index.js`: hash everything next to it.
      dirname(name === '@swissspidy/belay-tune' ? fileURLToPath(import.meta.url) : fileURLToPath(import.meta.resolve(name))),
    );
  const lines: string[] = [];
  for (const [i, dir] of dirs.entries()) for (const line of await hashDirectory(dir)) lines.push(`${i}:${line}`);
  return sha256(lines.join('\n'));
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** The gate config of a project: `belay.gate.json`, or the defaults. */
export async function loadGateConfig(root: string): Promise<GateConfig> {
  const text = await readOptional(join(root, GATE_FILE));
  return text === undefined ? DEFAULT_GATE : parseGateConfig(JSON.parse(text));
}

export interface ProtectedState {
  gate: GateConfig;
  instructions: string | undefined;
  lock: TaskLock;
}

/** Reads what is protected, as it is on disk now. */
export async function currentState(root: string, manifest: DatasetManifest, options: { evaluatorRoots?: readonly string[] } = {}): Promise<ProtectedState> {
  const gate = await loadGateConfig(root);
  const instructions = await readOptional(join(root, INSTRUCTIONS_FILE));
  const ids = Object.keys(manifest.assignments).filter((id) => manifest.assignments[id] === 'holdout').sort();
  return {
    gate,
    instructions,
    lock: {
      gate: sha256(canonicalJson(gate)),
      instructions: instructions === undefined ? null : sha256(instructions),
      evaluator: await evaluatorHash(options.evaluatorRoots),
      holdout: { fingerprint: manifest.holdoutFingerprint, ids },
    },
  };
}

export async function readLock(root: string): Promise<LockFile | undefined> {
  const text = await readOptional(join(root, LOCK_FILE));
  if (text === undefined) return undefined;
  const lock = JSON.parse(text) as LockFile;
  if (lock.version !== LOCK_VERSION) throw new Error(`unsupported ${LOCK_FILE} version ${String(lock.version)}`);
  return lock;
}

/** Writes the current state of a task into the lock file. A person runs this, and commits the file. */
export async function writeLock(root: string, task: string, lock: TaskLock): Promise<void> {
  const file = (await readLock(root)) ?? { version: LOCK_VERSION, tasks: {} };
  file.tasks[task] = lock;
  await writeFile(join(root, LOCK_FILE), JSON.stringify(file, null, 2) + '\n');
}

/**
 * Compares the lock with the current state. Returns what differs, in words; empty when nothing
 * does. The holdout may have grown: only ids that left it are a difference.
 */
export function verifyLock(locked: TaskLock, current: TaskLock): string[] {
  const problems: string[] = [];
  if (locked.gate !== current.gate) problems.push(`the gate config changed (${GATE_FILE})`);
  if (locked.instructions !== current.instructions) problems.push(`the instructions changed (${INSTRUCTIONS_FILE})`);
  if (locked.evaluator !== current.evaluator) problems.push('the evaluator code changed (the installed @swissspidy/belay-* packages)');
  const now = new Set(current.holdout.ids);
  const gone = locked.holdout.ids.filter((id) => !now.has(id));
  if (gone.length) problems.push(`${gone.length} inputs of the locked holdout are no longer in it`);
  return problems;
}

/** Every write of the loop goes through this: paths outside the allowlist are refused. */
export interface Workspace {
  write(path: string, content: string): Promise<void>;
  append(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  allows(path: string): boolean;
}

export function createWorkspace(root: string, allowed: readonly string[]): Workspace {
  const base = resolve(root);
  const allow = allowed.map((p) => resolve(base, p));
  const check = (path: string): string => {
    const full = resolve(base, path);
    const ok = allow.some((a) => full === a || full.startsWith(a + sep));
    if (!ok) throw new Error(`belay tune may not write ${relative(base, full) || full}: it is not one of its outputs`);
    return full;
  };
  return {
    allows(path) {
      try {
        check(path);
        return true;
      } catch {
        return false;
      }
    },
    async write(path, content) {
      const full = check(path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    },
    async append(path, content) {
      const full = check(path);
      await mkdir(dirname(full), { recursive: true });
      await appendFile(full, content);
    },
    async remove(path) {
      await rm(check(path), { force: true });
    },
  };
}
