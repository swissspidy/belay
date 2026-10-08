/**
 * Builds the findings site into `_site/`: `index.html` with the results of every committed
 * calibration inlined, and a copy of each calibration report. The numbers on the page come from
 * the calibration files, so re-running a calibration and rebuilding updates them.
 *
 *   node site/build.mjs [outDir]
 */
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = resolve(process.argv[2] ?? join(root, '_site'));
const examples = join(root, 'examples');

/** Display order and names. */
const TASKS = {
  'ticket-triage': { title: 'Ticket triage', kind: '5 teams' },
  'content-moderation': { title: 'Content moderation', kind: 'toxic or not' },
  'intent-detection': { title: 'Intent detection', kind: '8 intents' },
  'event-extraction': { title: 'Event extraction', kind: 'JSON, 5 fields' },
};
const CLOUDS = {
  claude: 'Claude Opus 5.5',
  gemini: 'Gemini 3.8 Flash',
  jev: 'Jev 1.13',
  'jev-claude': 'Jev → Claude',
};

/** Which cloud a calibration used, from its runner id. */
function cloudOf(runner) {
  if (runner.startsWith('typesafe:') && runner.includes('>anthropic:')) return 'jev-claude';
  if (runner.startsWith('typesafe:')) return 'jev';
  if (runner.startsWith('anthropic:')) return 'claude';
  if (runner.startsWith('google:')) return 'gemini';
  throw new Error(`Unknown cloud runner ${runner}`);
}

const results = [];
await mkdir(join(out, 'reports'), { recursive: true });
for (const [task, meta] of Object.entries(TASKS)) {
  const dir = join(examples, task);
  const files = (await readdir(dir)).filter((f) => /^belay\.calibration(\.[\w-]+)?\.json$/.test(f)).sort();
  for (const file of files) {
    const c = JSON.parse(await readFile(join(dir, file), 'utf8'));
    const e = c.expected;
    if (!e.heldOut || c.cost?.basis !== 'measured') continue;
    const report = file.replace('belay.calibration', 'belay-report').replace(/\.json$/, '.html');
    await mkdir(join(out, 'reports', task), { recursive: true });
    await copyFile(join(dir, report), join(out, 'reports', task, report));
    const cloud = cloudOf(c.cloud.runner);
    results.push({
      task,
      taskTitle: meta.title,
      kind: meta.kind,
      examples: c.dataset.size,
      cloud,
      cloudName: CLOUDS[cloud],
      used: file === 'belay.calibration.json',
      localModel: c.local.model,
      localAccuracy: c.curve[0].localAccuracy,
      cloudAccuracy: e.cloudAccuracy,
      accuracy: e.heldOut.accuracy,
      localShare: e.heldOut.localShare,
      cloudOnlyCostPer1M: e.cloudOnlyCostPer1k * 1000,
      costPer1M: e.heldOut.costPer1k * 1000,
      threshold: c.threshold,
      report: `reports/${task}/${report}`,
    });
  }
}

const order = Object.keys(CLOUDS);
results.sort((a, b) => Object.keys(TASKS).indexOf(a.task) - Object.keys(TASKS).indexOf(b.task) || order.indexOf(a.cloud) - order.indexOf(b.cloud));

const template = await readFile(join(root, 'site', 'index.html'), 'utf8');
const json = JSON.stringify(results).replace(/</g, '\\u003c');
if (!template.includes('"__RESULTS__"')) throw new Error('site/index.html lacks the "__RESULTS__" placeholder');
await writeFile(join(out, 'index.html'), template.replace('"__RESULTS__"', () => json));
console.log(`Wrote ${out}/index.html with ${results.length} calibrations`);
