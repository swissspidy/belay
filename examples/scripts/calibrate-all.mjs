/**
 * Calibrates every example against its own cloud and the alternatives. The example's preferred
 * cloud (see its belay.config.mjs) writes belay.calibration.json and belay-report.html, which the
 * app loads; every other cloud writes belay.calibration.<cloud>.json and belay-report.<cloud>.html
 * for comparison. Local outputs come from each example's cache.
 *
 *   node scripts/calibrate-all.mjs [task ...]
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = fileURLToPath(new URL('./bin.js', import.meta.resolve('@belay/calibrate')));
/** The first cloud is the one the example uses. */
const TASKS = {
  'ticket-triage': ['claude', 'jev'],
  'content-moderation': ['jev', 'claude'],
  'intent-detection': ['jev-claude', 'claude', 'jev'],
  // Structured output: Jev answers choice and yes/no questions only.
  'event-extraction': ['claude'],
};
const only = process.argv.slice(2);

let failed = false;
for (const [name, clouds] of Object.entries(TASKS)) {
  if (only.length && !only.includes(name)) continue;
  for (const [i, cloud] of clouds.entries()) {
    const suffix = i === 0 ? '' : `.${cloud}`;
    console.log(`\n== ${name} × ${cloud}${i === 0 ? ' (used by the app)' : ''}`);
    const run = spawnSync(
      process.execPath,
      [bin, 'calibrate', '--task', name, '--data', 'examples.jsonl', '--out', `belay.calibration${suffix}.json`, '--report', `belay-report${suffix}.html`],
      { cwd: join(root, name), env: { ...process.env, BELAY_CLOUD: cloud }, stdio: 'inherit' },
    );
    // Exit code 2 means "target not met": the files are still written.
    if (run.status !== 0 && run.status !== 2) failed = true;
  }
}
process.exit(failed ? 1 : 0);
