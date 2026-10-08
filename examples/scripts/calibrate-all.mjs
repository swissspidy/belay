/**
 * Calibrates every example against its own cloud and the alternatives. The example's preferred
 * cloud (see its belay.config.mjs) writes belay.calibration.json and belay-report.html, which the
 * app loads; every other cloud writes belay.calibration.<cloud>.json and belay-report.<cloud>.html
 * for comparison. Local outputs come from each example's cache.
 *
 *   node scripts/calibrate-all.mjs [--cloud <cloud>] [task ...]
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = fileURLToPath(new URL('./bin.js', import.meta.resolve('@belay/calibrate')));
/** The first cloud is the one the example uses. */
const TASKS = {
  'ticket-triage': ['claude', 'jev', 'gemini'],
  'content-moderation': ['jev', 'claude', 'gemini'],
  'intent-detection': ['jev-claude', 'claude', 'jev', 'gemini'],
  // Structured output: Jev answers choice and yes/no questions only.
  'event-extraction': ['claude', 'gemini'],
};
// `--cloud gemini` runs only that cloud's calibrations.
const args = process.argv.slice(2);
const cloudFlag = args.indexOf('--cloud');
const onlyCloud = cloudFlag >= 0 ? args.splice(cloudFlag, 2)[1] : null;
const only = args;

let failed = false;
for (const [name, clouds] of Object.entries(TASKS)) {
  if (only.length && !only.includes(name)) continue;
  for (const [i, cloud] of clouds.entries()) {
    if (onlyCloud && cloud !== onlyCloud) continue;
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
