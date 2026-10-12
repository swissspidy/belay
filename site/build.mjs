/**
 * Builds the findings site into `_site/`: `index.html` with the results of every committed
 * calibration inlined, and a copy of each calibration report. The numbers on the page come from
 * the calibration files, so re-running a calibration and rebuilding updates them.
 *
 * It also builds the learned-classifier demo into `_site/learn/`, with the built
 * `@swissspidy/belay-core` and `@swissspidy/belay-learn` (run `npm run build` first), the
 * ticket-triage stream and its seed file.
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

// ---- The learned-classifier demo --------------------------------------------------------------
const learn = join(out, 'learn');
for (const pkg of ['core', 'learn']) {
  const dist = join(root, 'packages', pkg, 'dist');
  let files;
  try {
    files = (await readdir(dist)).filter((f) => f.endsWith('.js'));
  } catch {
    throw new Error(`packages/${pkg}/dist is missing: run \`npm run build\` first`);
  }
  await mkdir(join(learn, 'lib', pkg), { recursive: true });
  for (const f of files) await copyFile(join(dist, f), join(learn, 'lib', pkg, f));
}
await copyFile(join(root, 'site', 'learn', 'index.html'), join(learn, 'index.html'));
await copyFile(join(examples, 'ticket-triage', 'stream.jsonl'), join(learn, 'stream.jsonl'));
await copyFile(join(examples, 'ticket-triage', 'belay-seed.json'), join(learn, 'belay-seed.json'));
console.log(`Wrote ${learn}/`);

// ---- Learned-classifier simulation results (examples/scripts/learn-simulate.mjs) ---------------
const learned = [];
for (const task of Object.keys(TASKS)) {
  let sim;
  try {
    sim = JSON.parse(await readFile(join(examples, task, 'learn-simulation.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') continue;
    throw err;
  }
  for (const r of sim.results) {
    learned.push({
      task,
      taskTitle: TASKS[task].title,
      stream: sim.stream,
      order: r.order,
      teacher: r.teacher,
      teacherAccuracy: r.teacherAccuracy,
      seeded: r.seeded,
      all: r.all,
      last: r.last,
      curve: r.curve.map((c) => ({ from: c.from, runs: c.runs, localShare: c.localShare, localAccuracy: c.localAccuracy })),
    });
  }
}

const template = await readFile(join(root, 'site', 'index.html'), 'utf8');
const json = JSON.stringify(results).replace(/</g, '\\u003c');
if (!template.includes('"__RESULTS__"')) throw new Error('site/index.html lacks the "__RESULTS__" placeholder');
if (!template.includes('"__LEARN__"')) throw new Error('site/index.html lacks the "__LEARN__" placeholder');
const learnJson = JSON.stringify(learned).replace(/</g, '\\u003c');
await writeFile(join(out, 'index.html'), template.replace('"__RESULTS__"', () => json).replace('"__LEARN__"', () => learnJson));
console.log(`Wrote ${out}/index.html with ${results.length} calibrations`);
