#!/usr/bin/env node
/**
 * Builds a seed file (`belay-seed.json`) for each classification example from its labeled
 * `examples.jsonl`: the embeddings a learned classifier starts from, so it is useful before it has
 * learned anything (see `@swissspidy/belay-learn`). This is what an app would run at build time.
 *
 *   node examples/scripts/build-seeds.mjs [ticket-triage content-moderation intent-detection]
 */
import { writeFile } from 'node:fs/promises';
import { buildSeed } from '@swissspidy/belay-learn';
import { cachedEmbedder, readJsonl } from '../shared/embeddings.mjs';

const TASKS = {
  'ticket-triage': { module: '../ticket-triage/task.mjs', schema: 'triageSchema' },
  'content-moderation': { module: '../content-moderation/task.mjs', schema: 'moderationSchema' },
  'intent-detection': { module: '../intent-detection/task.mjs', schema: 'intentSchema' },
};

const only = process.argv.slice(2);
for (const [name, spec] of Object.entries(TASKS)) {
  if (only.length && !only.includes(name)) continue;
  const schema = (await import(spec.module))[spec.schema];
  const examples = await readJsonl(new URL(`../${name}/examples.jsonl`, import.meta.url));
  const seed = await buildSeed({
    task: name,
    schema,
    embedder: await cachedEmbedder(name),
    examples: examples.map((e) => ({ input: e.input, value: e.label })),
    createdAt: '2026-10-12T00:00:00Z',
  });
  await writeFile(new URL(`../${name}/belay-seed.json`, import.meta.url), JSON.stringify(seed) + '\n');
  console.log(`wrote ${name}/belay-seed.json: ${seed.examples.length} examples, ${seed.dimensions} dimensions`);
}
