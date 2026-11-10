import { createHash } from 'node:crypto';
import { canonicalJson, parseValue, schemaFingerprint, type TaskSchema } from '@swissspidy/belay-core';
import type { LabelKind, LabelOrigin, Trace } from '../types.js';

export const DATASET_VERSION = 1;

export type Split = 'train' | 'validation' | 'holdout';
const SPLITS: readonly Split[] = ['train', 'validation', 'holdout'];

/**
 * One labeled input. A line of a split file; `belay calibrate --data` reads the same format
 * (`input`, `label`, `id`).
 */
export interface DatasetExample {
  /** Hash of the normalized input: the same text always has the same id. */
  id: string;
  input: string;
  label: unknown;
  labelKind: LabelKind;
  origin: LabelOrigin;
  /**
   * The cloud's answer for this input, when a run recorded one. Next to a gold label it says
   * whether the cloud was right; for a label of origin `cloud` it is the label.
   */
  cloud?: unknown;
  /**
   * How many runs this example stands for. 1 for an escalated run; `1 / rate` for a confident
   * run that exploration sent to the cloud, because only that share of confident runs is checked.
   */
  weight: number;
}

/** Which split every input was ever put in. Commit it: it is what keeps the holdout frozen. */
export interface DatasetManifest {
  version: typeof DATASET_VERSION;
  task: string;
  schemaFingerprint: string;
  seed: string;
  ratios: Record<Split, number>;
  nearDuplicateThreshold: number;
  /** Input id to split. An input never changes its split. */
  assignments: Record<string, Split>;
  /** Hash of the holdout's ids. The holdout only grows, so this changes only when it grew. */
  holdoutFingerprint: string;
}

export interface BuildDatasetsOptions {
  task: string;
  schema: TaskSchema;
  /** The same seed and the same traces give the same splits, in any trace order. */
  seed: string | number;
  /** The manifest of the previous build. Inputs it lists keep their split. */
  previous?: DatasetManifest;
  /** Shares of new inputs per split. Defaults to 60% train, 20% validation, 20% holdout. */
  ratios?: Partial<Record<Split, number>>;
  /**
   * Inputs whose word 3-grams overlap at least this much (Jaccard, in [0.5, 1]) are near-duplicates
   * and always share a split. Defaults to 0.8. 1 only groups inputs that are equal after
   * normalization (case, whitespace, Unicode form).
   */
  nearDuplicateThreshold?: number;
}

export interface SplitStats {
  size: number;
  gold: number;
  silver: number;
}

export interface DatasetStats {
  /** Traces of this task. */
  traces: number;
  /** Skipped: recorded for a different schema (other options or prompts). */
  staleSchema: number;
  /** Skipped: no label, or no input text (content withheld). */
  unlabeled: number;
  /** Skipped: the label does not match the schema. */
  invalidLabel: number;
  /** Distinct labeled inputs. */
  inputs: number;
  /** Inputs whose labels of the winning kind disagreed (the majority, then the latest, won). */
  conflicts: number;
  /** New inputs left out because their near-duplicates sit in more than one split. */
  droppedAmbiguous: number;
  /** Synthetic inputs left out because their near-duplicates are in the holdout. */
  droppedSynthetic: number;
  /** Inputs the manifest lists whose traces are gone (e.g. deleted after a retention period). */
  missing: number;
  splits: Record<Split, SplitStats>;
}

export interface Datasets {
  train: DatasetExample[];
  validation: DatasetExample[];
  holdout: DatasetExample[];
  manifest: DatasetManifest;
  stats: DatasetStats;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Case, whitespace and Unicode form do not make two inputs different. */
export function normalizeInput(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The id of an input: a hash of its normalized text. */
export function inputId(input: string): string {
  return sha256(normalizeInput(input)).slice(0, 24);
}

function shingles(normalized: string): Set<string> {
  const words = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length < 3) return new Set([words.join(' ')]);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const s of small) if (large.has(s)) shared++;
  return shared / (a.size + b.size - shared);
}

function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const BANDS = 16;
const ROWS = 2;

/**
 * Groups near-duplicates: MinHash bands propose pairs (two inputs at Jaccard 0.5 are proposed with
 * 99% probability, at 0.8 practically always), the exact Jaccard similarity decides.
 */
function cluster(ids: readonly string[], texts: ReadonlyMap<string, string>, threshold: number): Map<string, string> {
  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(id) !== root) {
      const next = parent.get(id)!;
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  // The smaller id becomes the root, so a cluster's key does not depend on the order of traces.
  const union = (a: string, b: string): void => {
    const [ra, rb] = [find(a), find(b)];
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  if (threshold < 1) {
    const sets = new Map<string, Set<string>>(ids.map((id) => [id, shingles(texts.get(id)!)]));
    const buckets = new Map<string, string[]>();
    for (const id of ids) {
      const hashes = [...sets.get(id)!].map(hash32);
      const signature: number[] = [];
      for (let i = 0; i < BANDS * ROWS; i++) {
        const salt = Math.imul(i + 1, 0x9e3779b1);
        let min = 0xffffffff;
        for (const h of hashes) {
          let x = h ^ salt;
          x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
          x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
          x = (x ^ (x >>> 16)) >>> 0;
          if (x < min) min = x;
        }
        signature.push(min);
      }
      for (let b = 0; b < BANDS; b++) {
        const key = `${b}:${signature.slice(b * ROWS, (b + 1) * ROWS).join(',')}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(id);
        else buckets.set(key, [id]);
      }
    }
    for (const bucket of buckets.values()) {
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const [a, b] = [bucket[i]!, bucket[j]!];
          if (find(a) !== find(b) && jaccard(sets.get(a)!, sets.get(b)!) >= threshold) union(a, b);
        }
      }
    }
  }
  return new Map(ids.map((id) => [id, find(id)]));
}

interface Vote {
  value: unknown;
  key: string;
  count: number;
  latest: number;
}

interface Resolved {
  id: string;
  input: string;
  label: unknown;
  labelKind: LabelKind;
  origin: LabelOrigin;
  weight: number;
  conflict: boolean;
  cloud?: unknown;
}

/**
 * Builds the training, validation and holdout splits from traces.
 *
 * - Only traces with an input and a label count. Gold labels win over silver ones; among labels
 *   of the same kind the majority wins, then the latest.
 * - An input is identified by the hash of its normalized text, so no input is in two splits.
 *   Near-duplicates share a split.
 * - A new input's split follows from the seed and its hash alone, never from the order of traces.
 * - With `previous`, every input keeps its split: the holdout is frozen and only grows.
 * - Synthetic examples never enter the holdout.
 */
export function buildDatasets(traces: Iterable<Trace>, options: BuildDatasetsOptions): Datasets {
  const { task, schema, previous } = options;
  const seed = String(options.seed);
  const fingerprint = schemaFingerprint(schema);
  const threshold = options.nearDuplicateThreshold ?? previous?.nearDuplicateThreshold ?? 0.8;
  if (!(threshold >= 0.5 && threshold <= 1)) throw new Error('nearDuplicateThreshold must be in [0.5, 1]');
  const ratios: Record<Split, number> = { train: 0.6, validation: 0.2, holdout: 0.2, ...(previous?.ratios ?? {}), ...options.ratios };
  const total = ratios.train + ratios.validation + ratios.holdout;
  if (!(total > 0) || SPLITS.some((s) => !(ratios[s] >= 0))) throw new Error('ratios must be non-negative and not all zero');
  for (const s of SPLITS) ratios[s] = ratios[s] / total;
  if (previous) {
    if (previous.version !== DATASET_VERSION) throw new Error(`unsupported dataset manifest version ${String(previous.version)}`);
    if (previous.task !== task) throw new Error(`the manifest is for task "${previous.task}", not "${task}"`);
    if (previous.schemaFingerprint !== fingerprint) {
      throw new Error(`the manifest was built for a different schema of "${task}": its labels no longer apply. Start a new manifest.`);
    }
    if (previous.seed !== seed) {
      throw new Error(`the manifest was built with seed "${previous.seed}", not "${seed}". The holdout is frozen: keep the seed, or start a new manifest.`);
    }
  }

  const stats: DatasetStats = {
    traces: 0,
    staleSchema: 0,
    unlabeled: 0,
    invalidLabel: 0,
    inputs: 0,
    conflicts: 0,
    droppedAmbiguous: 0,
    droppedSynthetic: 0,
    missing: 0,
    splits: { train: { size: 0, gold: 0, silver: 0 }, validation: { size: 0, gold: 0, silver: 0 }, holdout: { size: 0, gold: 0, silver: 0 } },
  };

  // ---- 1. One label per input ----------------------------------------------
  interface Group {
    input: string;
    normalized: string;
    earliest: number;
    weight: number;
    votes: Record<LabelKind, Map<string, Vote & { origin: LabelOrigin }>>;
    cloud: Map<string, Vote>;
  }
  const groups = new Map<string, Group>();
  const seenTraces = new Set<string>();
  for (const trace of traces) {
    if (trace.task !== task || seenTraces.has(trace.id)) continue;
    seenTraces.add(trace.id);
    stats.traces++;
    if (trace.schemaFingerprint !== fingerprint) {
      stats.staleSchema++;
      continue;
    }
    if (trace.input === null || !trace.label) {
      stats.unlabeled++;
      continue;
    }
    const parsed = parseValue(schema, trace.label.value);
    if (!parsed.ok) {
      stats.invalidLabel++;
      continue;
    }
    const normalized = normalizeInput(trace.input);
    const id = sha256(normalized).slice(0, 24);
    let group = groups.get(id);
    // Of several spellings of one input, the earliest trace's is kept (then the smallest), so the text is stable.
    if (!group) groups.set(id, (group = { input: trace.input, normalized, earliest: trace.timestamp, weight: 0, votes: { gold: new Map(), silver: new Map() }, cloud: new Map() }));
    else if (trace.timestamp < group.earliest || (trace.timestamp === group.earliest && trace.input < group.input)) {
      group.input = trace.input;
      group.earliest = trace.timestamp;
    }
    group.weight = Math.max(group.weight, trace.weight ?? 1);
    const key = canonicalJson(parsed.value);
    if (trace.label.origin === 'cloud') {
      const seen = group.cloud.get(key);
      if (seen) {
        seen.count++;
        seen.latest = Math.max(seen.latest, trace.timestamp);
      } else {
        group.cloud.set(key, { value: parsed.value, key, count: 1, latest: trace.timestamp });
      }
    }
    const votes = group.votes[trace.label.kind];
    const vote = votes.get(key);
    if (vote) {
      vote.count++;
      if (trace.timestamp > vote.latest) vote.latest = trace.timestamp;
      // A real label outranks a synthetic one of the same value.
      if (vote.origin === 'synthetic' && trace.label.origin !== 'synthetic') vote.origin = trace.label.origin;
    } else {
      votes.set(key, { value: parsed.value, key, count: 1, latest: trace.timestamp, origin: trace.label.origin });
    }
  }

  const ranked = <V extends Vote>(votes: Map<string, V>): V[] =>
    [...votes.values()].sort((a, b) => b.count - a.count || b.latest - a.latest || (a.key < b.key ? -1 : 1));
  const resolved = new Map<string, Resolved>();
  for (const [id, group] of groups) {
    const labelKind: LabelKind = group.votes.gold.size ? 'gold' : 'silver';
    const votes = ranked(group.votes[labelKind]);
    const winner = votes[0]!;
    const cloud = ranked(group.cloud)[0];
    resolved.set(id, {
      id,
      input: group.input,
      label: winner.value,
      labelKind,
      origin: winner.origin,
      weight: group.weight,
      conflict: votes.length > 1,
      ...(cloud ? { cloud: cloud.value } : {}),
    });
  }
  stats.inputs = resolved.size;
  for (const r of resolved.values()) if (r.conflict) stats.conflicts++;

  // ---- 2. Near-duplicates share a split --------------------------------------
  const ids = [...resolved.keys()].sort();
  const roots = cluster(ids, new Map(ids.map((id) => [id, groups.get(id)!.normalized])), threshold);
  const clusters = new Map<string, string[]>();
  for (const id of ids) {
    const root = roots.get(id)!;
    const members = clusters.get(root);
    if (members) members.push(id);
    else clusters.set(root, [id]);
  }

  // ---- 3. Assign ----------------------------------------------------------------
  const assignments: Record<string, Split> = { ...(previous?.assignments ?? {}) };
  const draw = (key: string, allowHoldout: boolean): Split => {
    const u = parseInt(sha256(`${seed}\n${key}`).slice(0, 13), 16) / 2 ** 52;
    if (allowHoldout) return u < ratios.holdout ? 'holdout' : u < ratios.holdout + ratios.validation ? 'validation' : 'train';
    const rest = ratios.train + ratios.validation;
    return rest > 0 && u < ratios.validation / rest ? 'validation' : 'train';
  };
  const isSynthetic = (id: string): boolean => resolved.get(id)!.origin === 'synthetic';
  const dropped = new Set<string>();
  for (const [root, members] of clusters) {
    const known = new Set(members.filter((id) => Object.hasOwn(assignments, id)).map((id) => assignments[id]!));
    const fresh = members.filter((id) => !Object.hasOwn(assignments, id));
    if (!fresh.length) continue;
    if (known.size > 1) {
      // A new input that links inputs of different splits would leak between them.
      for (const id of fresh) dropped.add(id);
      stats.droppedAmbiguous += fresh.length;
      continue;
    }
    const split = known.size === 1 ? [...known][0]! : draw(root, !members.every(isSynthetic));
    for (const id of fresh) {
      if (split === 'holdout' && isSynthetic(id)) {
        dropped.add(id);
        stats.droppedSynthetic++;
      } else {
        assignments[id] = split;
      }
    }
  }

  // ---- 4. Emit --------------------------------------------------------------------
  const out: Record<Split, DatasetExample[]> = { train: [], validation: [], holdout: [] };
  for (const id of ids) {
    if (dropped.has(id)) continue;
    const r = resolved.get(id)!;
    const split = assignments[id]!;
    // A holdout input that only has a synthetic label left (its real traces are gone) is not scored.
    if (split === 'holdout' && r.origin === 'synthetic') continue;
    out[split].push({ id, input: r.input, label: r.label, labelKind: r.labelKind, origin: r.origin, ...('cloud' in r ? { cloud: r.cloud } : {}), weight: r.weight });
    stats.splits[split].size++;
    stats.splits[split][r.labelKind]++;
  }
  for (const id of Object.keys(assignments)) if (!resolved.has(id)) stats.missing++;

  const sortedAssignments = Object.fromEntries(Object.entries(assignments).sort(([a], [b]) => (a < b ? -1 : 1)));
  const holdoutIds = Object.keys(sortedAssignments).filter((id) => sortedAssignments[id] === 'holdout');
  const manifest: DatasetManifest = {
    version: DATASET_VERSION,
    task,
    schemaFingerprint: fingerprint,
    seed,
    ratios,
    nearDuplicateThreshold: threshold,
    assignments: sortedAssignments,
    holdoutFingerprint: `sha256:${sha256(holdoutIds.join('\n'))}`,
  };
  return { ...out, manifest, stats };
}
