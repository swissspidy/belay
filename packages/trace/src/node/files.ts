import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatasetExample, DatasetManifest, Datasets } from './dataset.js';

export const MANIFEST_FILE = 'manifest.json';

/** Reads the manifest a previous build wrote into `dir`, or `undefined` on the first build. */
export async function readManifest(dir: string): Promise<DatasetManifest | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, MANIFEST_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return JSON.parse(text) as DatasetManifest;
}

const jsonl = (examples: readonly DatasetExample[]): string => examples.map((e) => JSON.stringify(e) + '\n').join('');

/**
 * Writes `train.jsonl`, `validation.jsonl`, `holdout.jsonl` and `manifest.json` into `dir`. The
 * split files hold input text; the manifest holds only hashes and is the file to commit.
 */
export async function writeDatasets(dir: string, datasets: Datasets): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, 'train.jsonl'), jsonl(datasets.train)),
    writeFile(join(dir, 'validation.jsonl'), jsonl(datasets.validation)),
    writeFile(join(dir, 'holdout.jsonl'), jsonl(datasets.holdout)),
    writeFile(join(dir, MANIFEST_FILE), JSON.stringify(datasets.manifest, null, 2) + '\n'),
  ]);
}
