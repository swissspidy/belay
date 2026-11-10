import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createBackend, loadConfig, OutputCache, resolveCreatedAt } from '@swissspidy/belay-calibrate';
import { dryRun } from './dry-run.js';
import { loadSplit } from './split.js';

const HELP = `Usage: belay tune --dry-run --task <name> --target <accuracy> [options]

Scores the task's current local side on a dataset split: how much it can answer on the device
while the cascade holds the target accuracy. The examples run through the task's local runner (in
a real Chrome for browser runners) and are compared with their labels. No cloud call is made.

Only --dry-run exists so far: the tuning loop itself is not built yet.

Options:
  --dry-run              Score the current config and stop (required)
  --task <name>          Task name from the config file (required unless it has one task)
  --target <accuracy>    Cascade accuracy to hold, in (0, 1] (default: the task's numeric target)
  --data <file>          Split to score (default: .belay/datasets/<task>/validation.jsonl)
  --repeat <n>           Run the examples n times; later runs skip the cache. Exits with 2 when
                         the local share differs by more than 1 point between runs (default: 1)
  --refresh              Skip the output cache on the first run too
  --seed <seed>          Seed of the bootstrap intervals (default: 0)
  --resamples <n>        Bootstrap resamples for the 95% intervals (default: 1000)
  --cloud-accuracy <a>   Cloud accuracy for gold examples without a recorded cloud answer
                         (default: measured on the gold examples that have one)
  --out <file>           Where to write the score (default: .belay/tune/<task>/baseline.json)
  --config <file>        Config file (default: belay.config.{mjs,js,ts} in the current directory)
  --cache-dir <dir>      Output cache and Chrome profile (default: .belay-cache)
  --no-cache             Neither read nor write cached model outputs
  --extension <dir>      Unpacked Chrome extension to load (e.g. the WebAI Studio extension)
  --browser <path>       Chrome executable (default: installed Chrome; env BELAY_CHROME)
  --headed               Show the browser window
  --created-at <iso>     Timestamp recorded in the file (default: SOURCE_DATE_EPOCH or now)
  --quiet                Only print errors
  -h, --help             Show this help
`;

const pct = (v: number | null | undefined, d = 1) => (v == null ? '–' : `${(v * 100).toFixed(d)}%`);
const range = (i: [number, number] | null) => (i ? ` (95% CI ${pct(i[0])}–${pct(i[1])})` : '');

/** `belay tune`. Returns the exit code: 0, or 2 when the target is not met or the runs disagree. */
export async function tuneCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean' },
      task: { type: 'string' },
      target: { type: 'string' },
      data: { type: 'string' },
      repeat: { type: 'string' },
      refresh: { type: 'boolean' },
      seed: { type: 'string' },
      resamples: { type: 'string' },
      'cloud-accuracy': { type: 'string' },
      out: { type: 'string' },
      config: { type: 'string' },
      'cache-dir': { type: 'string' },
      'no-cache': { type: 'boolean' },
      extension: { type: 'string' },
      browser: { type: 'string' },
      headed: { type: 'boolean' },
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
  if (!values['dry-run']) throw new Error('belay tune only supports --dry-run so far: the tuning loop is not built yet');
  const quiet = values.quiet ?? false;
  const log = (message: string) => {
    if (!quiet) process.stderr.write(`${message}\n`);
  };

  const { config, path: configPath } = await loadConfig(values.config);
  const names = Object.keys(config.tasks);
  const name = values.task ?? (names.length === 1 ? names[0] : undefined);
  if (!name) throw new Error(`--task is required (config has: ${names.join(', ')})`);
  const taskConfig = config.tasks[name];
  if (!taskConfig) throw new Error(`task "${name}" is not in ${relative(process.cwd(), configPath)} (has: ${names.join(', ')})`);
  const local = taskConfig.local;
  if (!local) throw new Error(`task "${name}" has no local runner`);

  const target = values.target !== undefined ? Number(values.target) : typeof taskConfig.target === 'number' ? taskConfig.target : undefined;
  if (target === undefined) throw new Error('--target is required: the cascade accuracy to hold, e.g. 0.95 (the task has no numeric target)');
  if (!(target > 0 && target <= 1)) throw new Error('--target must be a number in (0, 1]');
  const integer = (flag: 'repeat' | 'resamples', min: number): number | undefined => {
    if (values[flag] === undefined) return undefined;
    const n = Number(values[flag]);
    if (!(Number.isInteger(n) && n >= min)) throw new Error(`--${flag} must be an integer of at least ${min}`);
    return n;
  };
  const repeat = integer('repeat', 1);
  const resamples = integer('resamples', 0);
  const cloudAccuracy = values['cloud-accuracy'] !== undefined ? Number(values['cloud-accuracy']) : undefined;
  if (cloudAccuracy !== undefined && !(cloudAccuracy >= 0 && cloudAccuracy <= 1)) throw new Error('--cloud-accuracy must be in [0, 1]');

  const data = values.data ?? `.belay/datasets/${name}/validation.jsonl`;
  let split;
  try {
    split = await loadSplit(data, taskConfig.schema);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    throw new Error(`${data} not found: build it with "belay datasets --task ${name} --traces <path>", or pass --data`);
  }
  log(`Loaded ${split.examples.length} examples from ${data}`);

  const cacheDir = resolve(values['cache-dir'] ?? config.cacheDir ?? '.belay-cache');
  const cache = await OutputCache.open(values['no-cache'] ? null : resolve(cacheDir, `${name}.outputs.jsonl`));
  const backend = await createBackend({
    name,
    taskConfig: { ...taskConfig, local },
    config,
    cacheDir,
    ...(values.extension ? { extension: values.extension } : {}),
    ...(values.browser ? { executablePath: values.browser } : {}),
    ...(values.headed ? { headed: true } : {}),
    log,
  });

  let lastLine = '';
  try {
    const baseline = await dryRun({
      name,
      config: taskConfig,
      split,
      backend,
      cache,
      target,
      ...(values.seed !== undefined ? { seed: values.seed } : {}),
      ...(resamples !== undefined ? { resamples } : {}),
      ...(repeat !== undefined ? { repeat } : {}),
      ...(values.refresh ? { refresh: true } : {}),
      ...(cloudAccuracy !== undefined ? { cloudAccuracy } : {}),
      createdAt: resolveCreatedAt(values['created-at']),
      onProgress: ({ phase, done, total, run }) => {
        if (quiet) return;
        const step = phase === 'prepare' ? Math.floor(done * 10) : Math.floor((done / total) * 10);
        const line = `run ${run + 1} ${phase} ${step * 10}%`;
        if (line !== lastLine) process.stderr.write(`${line}\n`);
        lastLine = line;
      },
      log,
    });

    const out = values.out ?? `.belay/tune/${name}/baseline.json`;
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(out, JSON.stringify(baseline, null, 2) + '\n');

    if (!quiet) {
      const s = baseline.score;
      const lines = [
        '',
        `Task            ${name}`,
        `Local           ${[baseline.environment.runner, baseline.environment.model].filter(Boolean).join(', ')}`,
        ...(baseline.environment.userAgent ? [`Browser         ${baseline.environment.userAgent}`] : []),
        `Examples        ${s.examples} (${s.gold} gold, ${s.silver} silver; ${baseline.cached} cached)`,
        ...(baseline.localFailures ? [`Local failures  ${baseline.localFailures} examples had no valid local answer (always escalated)`] : []),
        `Target          ${pct(s.target)} accuracy ${s.targetMet ? 'met' : 'NOT met (threshold maximizes accuracy instead)'}`,
        `Threshold       ${s.threshold ?? 'none (every run goes to the cloud)'}`,
        `Local share     ${pct(s.localShare)}${range(s.localShareInterval)}`,
        `Accuracy        ${pct(s.accuracy)}${range(s.accuracyInterval)}, ${pct(s.cloudOnlyAccuracy)} cloud only`,
        `Against gold    ${s.goldAccuracy === null ? 'no gold labels' : pct(s.goldAccuracy)}`,
        `Agrees w/ cloud ${s.cloudAgreement === null ? 'no silver labels' : pct(s.cloudAgreement)}`,
        `Kept local      ${pct(s.localAccuracy)} accurate; ${pct(s.catchRate)} of local mistakes escalated`,
        ...(baseline.cloud.assumed
          ? [`Cloud assumed   ${pct(baseline.cloud.assumedAccuracy)} accurate on ${baseline.cloud.assumed} gold examples without a recorded cloud answer`]
          : []),
        ...(s.gold < 100 ? [`Note            fewer than 100 gold labels: the accuracy mostly measures agreement with the cloud`] : []),
        ...(baseline.runs.length > 1
          ? [`Runs            ${baseline.runs.map((r) => pct(r.localShare)).join(', ')} local: ${baseline.stable ? 'agree' : 'DISAGREE'} (spread ${(baseline.spread * 100).toFixed(1)} points)`]
          : []),
        '',
        `Wrote ${out}`,
      ];
      process.stdout.write(lines.join('\n') + '\n');
    }
    return baseline.score.targetMet && baseline.stable ? 0 : 2;
  } finally {
    await backend.close();
  }
}
