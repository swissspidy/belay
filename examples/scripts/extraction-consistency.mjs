/**
 * Self-consistency for the event-extraction example: runs Gemini Nano (Prompt API) SAMPLES more
 * times on every request and caches each answer in event-extraction/.belay-cache/consistency.jsonl.
 * `scripts/extraction-signals.mjs` turns the agreement between runs into a confidence signal.
 *
 *   BELAY_FORCE_CPU=1 xvfb-run -a node scripts/extraction-consistency.mjs
 *
 * Resumable: cached runs are skipped. MAX_MINUTES stops it cleanly after that long.
 */
import { browserBackend } from '@belay/calibrate';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { webaiBrowser } from '../shared/extension.mjs';
import { context, extractionSchema } from '../event-extraction/task.mjs';

const SAMPLES = Number(process.env.SAMPLES ?? 3);
const deadline = process.env.MAX_MINUTES ? Date.now() + Number(process.env.MAX_MINUTES) * 60_000 : Infinity;
const dir = fileURLToPath(new URL('../event-extraction/', import.meta.url));
const file = `${dir}.belay-cache/consistency.jsonl`;
const done = new Set(existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.id}:${r.run}`; }) : []);
const rows = readFileSync(`${dir}examples.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const todo = rows.flatMap((r) => Array.from({ length: SAMPLES }, (_, i) => ({ ...r, run: i + 1 }))).filter((r) => !done.has(`${r.id}:${r.run}`));
console.log(`${todo.length} runs to do`);
if (!todo.length) process.exit(0);

const backend = await browserBackend({
  task: 'event-extraction',
  schema: extractionSchema,
  context,
  local: { runner: 'prompt-api' },
  browser: { ...webaiBrowser(), headless: process.env.HEADLESS === '1' },
  cacheDir: `${dir}.belay-cache`,
  log: (m) => console.error(m),
});
try {
  // A fresh profile has no model yet: download it (under the harness's user gesture) before the runs.
  const state = await backend.availability();
  if (state === 'unavailable') throw new Error('The Prompt API is unavailable in this browser (see examples/README.md, "Gemini Nano")');
  if (state !== 'available') {
    console.log(`Gemini Nano is ${state}; downloading…`);
    await backend.prepare();
  }
  let n = 0;
  for (const r of todo) {
    if (Date.now() > deadline) break;
    try {
      const out = await backend.run(r.input);
      appendFileSync(file, JSON.stringify({ id: r.id, run: r.run, value: out.value }) + '\n');
    } catch (err) {
      console.error(`example ${r.id} run ${r.run}: ${err.message}`); // not cached: retried next time
    }
    if (++n % 25 === 0) console.log(`${n} of ${todo.length}`);
  }
} finally {
  await backend.close();
}
