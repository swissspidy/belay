import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createBackend, datasetsCommand, loadConfig, OutputCache, resolveCreatedAt, type CalibrationTaskConfig, type LocalBackend, type TuneConfig } from '@swissspidy/belay-calibrate';
import { readManifest } from '@swissspidy/belay-trace/node';
import { dryRun } from './dry-run.js';
import { readLedger } from './ledger.js';
import { tune } from './loop.js';
import { currentState, readLock, writeLock, GATE_FILE, INSTRUCTIONS_FILE, LOCK_FILE } from './protect.js';
import { loadSplit } from './split.js';
import { renderVerify, verify } from './verify.js';

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
  --backend <name>       Tune this backend from tune.backends, and name the files after it
                         (default: the task's own local runner, under its runner's id)
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

/** The id a task's own local runner gives its files, known without opening a browser. */
const runnerId = (local: unknown): string => (typeof (local as { runner?: unknown }).runner === 'string' ? (local as { runner: string }).runner : ((local as { id?: string }).id ?? 'local'));

/**
 * The task as one of its backends sees it. A name from `tune.backends` swaps in that backend's
 * runner, judge and model; any other name only names the files of the task's own runner.
 */
function forBackend(name: string, taskConfig: CalibrationTaskConfig<any>, backend: string | undefined): CalibrationTaskConfig<any> {
  const named = backend === undefined ? undefined : taskConfig.tune?.backends?.[backend];
  if (!named) return taskConfig;
  if (!named.local) throw new Error(`task "${name}": tune.backends["${backend}"] has no local runner`);
  const { judge: _judge, ...rest } = taskConfig;
  return { ...rest, local: named.local, ...(named.judge ? { judge: named.judge } : {}), models: { ...taskConfig.models, ...(named.model ? { local: named.model } : {}) } };
}

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
  const ownConfig = config.tasks[name];
  if (!ownConfig) throw new Error(`task "${name}" is not in ${relative(process.cwd(), configPath)} (has: ${names.join(', ')})`);
  const taskConfig = forBackend(name, ownConfig, values.backend);
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
        `Outcome         ${report.outcome === 'promoted' ? 'a candidate passed the gate' : report.outcome === 'rejected' ? 'the best candidate failed the gate' : report.outcome === 'inconclusive' ? 'inconclusive: the holdout is too small for the gate to tell' : 'plateau: nothing beat the baseline'}`,
        `Baseline        ${pct(report.baseline.localShare)} local at ${pct(report.baseline.accuracy)} accuracy (validation)`,
        ...(report.best.id !== report.entries[0]?.id ? [`Best            ${pct(report.best.localShare)} local at ${pct(report.best.accuracy)} accuracy (validation; ${report.best.id}, ${report.best.rung})`] : []),
        ...(report.gate ? report.gate.checks.map((c) => `Gate ${c.name.padEnd(12)}${c.skipped ? 'skipped' : c.passed ? 'pass   ' : c.inconclusive ? 'unsure ' : 'FAIL   '} ${c.detail}`) : []),
        `Experiments     ${report.experiments.run} run, ${report.experiments.kept} kept, ${report.experiments.discarded} discarded, ${report.experiments.errors} errors (stopped: ${report.stopped})`,
        `Reflector       ${s.reflector.toFixed(4)} ${s.currency} in ${s.calls} calls (cap ${s.cap})`,
        `Protected       ${report.protected.unchanged ? 'unchanged' : 'CHANGED'} (gate config, instructions, evaluator, holdout)`,
        ...report.notes.map((n) => `Note            ${n}`),
        '',
        `Wrote ${[report.files.config, report.files.calibration, report.files.record, report.files.pullRequest, report.files.report].filter(Boolean).join(', ')}`,
      ];
      process.stdout.write(lines.join('\n') + '\n');
    }
    return report.outcome === 'promoted' ? 0 : 2;
  } finally {
    await backend.close();
  }
}

const LEDGER_HELP = `Usage: belay ledger [--task <name>] [--backend <name>] [--run <id>] [--file <path>] [--json]

Prints the experiment history that belay tune keeps in .belay/ledger.jsonl: every candidate,
its hypothesis, its scores on validation and why it was kept or discarded.

Options:
  --task <name>   Only this task
  --backend <name> Only this backend
  --run <id>      Only this run
  --file <path>   The ledger file (default: .belay/ledger.jsonl)
  --json          Print the entries as JSON lines
  -h, --help      Show this help
`;

/** `belay ledger`. Exits with 2 when the file is not intact. */
export async function ledgerCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { task: { type: 'string' }, backend: { type: 'string' }, run: { type: 'string' }, file: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(LEDGER_HELP);
    return 0;
  }
  const path = values.file ?? '.belay/ledger.jsonl';
  const ledger = await readLedger(path);
  const entries = ledger.entries.filter((e) => (!values.task || e.task === values.task) && (!values.backend || e.backend === values.backend) && (!values.run || e.run === values.run));
  if (values.json) {
    process.stdout.write(entries.map((e) => JSON.stringify(e) + '\n').join(''));
  } else if (!entries.length) {
    process.stdout.write(`No experiments in ${path}${values.task ? ` for task "${values.task}"` : ''}.\n`);
  } else {
    const lines: string[] = [];
    for (const e of entries) {
      const scores = e.scores ? `${pct(e.scores.localShare).padStart(6)} local  ${pct(e.scores.accuracy).padStart(6)} acc` : e.gate ? `gate ${e.gate.passed ? 'passed' : `failed: ${e.gate.failed.join(', ')}`}` : '';
      lines.push(`${e.id}  ${e.task}  ${e.backend}  ${e.rung.padEnd(9)} ${e.verdict.padEnd(12)} ${scores}`);
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

const VERIFY_HELP = `Usage: belay verify [--task <name>] [options]

For CI. Checks that the gate config, the instructions, the evaluator and the holdout still match
belay.tune.lock.json and that the ledger is intact. For a task with a tuned config it then runs
that config on the holdout in the current browser, without the output cache, and compares it
input by input with what it did when it passed the gate (belay/<task>/<backend>.gate.json).
It fails when accuracy, local share, a label's recall or the calibration error is worse than
then by more than the gate's margins: a browser update changed the local model.

Makes no cloud call and needs no reflector. Without --task, every task of the config that has a
lock is verified.

Options:
  --task <name>          Only this task
  --datasets <dir>       Splits and manifest (default: .belay/datasets/<task>)
  --backend <name>       Only this backend (default: every backend that has a tuned config)
  --cloud-accuracy <a>   Cloud accuracy for gold examples without a recorded cloud answer
  --seed <seed>          Seed of the bootstrap interval (default: 0)
  --config <file>        Config file (default: belay.config.{mjs,js,ts} in the current directory)
  --cache-dir <dir>      Chrome profile (default: .belay-cache). Outputs are never cached
  --extension <dir>      Unpacked Chrome extension to load
  --browser <path>       Chrome executable (default: installed Chrome; env BELAY_CHROME)
  --headed               Show the browser window
  --quiet                Only print errors
  -h, --help             Show this help

Writes .belay/tune/<task>/<backend>.verify.md and .json.
Exit codes: 0 when every check passes, 1 otherwise.
`;

/** `belay verify`. Returns the exit code: 0, or 1 when a check failed. */
export async function verifyCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: 'string' },
      datasets: { type: 'string' },
      backend: { type: 'string' },
      'cloud-accuracy': { type: 'string' },
      seed: { type: 'string' },
      config: { type: 'string' },
      'cache-dir': { type: 'string' },
      extension: { type: 'string' },
      browser: { type: 'string' },
      headed: { type: 'boolean' },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(VERIFY_HELP);
    return 0;
  }
  const quiet = values.quiet ?? false;
  const log = (message: string) => {
    if (!quiet) process.stderr.write(`${message}\n`);
  };
  const { config, path: configPath } = await loadConfig(values.config);
  const lock = await readLock(process.cwd());
  const names = values.task ? [values.task] : Object.keys(config.tasks).filter((n) => lock?.tasks[n]);
  if (!names.length) throw new Error(`no task of ${relative(process.cwd(), configPath)} has a lock in ${LOCK_FILE}: nothing to verify (belay tune --lock)`);
  if (values.datasets && names.length > 1) throw new Error('--datasets needs --task: each task has its own datasets');
  const cacheDir = resolve(values['cache-dir'] ?? config.cacheDir ?? '.belay-cache');

  let failed = false;
  for (const name of names) {
    const ownConfig = config.tasks[name];
    if (!ownConfig) throw new Error(`task "${name}" is not in ${relative(process.cwd(), configPath)} (has: ${Object.keys(config.tasks).join(', ')})`);
    if (!ownConfig.local) throw new Error(`task "${name}" has no local runner`);
    const datasetsDir = values.datasets ?? `.belay/datasets/${name}`;
    const manifest = await readManifest(datasetsDir);
    if (!manifest) throw new Error(`${datasetsDir}/manifest.json not found: belay verify needs the datasets the lock was written for`);
    const cloudAccuracy = values['cloud-accuracy'] !== undefined ? Number(values['cloud-accuracy']) : ownConfig.tune?.cloudAccuracy;
    if (cloudAccuracy !== undefined && !(cloudAccuracy >= 0 && cloudAccuracy <= 1)) throw new Error('--cloud-accuracy must be in [0, 1]');

    // Every backend with a tuned config is verified; without any, the task's own runner stands in for the lock check.
    const own = runnerId(ownConfig.local);
    let tuned: string[] = [];
    try {
      tuned = (await readdir(resolve(`belay/${name}`))).filter((f) => f.endsWith('.local.json')).map((f) => f.slice(0, -'.local.json'.length)).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const backends = values.backend ? [values.backend] : tuned.length ? tuned : [own];
    for (const backendName of backends) {
      if (backendName !== own && !ownConfig.tune?.backends?.[backendName]) {
        throw new Error(`task "${name}" has a tuned config for backend "${backendName}", but the config file names no such backend (tune.backends) and its own runner is "${own}"`);
      }
      const taskConfig = forBackend(name, ownConfig, backendName);
      const local = taskConfig.local!;
      let last = '';
      const report = await verify({
        name,
        taskConfig,
        root: process.cwd(),
        backend: () =>
          createBackend({
            name,
            taskConfig: { ...taskConfig, local },
            config,
            cacheDir,
            ...(values.extension ? { extension: values.extension } : {}),
            ...(values.browser ? { executablePath: values.browser } : {}),
            ...(values.headed ? { headed: true } : {}),
            log,
          }),
        backendName,
        holdout: () => loadSplit(`${datasetsDir}/holdout.jsonl`, taskConfig.schema),
        manifest,
        ...(cloudAccuracy !== undefined ? { cloudAccuracy } : {}),
        ...(values.seed !== undefined ? { seed: values.seed } : {}),
        log,
        onProgress: ({ done, total }) => {
          if (quiet) return;
          const line = `verify ${name} ${backendName} ${Math.floor((done / total) * 4) * 25}%`;
          if (line !== last) process.stderr.write(`${line}\n`);
          last = line;
        },
      });
      const dir = resolve(`.belay/tune/${name}`);
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, `${backendName}.verify.json`), JSON.stringify(report, null, 2) + '\n');
      await writeFile(resolve(dir, `${backendName}.verify.md`), renderVerify(report));
      if (!report.passed) failed = true;
      if (!quiet || !report.passed) {
        const lines = [
          '',
          `Task            ${name}`,
          `Backend         ${backendName}`,
          `Result          ${report.passed ? (report.tuned ? 'the tuned config still holds' : 'the protected files match the lock') : 'FAILED'}`,
          ...(report.environment ? [`Browser         ${report.environment.current.userAgent ?? report.environment.current.runner}${report.environment.changed ? ' (changed since the gate)' : ''}`] : []),
          ...report.checks.map((c) => `Check ${c.name.padEnd(12)}${c.skipped ? 'info   ' : c.passed ? 'pass   ' : 'FAIL   '} ${c.detail}`),
          ...report.notes.map((n) => `Note            ${n}`),
          '',
        ];
        (report.passed ? process.stdout : process.stderr).write(lines.join('\n') + '\n');
      }
    }
  }
  return failed ? 1 : 0;
}
