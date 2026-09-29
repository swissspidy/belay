import { readFile } from 'node:fs/promises';
import { canonicalJson, fnv1a, labelOf, parseValue, type TaskSchema } from '@belay/core';

export interface Example {
  id: string;
  input: string;
  /** Parsed expected value (label string, boolean or structured object). */
  expected: unknown;
  /** Label form used for grouping: the label, "true"/"false", or "(structured)". */
  truth: string;
}

export interface Dataset {
  examples: Example[];
  fingerprint: string;
}

/**
 * Reads JSONL (`{"input": "...", "label": "billing"}` per line) or a JSON array. `expected`
 * is accepted as an alias of `label`, and `text` of `input`. `id` defaults to the line number.
 */
export async function loadDataset(path: string, schema: TaskSchema): Promise<Dataset> {
  const text = await readFile(path, 'utf8');
  let rows: unknown[];
  if (/^\s*\[/.test(text)) {
    rows = JSON.parse(text) as unknown[];
  } else {
    rows = text
      .split(/\r?\n/)
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.trim() && !line.trim().startsWith('//'))
      .map(({ line, i }) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          throw new Error(`${path}:${i + 1}: invalid JSON`);
        }
      });
  }
  const seen = new Set<string>();
  const examples = rows.map((row, i): Example => {
    const r = row as Record<string, unknown>;
    const input = r['input'] ?? r['text'];
    if (typeof input !== 'string') throw new Error(`${path}: example ${i + 1} has no "input" string`);
    const rawLabel = 'label' in r ? r['label'] : r['expected'];
    const parsed = parseValue(schema, rawLabel);
    if (!parsed.ok) throw new Error(`${path}: example ${i + 1}: invalid label: ${parsed.error}`);
    const id = typeof r['id'] === 'string' || typeof r['id'] === 'number' ? String(r['id']) : String(i + 1);
    if (seen.has(id)) throw new Error(`${path}: duplicate id "${id}"`);
    seen.add(id);
    return { id, input, expected: parsed.value, truth: labelOf(schema, parsed.value) ?? '(structured)' };
  });
  if (!examples.length) throw new Error(`${path}: no examples`);
  const fingerprint = `fnv1a:${fnv1a(canonicalJson(examples.map((e) => [e.id, e.input, e.expected])))}`;
  return { examples, fingerprint };
}
