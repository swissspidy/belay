import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createBackend, datasetsCommand, loadConfig, OutputCache, resolveCreatedAt, type CalibrationTaskConfig, type LocalBackend, type TuneConfig } from '@swissspidy/belay-calibrate';
import { readManifest } from '@swissspidy/belay-trace/node';
import { dryRun } from './dry-run.js';
import { readLedger } from './ledger.js';
import { tune } from './loop.js';
import { currentState, writeLock, GATE_FILE, INSTRUCTIONS_FILE, LOCK_FILE } from './protect.js';
import { loadSplit } from './split.js';

const HELP = `Usage: belay tune --task <name> [options]

Makes a task need the cloud less. One run: score the current local side on validation, let the
reflecting model propose few-shot examples and rules from the task's failures, measure each
candidate with the task's local runner (in a real Chrome for browser runners), and put the best
one through the gate on the holdout. On a pass it writes belay/<task>/<backend>.local.json and
its calibration file for you to review; otherwise a report says why nothing shipped.

Needs datasets (belay datasets), a lock (belay tune --lock) and tune.reflector in the config.

Modes:
  (default)              Run the loop
  --dry-run              Only score the current config on a split, then stop
  --lock                 Record the gate config, instructions, evaluator and holdout in
                         belay.tune.lock.json. Review and commit it: the loop refuses to run
                         when any of them differs from the lock

Options:
  --task <name>          Task name from the config file (required unless it has one task)
  --target <accuracy>    Cascade accuracy to hold, in (0, 1] (default: tune.target or the task's numeric target)
  --datasets <dir>       Splits and manifest from belay datasets (default: .belay/datasets/<task>)
  --traces <path>        Build the datasets from these traces first (as belay datasets does)
  --gold <file>          With --traces or alone: labeled examples to add as gold labels
  --budget <amount>      Cap on the reflecting model's spend, e.g. 5usd (default: 5)
  --max-experiments <n>  Cap on candidates (default: 20)
  --max-minutes <n>      Stop proposing after this long
  --run <id>             Names this run in the ledger (default: today's date, UTC)
  --resume               Continue a run that was interrupted: cached outputs are replayed
  --backend <name>       Names the config and calibration files (default: the runner's id)
  --cloud-accuracy <a>   Cloud accuracy for gold examples without a recorded cloud answer
  --seed <seed>          Seed of the bootstrap intervals (default: 0)
  --config <file>        Config file (default: belay.config.{mjs,js,ts} in the current directory)
  --cache-dir <dir>      Output cache and Chrome profile (default: .belay-cache)
  --extension <dir>      Unpacked Chrome extension to load
  --browser <path>       Chrome executable (default: installed Chrome; env BELAY_CHROME)
  --headed               Show the browser window
  --quiet                Only print errors
  -h, --help             Show this help

Only with --dry-run:
  --data <file>          Split to score (default: <datasets>/validation.jsonl)
  --repeat <n>           Run the examples n times; later runs skip the cache. Exits with 2 when
                         the local share differs by more than 1 point between runs (default: 1)
  --refresh              Skip the output cache on the first run too
  --resamples <n>        Bootstrap resamples for the 95% intervals (default: 1000)
  --out <file>           Where to write the score (default: .belay/tune/<task>/baseline.json)
  --no-cache             Neither read nor write cached model outputs
  --created-at <iso>     Timestamp recorded in the file (default: SOURCE_DATE_EPOCH or now)

Exit codes: 0 when a candidate was promoted (dry run: target met and runs agree), 2 otherwise.
`;

const pct = (v: number | null | undefined, d = 1) => (v == null ? '–' : `${(v * 100).toFixed(d)}%`);
const range = (i: [number, number] | null) => (i ? ` (95% CI ${pct(i[0])}–${pct(i[1])})` : '');

/** `belay tune`. Returns the exit code: 0, or 2 when the target is not met or the runs disagree. */
export async function tuneCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean' },
      lock: { type: 'boolean' },
      datasets: { type: 'string' },
      traces: { type: 'string' },
      gold: { type: 'string' },
      budget: { type: 'string' },
      'max-experiments': { type: 'string' },
      'max-minutes': { type: 'string' },
      run: { type: 'string' },
      resume: { type: 'boolean' },
      backend: { type: 'string' },
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

  const tuneConfig = taskConfig.tune ?? {};
  const datasetsDir = values.datasets ?? `.belay/datasets/${name}`;
  if (values.traces || (values.gold && !values['dry-run'])) {
    const code = await datasetsCommand(['--task', name, '--out', datasetsDir, '--quiet', ...(values.config ? ['--config', values.config] : []), ...(values.traces ? ['--traces', values.traces] : []), ...(values.gold ? ['--gold', values.gold] : [])]);
    if (code !== 0) return code;
  }
  if (values.lock) {
    const manifest = await readManifest(datasetsDir);
    if (!manifest) throw new Error(`${datasetsDir}/manifest.json not found: build the datasets first (belay datasets), the lock records their holdout`);
    const state = await currentState(process.cwd(), manifest);
    await writeLock(process.cwd(), name, state.lock);
    if (!quiet) {
      process.stdout.write(
        [
          '',
          `Task            ${name}`,
          `Gate config     ${state.lock.gate.slice(0, 19)}…  (${GATE_FILE}, or the defaults)`,
          `Instructions    ${state.lock.instructions ? `${state.lock.instructions.slice(0, 19)}…  (${INSTRUCTIONS_FILE})` : `none (${INSTRUCTIONS_FILE} does not exist)`}`,
          `Evaluator       ${state.lock.evaluator.slice(0, 19)}…  (the installed @swissspidy/belay-* packages)`,
          `Holdout         ${state.lock.holdout.ids.length} inputs`,
          '',
          `Wrote ${LOCK_FILE}. Review and commit it.`,
          '',
        ].join('\n'),
      );
    }
    return 0;
  }

  const target = values.target !== undefined ? Number(values.target) : (tuneConfig.target ?? (typeof taskConfig.target === 'number' ? taskConfig.target : undefined));
  if (target === undefined) throw new Error('--target is required: the cascade accuracy to hold, e.g. 0.95 (the task has no numeric target)');
  if (!(target > 0 && target <= 1)) throw new Error('--target must be a number in (0, 1]');
  const integer = (flag: 'repeat' | 'resamples' | 'max-experiments' | 'max-minutes', min: number): number | undefined => {
    if (values[flag] === undefined) return undefined;
    const n = Number(values[flag]);
    if (!(Number.isInteger(n) && n >= min)) throw new Error(`--${flag} must be an integer of at least ${min}`);
    return n;
  };
  const repeat = integer('repeat', 1);
  const resamples = integer('resamples', 0);
  const cloudAccuracy = values['cloud-accuracy'] !== undefined ? Number(values['cloud-accuracy']) : tuneConfig.cloudAccuracy;
  if (cloudAccuracy !== undefined && !(cloudAccuracy >= 0 && cloudAccuracy <= 1)) throw new Error('--cloud-accuracy must be in [0, 1]');

  const cacheDir = resolve(values['cache-dir'] ?? config.cacheDir ?? '.belay-cache');
  const cache = await OutputCache.open(values['no-cache'] ? null : resolve(cacheDir, `${name}.outputs.jsonl`));
  const openBackend = () =>
    createBackend({
      name,
      taskConfig: { ...taskConfig, local },
      config,
      cacheDir,
      ...(values.extension ? { extension: values.extension } : {}),
      ...(values.browser ? { executablePath: values.browser } : {}),
      ...(values.headed ? { headed: true } : {}),
      log,
    });

  if (!values['dry-run']) {
    return runLoop({ name, taskConfig, tuneConfig, datasetsDir, target, cache, openBackend, quiet, log, ...(cloudAccuracy !== undefined ? { cloudAccuracy } : {}), values });
  }

  const data = values.data ?? `${datasetsDir}/validation.jsonl`;
  let split;
  try {
    split = await loadSplit(data, taskConfig.schema);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    throw new Error(`${data} not found: build it with "belay datasets --task ${name} --traces <path>", or pass --data`);
  }
  log(`Loaded ${split.examples.length} examples from ${data}`);
  const backend = await openBackend();

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

interface LoopArgs {
  name: string;
  taskConfig: CalibrationTaskConfig<any>;
  tuneConfig: TuneConfig;
  datasetsDir: string;
  target: number;
  cloudAccuracy?: number;
  cache: OutputCache;
  openBackend: () => Promise<LocalBackend>;
  quiet: boolean;
  log: (message: string) => void;
  values: { budget?: string; 'max-experiments'?: string; 'max-minutes'?: string; run?: string; resume?: boolean; backend?: string; seed?: string };
}

async function runLoop(args: LoopArgs): Promise<number> {
  const { name, taskConfig, tuneConfig, datasetsDir, values, quiet } = args;
  if (!tuneConfig.reflector) throw new Error(`task "${name}" has no tune.reflector in the config: the model that proposes changes (see reflectorAdapter)`);
  const budget = values.budget === undefined ? 5 : Number(values.budget.replace(/\s*(usd|\$)\s*$/i, '').replace(/^\$/, ''));
  if (!(budget > 0) || !Number.isFinite(budget)) throw new Error('--budget must be a positive amount, e.g. 5usd');
  const positive = (flag: 'max-experiments' | 'max-minutes'): number | undefined => {
    if (values[flag] === undefined) return undefined;
    const n = Number(values[flag]);
    if (!(n > 0) || !Number.isFinite(n) || (flag === 'max-experiments' && !Number.isInteger(n))) throw new Error(`--${flag} must be a positive ${flag === 'max-experiments' ? 'integer' : 'number'}`);
    return n;
  };
  const maxExperiments = positive('max-experiments') ?? 20;
  const maxMinutes = positive('max-minutes');

  const manifest = await readManifest(datasetsDir);
  if (!manifest) throw new Error(`${datasetsDir}/manifest.json not found: build the datasets with "belay datasets --task ${name} --traces <path>", or pass --traces`);
  const [train, validation] = await Promise.all([loadSplit(`${datasetsDir}/train.jsonl`, taskConfig.schema), loadSplit(`${datasetsDir}/validation.jsonl`, taskConfig.schema)]);
  args.log(`Loaded ${train.examples.length} training and ${validation.examples.length} validation examples from ${datasetsDir}`);

  const backend = await args.openBackend();
  let last = '';
  try {
    const info = await backend.info();
    const report = await tune({
      name,
      taskConfig,
      root: process.cwd(),
      backend,
      backendName: values.backend ?? info.runner,
      cache: args.cache,
      train,
      validation,
      holdout: () => loadSplit(`${datasetsDir}/holdout.jsonl`, taskConfig.schema),
      manifest,
      reflector: tuneConfig.reflector,
      ...(tuneConfig.prices ? { prices: tuneConfig.prices } : {}),
      ...(tuneConfig.costPerCall !== undefined ? { costPerCall: tuneConfig.costPerCall } : {}),
      ...(tuneConfig.currency ? { currency: tuneConfig.currency } : {}),
      ...(tuneConfig.cloudPerRun !== undefined ? { cloudPerRun: tuneConfig.cloudPerRun } : {}),
      target: args.target,
      ...(args.cloudAccuracy !== undefined ? { cloudAccuracy: args.cloudAccuracy } : {}),
      budget: { reflectorSpend: budget, maxExperiments, ...(maxMinutes !== undefined ? { maxMinutes } : {}) },
      run: values.run ?? new Date().toISOString().slice(0, 10),
      ...(values.resume ? { resume: true } : {}),
      ...(values.seed !== undefined ? { seed: values.seed } : {}),
      log: args.log,
      onProgress: ({ what, done, total }) => {
        if (quiet) return;
        const line = `${what} ${Math.floor((done / total) * 4) * 25}%`;
        if (line !== last) process.stderr.write(`${line}\n`);
        last = line;
      },
    });
    if (!quiet) {
      const s = report.spend;
      const lines = [
        '',
        `Task            ${name}`,
        `Outcome         ${report.outcome === 'promoted' ? 'a candidate passed the gate' : report.outcome === 'rejected' ? 'the best candidate failed the gate' : 'plateau: nothing beat the baseline'}`,
        `Baseline        ${pct(report.baseline.localShare)} local at ${pct(report.baseline.accuracy)} accuracy (validation)`,
        ...(report.best.id !== report.entries[0]?.id ? [`Best            ${pct(report.best.localShare)} local at ${pct(report.best.accuracy)} accuracy (validation; ${report.best.id}, ${report.best.rung})`] : []),
        ...(report.gate ? report.gate.checks.map((c) => `Gate ${c.name.padEnd(12)}${c.skipped ? 'skipped' : c.passed ? 'pass   ' : 'FAIL   '} ${c.detail}`) : []),
        `Experiments     ${report.experiments.run} run, ${report.experiments.kept} kept, ${report.experiments.discarded} discarded, ${report.experiments.errors} errors (stopped: ${report.stopped})`,
        `Reflector       ${s.reflector.toFixed(4)} ${s.currency} in ${s.calls} calls (cap ${s.cap})`,
        `Protected       ${report.protected.unchanged ? 'unchanged' : 'CHANGED'} (gate config, instructions, evaluator, holdout)`,
        ...report.notes.map((n) => `Note            ${n}`),
        '',
        `Wrote ${[report.files.config, report.files.calibration, report.files.report].filter(Boolean).join(', ')}`,
      ];
      process.stdout.write(lines.join('\n') + '\n');
    }
    return report.outcome === 'promoted' ? 0 : 2;
  } finally {
    await backend.close();
  }
}

const LEDGER_HELP = `Usage: belay ledger [--task <name>] [--run <id>] [--file <path>] [--json]

Prints the experiment history that belay tune keeps in .belay/ledger.jsonl: every candidate,
its hypothesis, its scores on validation and why it was kept or discarded.

Options:
  --task <name>   Only this task
  --run <id>      Only this run
  --file <path>   The ledger file (default: .belay/ledger.jsonl)
  --json          Print the entries as JSON lines
  -h, --help      Show this help
`;

/** `belay ledger`. Exits with 2 when the file is not intact. */
export async function ledgerCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { task: { type: 'string' }, run: { type: 'string' }, file: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(LEDGER_HELP);
    return 0;
  }
  const path = values.file ?? '.belay/ledger.jsonl';
  const ledger = await readLedger(path);
  const entries = ledger.entries.filter((e) => (!values.task || e.task === values.task) && (!values.run || e.run === values.run));
  if (values.json) {
    process.stdout.write(entries.map((e) => JSON.stringify(e) + '\n').join(''));
  } else if (!entries.length) {
    process.stdout.write(`No experiments in ${path}${values.task ? ` for task "${values.task}"` : ''}.\n`);
  } else {
    const lines: string[] = [];
    for (const e of entries) {
      const scores = e.scores ? `${pct(e.scores.localShare).padStart(6)} local  ${pct(e.scores.accuracy).padStart(6)} acc` : e.gate ? `gate ${e.gate.passed ? 'passed' : `failed: ${e.gate.failed.join(', ')}`}` : '';
      lines.push(`${e.id}  ${e.task}  ${e.rung.padEnd(9)} ${e.verdict.padEnd(9)} ${scores}`);
      lines.push(`    ${e.hypothesis}`);
      lines.push(`    ${e.reason}`);
    }
    const spend = entries.reduce((n, e) => n + (e.cost?.reflector ?? 0), 0);
    lines.push('', `${entries.length} entries, ${entries.filter((e) => e.verdict === 'kept').length} kept, ${entries.filter((e) => e.verdict === 'promoted').length} promoted; reflector spend ${spend.toFixed(4)}`);
    process.stdout.write(lines.join('\n') + '\n');
  }
  if (!ledger.intact) process.stderr.write(`belay: ${path} is not intact: a line was changed or removed\n`);
  return ledger.intact ? 0 : 2;
}
