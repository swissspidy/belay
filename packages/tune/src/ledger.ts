/**
 * The ledger: an append-only JSONL file of every experiment. See ADR 0007 §4.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CloudUsage } from '@swissspidy/belay-core';
import type { ConfigPatchOp } from './local-config.js';

export const LEDGER_VERSION = 1;

export type LedgerRung = 'baseline' | 'threshold' | 'examples' | 'rules' | 'gate';
export type LedgerStage = 'baseline' | 'screen' | 'validation' | 'gate';
/**
 * - `baseline`: the starting point of the run;
 * - `kept`: better than its parent on validation, and in the population;
 * - `discarded`: not better, or screened out, or too large;
 * - `promoted`: passed the gate;
 * - `rejected`: failed the gate;
 * - `error`: could not be evaluated.
 */
export type LedgerVerdict = 'baseline' | 'kept' | 'discarded' | 'promoted' | 'rejected' | 'error';

export interface LedgerScores {
  localShare: number;
  accuracy: number;
  threshold: number | null;
  targetMet?: boolean;
  goldAccuracy?: number | null;
  cloudAgreement?: number | null;
  contextChars?: number;
  examples: number;
}

export interface LedgerEntry {
  version: typeof LEDGER_VERSION;
  /** `<run>.<seq>`, e.g. `2026-11-10.014`. */
  id: string;
  run: string;
  seq: number;
  timestamp: string;
  task: string;
  backend: string;
  rung: LedgerRung;
  /** One sentence: what the change is expected to do, and why. */
  hypothesis: string;
  /** Fingerprints of the config the candidate started from, and of the candidate. */
  parent: string | null;
  candidate: string;
  patch: ConfigPatchOp[];
  /** The last stage the candidate reached. */
  stage: LedgerStage;
  /** Scores on validation (on the screening sample for a candidate that stopped there). Never holdout numbers. */
  scores?: LedgerScores;
  /** For a `gate` entry: whether it passed, and the names of the checks that failed. No holdout numbers. */
  gate?: { passed: boolean; failed: string[]; basis: 'gold' | 'cloud-agreement' };
  /** What the proposal cost: the reflecting model's call, shared between the candidates of one round. */
  cost?: { currency: string; reflector: number; usage?: CloudUsage[] };
  verdict: LedgerVerdict;
  reason: string;
  environment?: { runner: string; model?: string; userAgent?: string };
  /** Hash of the lock file: what the evaluator, the gate config and the holdout were. */
  protected: string;
  seed: string;
  /** Hash of the line before this one; `null` for the first. Makes an edited history detectable. */
  previous: string | null;
}

const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;

export interface Ledger {
  entries: LedgerEntry[];
  /** `false` when a line's `previous` does not match the line before it, or a line is not JSON. */
  intact: boolean;
  /** Hash of the last line, for the next entry. */
  head: string | null;
}

export async function readLedger(path: string): Promise<Ledger> {
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const entries: LedgerEntry[] = [];
  let head: string | null = null;
  let intact = true;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as LedgerEntry;
      if (entry.previous !== head) intact = false;
      entries.push(entry);
    } catch {
      intact = false;
    }
    head = sha256(line);
  }
  return { entries, intact, head };
}

/** Appends an entry, chained to the current last line, and returns it as written. */
export async function appendLedger(path: string, ledger: Ledger, entry: Omit<LedgerEntry, 'previous' | 'version'>): Promise<LedgerEntry> {
  const full: LedgerEntry = { version: LEDGER_VERSION, ...entry, previous: ledger.head };
  const line = JSON.stringify(full);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line + '\n');
  ledger.entries.push(full);
  ledger.head = sha256(line);
  return full;
}
