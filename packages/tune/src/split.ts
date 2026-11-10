import { readFile } from 'node:fs/promises';
import { canonicalJson, fnv1a, labelOf, parseValue, type TaskSchema } from '@swissspidy/belay-core';
import type { Dataset } from '@swissspidy/belay-calibrate';

/** One row of a split file, checked against the schema. */
export interface SplitExample {
  id: string;
  input: string;
  label: unknown;
  labelKind: 'gold' | 'silver';
  weight: number;
  /** The cloud's recorded answer, when there is one. */
  cloud?: unknown;
}

export interface SplitFile {
  examples: SplitExample[];
  /** The same examples, as `evaluateLocal()` takes them. */
  dataset: Dataset;
}

/**
 * Reads a split file written by `belay datasets`. A plain labeled dataset
 * (`{"input": "...", "label": "..."}` per line) is read too: its labels count as gold, with
 * weight 1.
 */
export async function loadSplit(path: string, schema: TaskSchema): Promise<SplitFile> {
  const text = await readFile(path, 'utf8');
  const examples: SplitExample[] = [];
  const seen = new Set<string>();
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trim().startsWith('//')) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`${path}:${i + 1}: invalid JSON`);
    }
    const at = `${path}:${i + 1}`;
    if (typeof row['input'] !== 'string') throw new Error(`${at}: no "input" string`);
    const label = parseValue(schema, row['label']);
    if (!label.ok) throw new Error(`${at}: invalid label: ${label.error}`);
    const id = typeof row['id'] === 'string' || typeof row['id'] === 'number' ? String(row['id']) : String(examples.length + 1);
    if (seen.has(id)) throw new Error(`${at}: duplicate id "${id}"`);
    seen.add(id);
    const labelKind = row['labelKind'] ?? 'gold';
    if (labelKind !== 'gold' && labelKind !== 'silver') throw new Error(`${at}: labelKind must be "gold" or "silver"`);
    const weight = row['weight'] ?? 1;
    if (typeof weight !== 'number' || !(weight > 0) || !Number.isFinite(weight)) throw new Error(`${at}: weight must be a positive number`);
    const example: SplitExample = { id, input: row['input'], label: label.value, labelKind, weight };
    if ('cloud' in row) {
      // An answer that no longer fits the schema is no answer.
      const cloud = parseValue(schema, row['cloud']);
      if (cloud.ok) example.cloud = cloud.value;
    }
    examples.push(example);
  }
  if (!examples.length) throw new Error(`${path}: no examples`);
  return {
    examples,
    dataset: {
      examples: examples.map((e) => ({ id: e.id, input: e.input, expected: e.label, truth: labelOf(schema, e.label) ?? '(structured)' })),
      fingerprint: `fnv1a:${fnv1a(canonicalJson(examples.map((e) => [e.id, e.input, e.label, e.labelKind, e.weight, e.cloud ?? null])))}`,
    },
  };
}
