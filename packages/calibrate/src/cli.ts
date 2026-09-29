import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { browserBackend } from './browser.js';
import { OutputCache } from './cache.js';
import { calibrate } from './calibrate.js';
import { isBrowserJudge, isBrowserRunner, type BelayConfig } from './config.js';
import { loadDataset } from './dataset.js';
import { nodeBackend, type LocalBackend } from './evaluate.js';

const HELP = `Usage: belay calibrate --task <name> --data <examples.jsonl> [options]

Runs labeled examples through the task's local runner (in a real Chrome) and cloud runner,
then writes belay.calibration.json and an HTML report.

Options:
  --task <name>          Task name from the config file (required unless it has one task)
  --data <file>          Labeled examples, JSONL: {"input": "...", "label": "..."} (required)
  --config <file>        Config file (default: belay.config.{mjs,js,ts} in the current directory)
  --target <0..1>        Target cascade accuracy (default: task config, else 0.95)
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig(path: string | undefined): Promise<{ config: BelayConfig; path: string }> {
  const candidates = path ? [path] : ['belay.config.mjs', 'belay.config.js', 'belay.config.ts'];
  for (const candidate of candidates) {
    const full = resolve(candidate);
    if (!(await exists(full))) continue;
    try {
      const mod = (await import(pathToFileURL(full).href)) as { default?: BelayConfig };
      if (!mod.default?.tasks) throw new Error('the config must `export default { tasks: { ... } }`');
      return { config: mod.default, path: full };
    } catch (err) {
      if (full.endsWith('.ts') && (err as NodeJS.ErrnoException).code === 'ERR_UNKNOWN_FILE_EXTENSION') {
        throw new Error(`${candidate}: this Node version cannot import TypeScript; use belay.config.mjs or Node >= 22.18`);
      }
      throw err;
    }
  }
  throw new Error(path ? `config file not found: ${path}` : 'no belay.config.{mjs,js,ts} in the current directory (or pass --config)');
}

const pct = (v: number | null | undefined, d = 1) => (v == null ? '–' : `${(v * 100).toFixed(d)}%`);

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help') {
    process.stdout.write(HELP);
    return command ? 0 : 1;
  }
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
  const taskConfig = config.tasks[name];
  if (!taskConfig) throw new Error(`task "${name}" is not in ${relative(process.cwd(), configPath)} (has: ${names.join(', ')})`);

  const target = values.target !== undefined ? Number(values.target) : undefined;
  if (target !== undefined && !(target > 0 && target <= 1)) throw new Error('--target must be in (0, 1]');
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
      ...(values.concurrency ? { cloudConcurrency: Number(values.concurrency) } : config.cloudConcurrency ? { cloudConcurrency: config.cloudConcurrency } : {}),
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
      const lines = [
        '',
        `Task            ${name}`,
        `Examples        ${dataset.examples.length} (cached: ${result.evaluation.cached.local} local, ${result.evaluation.cached.cloud} cloud)`,
        `Local only      ${pct(analysis.curve[0]!.accuracy)} accuracy`,
        `Cloud only      ${pct(e.cloudAccuracy)} accuracy`,
        `Threshold       ${file.threshold}${file.thresholds ? `  (per label: ${Object.entries(file.thresholds).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`,
        `Cascade         ${pct(e.accuracy)} accuracy (95% CI ${pct(analysis.accuracyInterval[0])}–${pct(analysis.accuracyInterval[1])}), ${pct(e.localShare)} local${e.costPer1k !== undefined ? `, ${e.costPer1k} ${file.cost!.currency} per 1k runs` : ''}`,
        `Target          ${pct(file.target.value)} ${analysis.targetMet ? 'met' : 'NOT met (threshold maximizes accuracy instead)'}`,
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
