import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { browserBackend } from './browser.js';
import { OutputCache } from './cache.js';
import { calibrate } from './calibrate.js';
import { isBrowserJudge, isBrowserRunner, type RunnableTaskConfig } from './config.js';
import { loadDataset } from './dataset.js';
import { seedCommand, simulateCommand } from './learn-cli.js';
import { loadConfig } from './load-config.js';
import { nodeBackend, type LocalBackend } from './evaluate.js';

const HELP = `Usage: belay <command> [options]

Commands:
  calibrate   Fit a task's threshold on labeled examples (below)
  seed        Embed labeled examples into a seed file for @swissspidy/belay-learn
  simulate    Stream labeled examples through a learned classifier and report how it learns

Run "belay seed --help" or "belay simulate --help" for their options.

belay calibrate --task <name> --data <examples.jsonl> [options]

Runs labeled examples through the task's local runner (in a real Chrome) and cloud runner,
then writes belay.calibration.json and an HTML report.

Options:
  --task <name>          Task name from the config file (required unless it has one task)
  --data <file>          Labeled examples, JSONL: {"input": "...", "label": "..."} (required)
  --config <file>        Config file (default: belay.config.{mjs,js,ts} in the current directory)
  --target <t>           "cloud": at least cloud-only accuracy (default), "max": most accurate
                         threshold, or a fixed accuracy in (0, 1]
  --per-label            Also fit per-label thresholds
  --out <file>           Calibration file (default: belay.calibration.json)
  --report <file>        HTML report (default: belay-report.html)
  --cache-dir <dir>      Output cache and Chrome profile (default: .belay-cache)
  --no-cache             Neither read nor write cached model outputs
  --refresh <side>       Re-run "local", "cloud" or "all" even if cached
  --extension <dir>      Unpacked Chrome extension to load (e.g. the WebAI Studio extension)
  --browser <path>       Chrome executable (default: installed Chrome; env BELAY_CHROME)
  --headed               Show the browser window
  --concurrency <n>      Concurrent cloud requests (default: 4)
  --created-at <iso>     Timestamp recorded in the file (default: SOURCE_DATE_EPOCH or now)
  --quiet                Only print errors
  -h, --help             Show this help
`;

const pct = (v: number | null | undefined, d = 1) => (v == null ? '–' : `${(v * 100).toFixed(d)}%`);

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help') {
    process.stdout.write(HELP);
    return command ? 0 : 1;
  }
  if (command === 'seed') return seedCommand(rest);
  if (command === 'simulate') return simulateCommand(rest);
  if (command !== 'calibrate') {
    process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
    return 1;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      task: { type: 'string' },
      data: { type: 'string' },
      config: { type: 'string' },
      target: { type: 'string' },
      'per-label': { type: 'boolean' },
      out: { type: 'string', default: 'belay.calibration.json' },
      report: { type: 'string', default: 'belay-report.html' },
      'cache-dir': { type: 'string' },
      'no-cache': { type: 'boolean' },
      refresh: { type: 'string' },
      extension: { type: 'string' },
      browser: { type: 'string' },
      headed: { type: 'boolean' },
      concurrency: { type: 'string' },
      'created-at': { type: 'string' },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const quiet = values.quiet ?? false;
  const log = (message: string) => {
    if (!quiet) process.stderr.write(`${message}\n`);
  };

  if (!values.data) throw new Error('--data is required');
  const { config, path: configPath } = await loadConfig(values.config);
  const names = Object.keys(config.tasks);
  const name = values.task ?? (names.length === 1 ? names[0] : undefined);
  if (!name) throw new Error(`--task is required (config has: ${names.join(', ')})`);
  const found = config.tasks[name];
  if (!found) throw new Error(`task "${name}" is not in ${relative(process.cwd(), configPath)} (has: ${names.join(', ')})`);
  if (!found.local || !found.cloud) {
    throw new Error(`task "${name}" has no ${found.local ? 'cloud' : 'local'} runner: belay calibrate needs both (belay seed and belay simulate don't)`);
  }
  const taskConfig = found as RunnableTaskConfig<any>;

  const target = values.target === undefined || values.target === 'cloud' || values.target === 'max' ? values.target : Number(values.target);
  if (typeof target === 'number' && !(target > 0 && target <= 1)) throw new Error('--target must be "cloud", "max" or a number in (0, 1]');
  const concurrency = values.concurrency !== undefined ? Number(values.concurrency) : undefined;
  if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency > 0)) {
    throw new Error('--concurrency must be a positive integer');
  }
  const refresh = values.refresh;
  if (refresh && !['local', 'cloud', 'all'].includes(refresh)) throw new Error('--refresh must be local, cloud or all');

  const dataset = await loadDataset(values.data, taskConfig.schema);
  log(`Loaded ${dataset.examples.length} examples from ${values.data}`);

  const cacheDir = resolve(values['cache-dir'] ?? config.cacheDir ?? '.belay-cache');
  const cache = await OutputCache.open(values['no-cache'] ? null : resolve(cacheDir, `${name}.outputs.jsonl`));
  if (cache.size) log(`Output cache: ${cache.size} entries`);

  let backend: LocalBackend;
  if (isBrowserRunner(taskConfig.local)) {
    const browser = { ...config.browser };
    if (values.extension) browser.extension = values.extension;
    if (values.browser) browser.executablePath = values.browser;
    if (values.headed) browser.headless = false;
    const judge = taskConfig.judge;
    if (judge && !isBrowserJudge(judge)) throw new Error('a browser runner needs a browser judge ({ judge: "classifier-judge" })');
    backend = await browserBackend({
      task: name,
      schema: taskConfig.schema,
      ...(taskConfig.context ? { context: taskConfig.context } : {}),
      local: taskConfig.local,
      ...(judge ? { judge } : {}),
      browser,
      cacheDir,
      log,
    });
  } else {
    const judge = taskConfig.judge;
    if (judge && isBrowserJudge(judge)) throw new Error('a Node runner needs a judge function, not a browser judge spec');
    backend = nodeBackend(
      taskConfig.local,
      { task: name, schema: taskConfig.schema, ...(taskConfig.context ? { context: taskConfig.context } : {}) },
      judge,
    );
  }

  let lastLine = '';
  const progress = ({ phase, done, total }: { phase: string; done: number; total: number }) => {
    if (quiet) return;
    if (!process.stderr.isTTY) {
      // Logs (CI, redirected output): one line per 10% step.
      const step = phase === 'prepare' ? Math.floor(done * 10) : Math.floor((done / total) * 10);
      const line = `${phase} ${step * 10}%`;
      if (line !== lastLine && (step !== 0 || lastLine === '' || !lastLine.startsWith(phase))) process.stderr.write(`${line}\n`);
      lastLine = line;
      return;
    }
    const line = phase === 'prepare' ? `download ${pct(done, 0)}` : `${phase} ${done}/${total}`;
    if (line !== lastLine) process.stderr.write(`\r${line.padEnd(24)}`);
    lastLine = line;
    if (phase !== 'prepare' && done === total) process.stderr.write('\n');
  };

  try {
    const result = await calibrate({
      name,
      config: taskConfig,
      dataset,
      backend,
      cache,
      ...(target !== undefined ? { target } : {}),
      ...(values['per-label'] ? { perLabel: true } : {}),
      ...(values['created-at'] ? { createdAt: values['created-at'] } : {}),
      datasetPath: relative(dirname(resolve(values.report!)), resolve(values.data)) || values.data,
      ...(refresh ? { refresh: { local: refresh !== 'cloud', cloud: refresh !== 'local' } } : {}),
      ...(concurrency ? { cloudConcurrency: concurrency } : config.cloudConcurrency ? { cloudConcurrency: config.cloudConcurrency } : {}),
      onProgress: progress,
      log,
    });
    const { file, analysis } = result;
    await mkdir(dirname(resolve(values.out!)), { recursive: true });
    await writeFile(values.out!, JSON.stringify(file, null, 2) + '\n');
    await mkdir(dirname(resolve(values.report!)), { recursive: true });
    await writeFile(values.report!, result.report);

    if (!quiet) {
      const e = file.expected;
      const money = (v: number) => `${v === 0 || Math.abs(v) >= 1 ? v.toFixed(2) : Number(v.toPrecision(2)).toString()} ${file.cost!.currency}`;
      const targetLine =
        file.target.mode === 'cloud' ? `at least cloud only (${pct(file.target.value)})` : file.target.mode === 'max' ? `most accurate (${pct(file.target.value)})` : pct(file.target.value);
      const h = analysis.headToHead;
      const lines = [
        '',
        `Task            ${name}`,
        `Examples        ${dataset.examples.length} (cached: ${result.evaluation.cached.local} local, ${result.evaluation.cached.cloud} cloud)`,
        `Local only      ${pct(analysis.curve[0]!.accuracy)} accuracy`,
        `Cloud only      ${pct(e.cloudAccuracy)} accuracy`,
        `Threshold       ${file.threshold}${file.thresholds ? `  (per label: ${Object.entries(file.thresholds).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`,
        `Cascade         ${pct(e.accuracy)} accuracy (95% CI ${pct(analysis.accuracyInterval[0])}–${pct(analysis.accuracyInterval[1])}), ${pct(e.localShare)} local`,
        ...(e.heldOut
          ? [`Held out        ${pct(e.heldOut.accuracy)} accuracy vs ${pct(e.heldOut.cloudAccuracy)} cloud only, ${pct(e.heldOut.localShare)} local (${e.heldOut.folds}-fold cross-validation)`]
          : []),
        `Kept local      ${h.kept}: ${h.localOnlyRight} only local right, ${h.cloudOnlyRight} only cloud right`,
        ...(e.costPer1k !== undefined && e.cloudOnlyCostPer1k !== undefined
          ? [
              `Cloud cost      ${money(e.costPer1k)} per 1k runs vs ${money(e.cloudOnlyCostPer1k)} cloud only (${file.cost!.basis === 'measured' ? `measured, ${money(file.cost!.cloudPerRun)} per call` : 'estimate'})`,
              `Saved           ${money(e.savingsPer1k!)} per 1k runs (${pct(e.cloudOnlyCostPer1k ? e.savingsPer1k! / e.cloudOnlyCostPer1k : null, 0)})${file.cost!.runsPerMonth ? `, ${money((e.savingsPer1k! * file.cost!.runsPerMonth) / 1000)} per month at ${file.cost!.runsPerMonth.toLocaleString('en-US')} runs` : ''}`,
            ]
          : []),
        `Target          ${targetLine} ${analysis.targetMet ? 'met' : 'NOT met (threshold maximizes accuracy instead)'}`,
        '',
        `Wrote ${values.out} and ${values.report}`,
      ];
      process.stdout.write(lines.join('\n') + '\n');
    }
    return analysis.targetMet ? 0 : 2;
  } finally {
    await backend.close();
  }
}
