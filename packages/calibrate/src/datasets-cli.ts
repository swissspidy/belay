import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { labelTrace, type Trace } from '@swissspidy/belay-trace';
import { buildDatasets, readManifest, readTraces, writeDatasets } from '@swissspidy/belay-trace/node';
import { loadDataset } from './dataset.js';
import { loadConfig } from './load-config.js';

const HELP = `Usage: belay datasets --task <name> --traces <file-or-dir> [options]

Builds the training, validation and holdout splits of a task from recorded traces
(@swissspidy/belay-trace). Writes train.jsonl, validation.jsonl, holdout.jsonl and manifest.json.

The manifest lists which split every input is in (as hashes, no text). With it, a later build
keeps every input in its split, so the holdout only grows. Commit it; keep the split files, which
hold input text, wherever your traces may be kept.

Options:
  --task <name>          Task name from the config file (required unless it has one task)
  --traces <path>        A traces JSONL file, or a directory of them (required unless --gold)
  --gold <file>          Also add labeled examples as gold labels, JSONL: {"input": "...", "label": "..."}
  --config <file>        Config file (default: belay.config.{mjs,js,ts} in the current directory)
  --out <dir>            Output directory (default: .belay/datasets/<task>)
  --seed <seed>          Seed of the split (default: the manifest's, else "belay")
  --near-duplicates <t>  Word 3-gram overlap in [0.5, 1] from which inputs share a split (default: 0.8)
  --quiet                Only print errors
  -h, --help             Show this help
`;

export async function datasetsCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: 'string' },
      traces: { type: 'string' },
      gold: { type: 'string' },
      config: { type: 'string' },
      out: { type: 'string' },
      seed: { type: 'string' },
      'near-duplicates': { type: 'string' },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.traces && !values.gold) throw new Error('--traces (or --gold) is required');
  const { config, path: configPath } = await loadConfig(values.config);
  const names = Object.keys(config.tasks);
  const task = values.task ?? (names.length === 1 ? names[0] : undefined);
  if (!task) throw new Error(`--task is required (config has: ${names.join(', ')})`);
  const taskConfig = config.tasks[task];
  if (!taskConfig) throw new Error(`task "${task}" is not in ${relative(process.cwd(), configPath)} (has: ${names.join(', ')})`);
  const nearDuplicates = values['near-duplicates'] !== undefined ? Number(values['near-duplicates']) : undefined;
  if (nearDuplicates !== undefined && !(nearDuplicates >= 0.5 && nearDuplicates <= 1)) throw new Error('--near-duplicates must be in [0.5, 1]');

  const traces: Trace[] = [];
  let invalid = 0;
  if (values.traces) {
    const read = await readTraces(values.traces);
    traces.push(...read.traces);
    invalid = read.invalid.length;
    for (const line of read.invalid.slice(0, 5)) process.stderr.write(`skipped ${relative(process.cwd(), line.file)}:${line.line}: ${line.error}\n`);
    if (invalid > 5) process.stderr.write(`…and ${invalid - 5} more invalid lines\n`);
  }
  if (values.gold) {
    const gold = await loadDataset(values.gold, taskConfig.schema);
    for (const example of gold.examples) {
      traces.push(labelTrace({ task, schema: taskConfig.schema, input: example.input, value: example.expected as never, id: `dataset:${gold.fingerprint}:${example.id}` }));
    }
  }

  const out = resolve(values.out ?? `.belay/datasets/${task}`);
  const previous = await readManifest(out);
  const datasets = buildDatasets(traces, {
    task,
    schema: taskConfig.schema,
    seed: values.seed ?? previous?.seed ?? 'belay',
    ...(previous ? { previous } : {}),
    ...(nearDuplicates !== undefined ? { nearDuplicateThreshold: nearDuplicates } : {}),
  });
  await writeDatasets(out, datasets);

  if (!values.quiet) {
    const { stats } = datasets;
    const row = (name: 'train' | 'validation' | 'holdout') => {
      const s = stats.splits[name];
      return `${(name[0]!.toUpperCase() + name.slice(1)).padEnd(15)} ${String(s.size).padStart(6)}  (${s.gold} gold, ${s.silver} silver)`;
    };
    const skipped = [
      stats.unlabeled && `${stats.unlabeled} without a label or input`,
      stats.staleSchema && `${stats.staleSchema} of an older schema`,
      stats.invalidLabel && `${stats.invalidLabel} with an invalid label`,
      invalid && `${invalid} unreadable lines`,
    ].filter(Boolean);
    const dropped = [
      stats.droppedAmbiguous && `${stats.droppedAmbiguous} close to inputs of two splits`,
      stats.droppedSynthetic && `${stats.droppedSynthetic} synthetic, close to the holdout`,
    ].filter(Boolean);
    const lines = [
      '',
      `Task            ${task}`,
      `Traces          ${stats.traces}${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`,
      `Labeled inputs  ${stats.inputs}${stats.conflicts ? ` (${stats.conflicts} with conflicting labels)` : ''}${dropped.length ? ` (left out: ${dropped.join(', ')})` : ''}`,
      row('train'),
      row('validation'),
      row('holdout'),
      ...(stats.missing ? [`Missing         ${stats.missing} inputs of earlier builds have no traces any more`] : []),
      ...(stats.splits.holdout.gold < 100 ? [`Note            the holdout has fewer than 100 gold labels: scores on it measure agreement with the cloud`] : []),
      '',
      `Wrote ${relative(process.cwd(), out) || '.'} (${previous ? 'manifest updated' : 'new manifest'}, seed "${datasets.manifest.seed}")`,
    ];
    process.stdout.write(lines.join('\n') + '\n');
  }
  return 0;
}
