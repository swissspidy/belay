import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { TaskSchema } from '@swissspidy/belay-core';
import { buildSeed, parseSeed, simulateLearning, transformersEmbedder, type Embedder, type SimulationSummary } from '@swissspidy/belay-learn';
import type { CalibrationTaskConfig, LearnConfig } from './config.js';
import { loadDataset } from './dataset.js';
import { loadConfig } from './load-config.js';

const SEED_HELP = `Usage: belay seed --task <name> --data <examples.jsonl> [options]

Embeds labeled examples into a seed file (belay-seed.json) for @swissspidy/belay-learn, so a
learned classifier answers from its first run. Embeddings only: the file holds no text. Uses the
task's schema and learn.embedder from the config; the page must use the same embedder options.

Needs @huggingface/transformers (npm install --save-dev @huggingface/transformers), unless the
config passes its own Embedder.

Options:
  --task <name>          Task name from the config file (required unless it has one task)
  --data <file>          Labeled examples, JSONL: {"input": "...", "label": "..."} (required)
  --config <file>        Config file (default: belay.config.{mjs,js,ts} in the current directory)
  --out <file>           Seed file (default: belay-seed.json)
  --created-at <iso>     Timestamp recorded in the file (default: SOURCE_DATE_EPOCH or now)
  --quiet                Only print errors
  -h, --help             Show this help
`;

const SIMULATE_HELP = `Usage: belay simulate --task <name> --data <stream.jsonl> [options]

Streams labeled examples through a learned classifier (@swissspidy/belay-learn) in order, as an
app would see them: the labels stand in for the cloud, and the classifier learns from every
escalation. Prints how much it answered on the device and how accurately, over time. Use it to
pick a threshold and to see whether a task suits a learned classifier at all.

Needs @huggingface/transformers, unless the config passes its own Embedder.

Options:
  --task <name>          Task name from the config file (required unless it has one task)
  --data <file>          Labeled examples, JSONL, in arrival order (required)
  --config <file>        Config file (default: belay.config.{mjs,js,ts} in the current directory)
  --seed <file>          Start from a seed file (belay seed)
  --threshold <t>        Task threshold (default: learn.threshold or 0.9)
  --explore <rate>       Share of confident runs still sent to the cloud (default: learn.explore or 0.05)
  --strategy <s>         Exploration: "uniform" (default) or "informative"
  --teacher-accuracy <a> Simulate a cloud that is right with this probability, in (0, 1] (default: 1)
  --window <n>           Inputs per row of the learning curve (default: 100)
  --out <file>           Also write the result as JSON
  --quiet                Only print the summary
  -h, --help             Show this help
`;

const pct = (v: number | null | undefined) => (v == null ? '   –  ' : `${(v * 100).toFixed(1).padStart(5)}%`);

function pickTask(config: { tasks: Record<string, CalibrationTaskConfig<any>> }, name: string | undefined, configPath: string) {
  const names = Object.keys(config.tasks);
  const task = name ?? (names.length === 1 ? names[0] : undefined);
  if (!task) throw new Error(`--task is required (config has: ${names.join(', ')})`);
  const taskConfig = config.tasks[task];
  if (!taskConfig) throw new Error(`task "${task}" is not in ${relative(process.cwd(), configPath)} (has: ${names.join(', ')})`);
  return { task, taskConfig };
}

function embedderOf(learn: LearnConfig | undefined): Embedder {
  const e = learn?.embedder;
  if (e && typeof (e as Embedder).embed === 'function') return e as Embedder;
  return transformersEmbedder((e ?? {}) as Exclude<LearnConfig['embedder'], Embedder>);
}

async function ready(embedder: Embedder, log: (m: string) => void): Promise<void> {
  if ((await embedder.availability()) === 'available') return;
  log(`Loading the embedding model (${embedder.id})…`);
  try {
    await embedder.prepare?.();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/@huggingface\/transformers/.test(message) || /Cannot find (module|package)/.test(message)) {
      throw new Error('the embedder needs @huggingface/transformers: npm install --save-dev @huggingface/transformers');
    }
    throw err;
  }
  if ((await embedder.availability()) !== 'available') {
    throw new Error(`the embedding model is ${await embedder.availability()}; is @huggingface/transformers installed?`);
  }
}

function createdAt(value: string | undefined): string {
  if (value) return new Date(value).toISOString();
  const epoch = process.env['SOURCE_DATE_EPOCH'];
  return epoch ? new Date(Number(epoch) * 1000).toISOString() : new Date().toISOString();
}

export async function seedCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: 'string' },
      data: { type: 'string' },
      config: { type: 'string' },
      out: { type: 'string', default: 'belay-seed.json' },
      'created-at': { type: 'string' },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(SEED_HELP);
    return 0;
  }
  const log = (m: string) => {
    if (!values.quiet) process.stderr.write(`${m}\n`);
  };
  if (!values.data) throw new Error('--data is required');
  const { config, path } = await loadConfig(values.config);
  const { task, taskConfig } = pickTask(config, values.task, path);
  const dataset = await loadDataset(values.data, taskConfig.schema as TaskSchema);
  const embedder = embedderOf(taskConfig.learn);
  await ready(embedder, log);
  log(`Embedding ${dataset.examples.length} examples…`);
  const seed = await buildSeed({
    task,
    schema: taskConfig.schema,
    embedder,
    examples: dataset.examples.map((e) => ({ input: e.input, value: e.expected })),
    createdAt: createdAt(values['created-at']),
  });
  await mkdir(dirname(resolve(values.out!)), { recursive: true });
  await writeFile(values.out!, JSON.stringify(seed) + '\n');
  const perLabel = new Map<string, number>();
  for (const e of seed.examples) perLabel.set(e.label, (perLabel.get(e.label) ?? 0) + 1);
  const thin = [...perLabel].filter(([, n]) => n < 3).map(([l]) => l);
  log(`Wrote ${values.out}: ${seed.examples.length} examples, ${seed.dimensions} dimensions (${embedder.id})`);
  if (seed.examples.length < 30) log('Note: under 30 examples, the classifier still escalates until it has scored 30 predictions of its own.');
  if (thin.length) log(`Note: fewer than 3 examples for ${thin.join(', ')}; those labels stay in the cloud until it has learned more.`);
  return 0;
}

export async function simulateCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: 'string' },
      data: { type: 'string' },
      config: { type: 'string' },
      seed: { type: 'string' },
      threshold: { type: 'string' },
      explore: { type: 'string' },
      strategy: { type: 'string' },
      'teacher-accuracy': { type: 'string' },
      window: { type: 'string' },
      out: { type: 'string' },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(SIMULATE_HELP);
    return 0;
  }
  const log = (m: string) => {
    if (!values.quiet) process.stderr.write(`${m}\n`);
  };
  if (!values.data) throw new Error('--data is required');
  const num = (flag: string, v: string | undefined, ok: (n: number) => boolean) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!ok(n)) throw new Error(`--${flag}: invalid value "${v}"`);
    return n;
  };
  const threshold = num('threshold', values.threshold, (n) => n >= 0 && n <= 1);
  const exploreRate = num('explore', values.explore, (n) => n >= 0 && n <= 1);
  const teacherAccuracy = num('teacher-accuracy', values['teacher-accuracy'], (n) => n > 0 && n <= 1) ?? 1;
  const windowSize = num('window', values.window, (n) => Number.isInteger(n) && n > 0) ?? 100;
  if (values.strategy && values.strategy !== 'uniform' && values.strategy !== 'informative') throw new Error('--strategy must be "uniform" or "informative"');

  const { config, path } = await loadConfig(values.config);
  const { task, taskConfig } = pickTask(config, values.task, path);
  const schema = taskConfig.schema as TaskSchema;
  const dataset = await loadDataset(values.data, schema);
  const seed = values.seed ? parseSeed(JSON.parse(await readFile(values.seed, 'utf8'))) : undefined;
  if (seed && seed.task !== task) throw new Error(`--seed: ${values.seed} is a seed for task "${seed.task}", not "${task}"`);
  const embedder = embedderOf(taskConfig.learn);
  await ready(embedder, log);

  const learn = taskConfig.learn ?? {};
  const baseExplore = learn.explore ?? 0.05;
  const explore = {
    ...(typeof baseExplore === 'number' ? { rate: baseExplore } : baseExplore),
    ...(exploreRate !== undefined ? { rate: exploreRate } : {}),
    ...(values.strategy ? { strategy: values.strategy as 'uniform' | 'informative' } : {}),
  };
  // A fallible cloud: wrong as often as --teacher-accuracy says, with a uniformly drawn wrong label.
  let s = 11;
  const noise = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const labels = [...new Set(dataset.examples.map((e) => e.truth))];
  const teacher =
    teacherAccuracy < 1
      ? (_input: string, truth: unknown) => {
          if (noise() < teacherAccuracy) return truth;
          const others = labels.filter((l) => l !== String(truth));
          const wrong = others[Math.floor(noise() * others.length)] ?? String(truth);
          return schema.type === 'binary' ? wrong === 'true' : wrong;
        }
      : undefined;

  let shown = 0;
  const result = await simulateLearning({
    name: task,
    schema,
    embedder,
    stream: dataset.examples.map((e) => ({ input: e.input, value: e.expected })),
    threshold: threshold ?? learn.threshold ?? 0.9,
    explore,
    window: windowSize,
    ...(teacher ? { teacher } : {}),
    ...(seed ? { seed } : {}),
    ...(learn.classifier ? { classifier: learn.classifier } : {}),
    onProgress: (done, total) => {
      if (values.quiet || !process.stderr.isTTY) return;
      if (done - shown >= 10 || done === total) {
        process.stderr.write(`\r${done}/${total}`);
        shown = done;
        if (done === total) process.stderr.write('\n');
      }
    },
  });

  const row = (label: string, r: SimulationSummary) =>
    `${label.padEnd(14)} ${pct(r.localShare).padStart(9)}  ${pct(r.localAccuracy).padStart(9)}  ${pct(r.accuracy).padStart(9)}  ${String(r.cloudCalls).padStart(11)}`;
  const lines = [
    '',
    `Task           ${task}: ${dataset.examples.length} inputs${seed ? `, seed of ${seed.examples.length}` : ''}, threshold ${threshold ?? learn.threshold ?? 0.9}, explore ${explore.rate} (${explore.strategy ?? 'uniform'})${teacherAccuracy < 1 ? `, teacher right ${pct(teacherAccuracy).trim()}` : ''}`,
    '',
    `Inputs         ${'On device'.padStart(9)}  ${'Accurate'.padStart(9)}  ${'Overall'.padStart(9)}  ${'Cloud calls'.padStart(11)}`,
    ...result.curve.map((c) => row(`${c.from}–${c.from + c.runs - 1}`, c)),
    '',
    row('All', result.all),
    row(`Last ${Math.min(3, result.curve.length)} rows`, result.last),
    '',
    `Learned        ${result.stats.examples - result.stats.seedExamples} examples (${result.stats.head} head), distance gate ${result.stats.gate.threshold === null ? 'off' : result.stats.gate.threshold.toFixed(3)}, ${result.stats.gate.gated} gated`,
    `"Accurate" is the accuracy of the device's own answers, against the data's labels.`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
  if (values.out) {
    await mkdir(dirname(resolve(values.out)), { recursive: true });
    await writeFile(values.out, JSON.stringify({ task, inputs: dataset.examples.length, threshold: threshold ?? learn.threshold ?? 0.9, explore, teacherAccuracy, ...result }, null, 2) + '\n');
    log(`Wrote ${values.out}`);
  }
  return 0;
}
