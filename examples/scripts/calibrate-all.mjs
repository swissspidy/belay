/**
 * Calibrates every example against each cloud model: Claude writes belay.calibration.json and
 * belay-report.html (what the apps load), Jev writes belay.calibration.jev.json and
 * belay-report.jev.html for comparison. Local outputs come from each example's cache.
 *
 *   node scripts/calibrate-all.mjs [claude|jev ...]
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = fileURLToPath(new URL('./bin.js', import.meta.resolve('@belay/calibrate')));
const tasks = ['ticket-triage', 'content-moderation', 'intent-detection'];
const clouds = process.argv.length > 2 ? process.argv.slice(2) : ['claude', 'jev'];
const outputs = { claude: ['belay.calibration.json', 'belay-report.html'], jev: ['belay.calibration.jev.json', 'belay-report.jev.html'] };

let failed = false;
for (const cloud of clouds) {
  if (!outputs[cloud]) throw new Error(`unknown cloud "${cloud}" (claude or jev)`);
  const [out, report] = outputs[cloud];
  for (const name of tasks) {
    console.log(`\n== ${name} × ${cloud}`);
    const run = spawnSync(process.execPath, [bin, 'calibrate', '--task', name, '--data', 'examples.jsonl', '--out', out, '--report', report], {
      cwd: join(root, name),
      env: { ...process.env, BELAY_CLOUD: cloud },
      stdio: 'inherit',
    });
    // Exit code 2 means "target not met": the files are still written.
    if (run.status !== 0 && run.status !== 2) failed = true;
  }
}
process.exit(failed ? 1 : 0);
