import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCalibration, schemaFingerprint, type LocalRunner } from '@swissspidy/belay-core';
import { nodeBackend, OutputCache, type ReflectRequest } from '@swissspidy/belay-calibrate';
import type { DatasetManifest } from '@swissspidy/belay-trace/node';
import { hash01, LABELS, schema } from '../../calibrate/test/fixtures.js';
import {
  currentState,
  DEFAULT_GATE,
  ledgerCommand,
  loadSplit,
  localConfigFingerprint,
  parseLocalConfig,
  readLedger,
  reflectorAdapter,
  tune,
  tuneCommand,
  writeLock,
  type TuneOptions,
} from '../src/index.js';

const truthOf = (input: string) => LABELS.find((l) => input.includes(`about ${l} `))!;
const next = (label: string) => LABELS[(LABELS.indexOf(label as (typeof LABELS)[number]) + 1) % LABELS.length]!;

/**
 * A local model that reads its context literally:
 * - without help, its confidence is spread over [0.3, 1) and it is right about that often;
 * - a rule or example mentioning "GOOD" makes it surer and nearly always right;
 * - "BAD" makes it wrong about half the time, while staying sure;
 * - "OVERFIT" helps on every input but those marked "holdout";
 * - "MAYBE" makes it sure and right about as often as the whole cascade was before.
 */
function contextLocal(): LocalRunner<any> & { contexts: Set<string> } {
  const contexts = new Set<string>();
  return {
    id: 'context-local',
    contexts,
    availability: async () => 'available',
    async run(input, ctx) {
      const context = ctx.context ?? '';
      contexts.add(context);
      const truth = truthOf(input);
      let confidence = 0.3 + 0.7 * hash01(`conf:${input}`);
      let right = hash01(`right:${input}`) < confidence;
      if (context.includes('MAYBE')) {
        confidence = 0.97;
        right = hash01(`maybe:${input}`) < 0.94;
      } else if (context.includes('BAD')) {
        confidence = 0.9;
        right = hash01(`bad:${input}`) < 0.5;
      } else if (context.includes('GOOD') || (context.includes('OVERFIT') && !input.includes('holdout'))) {
        confidence = 0.97;
        right = hash01(`right:${input}`) < 0.985;
      } else if (context.includes('OVERFIT')) {
        confidence = 0.97;
        right = hash01(`bad:${input}`) < 0.6;
      }
      return { value: right ? truth : next(truth), confidence };
    },
  };
}

const rows = (split: string, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const label = LABELS[i % LABELS.length]!;
    return { id: `${split}-${String(i).padStart(3, '0')}`, input: `${split} ticket #${i} about ${label} (${hash01(split + i).toFixed(4)})`, label, labelKind: 'silver', origin: 'cloud', cloud: label, weight: 1 };
  });

let dir: string;
let evaluator: string;
let manifest: DatasetManifest;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'belay-loop-'));
  evaluator = join(dir, 'evaluator');
  await mkdir(evaluator);
  await writeFile(join(evaluator, 'index.js'), 'export const evaluate = 1;\n');
  const datasets = join(dir, '.belay/datasets/ticket-triage');
  await mkdir(datasets, { recursive: true });
  const assignments: Record<string, 'train' | 'validation' | 'holdout'> = {};
  for (const split of ['train', 'validation', 'holdout'] as const) {
    const examples = rows(split, 200);
    for (const e of examples) assignments[e.id] = split;
    await writeFile(join(datasets, `${split}.jsonl`), examples.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  manifest = { version: 1, task: 'ticket-triage', schemaFingerprint: schemaFingerprint(schema), seed: '1', ratios: { train: 1 / 3, validation: 1 / 3, holdout: 1 / 3 }, nearDuplicateThreshold: 0.8, assignments, holdoutFingerprint: 'sha256:test' };
  await writeFile(join(datasets, 'manifest.json'), JSON.stringify(manifest));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const lock = async () => writeLock(dir, 'ticket-triage', (await currentState(dir, manifest, { evaluatorRoots: [evaluator] })).lock);

/** A reflector that answers each rung from a script and remembers what it was asked. */
function scripted(answers: { examples?: (ids: string[]) => unknown[]; rules?: unknown[][] }) {
  const requests: ReflectRequest[] = [];
  let ruleRound = 0;
  const reflector = reflectorAdapter(async (request, { reportUsage }) => {
    requests.push(request);
    reportUsage({ model: 'big', inputTokens: 10_000, outputTokens: 1_000 });
    const ids = [...request.prompt.matchAll(/^\[([\w-]+)\]/gm)].map((m) => m[1]!);
    if (request.prompt.includes('list of training example ids')) return { candidates: answers.examples?.(ids) ?? [] };
    return JSON.stringify({ candidates: answers.rules?.[ruleRound++] ?? [] });
  }, 'scripted');
  return { reflector, requests };
}

async function options(overrides: Partial<TuneOptions> = {}): Promise<TuneOptions & { local: ReturnType<typeof contextLocal> }> {
  const datasets = join(dir, '.belay/datasets/ticket-triage');
  const local = contextLocal();
  return {
    local,
    name: 'ticket-triage',
    taskConfig: { schema, context: 'Support tickets.' },
    root: dir,
    backend: nodeBackend(local, { task: 'ticket-triage', schema, context: 'Support tickets.' }),
    backendName: 'context-local',
    cache: await OutputCache.open(join(dir, '.belay-cache/outputs.jsonl')),
    train: await loadSplit(join(datasets, 'train.jsonl'), schema),
    validation: await loadSplit(join(datasets, 'validation.jsonl'), schema),
    holdout: () => loadSplit(join(datasets, 'holdout.jsonl'), schema),
    manifest,
    reflector: scripted({}).reflector,
    prices: { big: { input: 10, output: 50 } },
    target: 0.9,
    budget: { reflectorSpend: 5, maxExperiments: 20 },
    run: 'night-1',
    seed: 1,
    evaluatorRoots: [evaluator],
    now: () => new Date('2026-11-10T02:00:00Z'),
    ...overrides,
  };
}

const GOOD_RULES = [[{ hypothesis: 'Naming the pattern settles the unsure tickets.', rules: ['GOOD: a ticket "about X" belongs to X.'] }, { hypothesis: 'A vague rule.', rules: ['BAD: think carefully.'] }]];

describe('tune', () => {
  it('promotes a candidate that passes the gate, and leaves a full record', async () => {
    await lock();
    const { reflector, requests } = scripted({
      examples: (ids) => [
        { hypothesis: 'Examples of what it confuses.', examples: ids.slice(0, 3) },
        { hypothesis: 'Unknown ids are dropped.', examples: ['nope'] },
      ],
      rules: GOOD_RULES,
    });
    const o = await options({ reflector });
    const report = await tune(o);

    expect(report.outcome).toBe('promoted');
    expect(report.best).toMatchObject({ rung: 'rules', targetMet: true });
    expect(report.best.localShare).toBeGreaterThan(report.baseline.localShare + 0.1);
    expect(report.gate!.passed).toBe(true);
    expect(report.gate!.checks.map((c) => c.name)).toEqual(['accuracy', 'local-share', 'recall', 'calibration', 'latency', 'prompt-size']);
    expect(report.gate!.basis).toBe('cloud-agreement');
    expect(report.protected.unchanged).toBe(true);
    expect(report.datasets).toMatchObject({ train: 200, validation: 200, holdout: 200 });

    // Spend: priced from the usage the reflector reported (10k in, 1k out at 10 / 50 per million).
    expect(report.spend.calls).toBe(requests.length);
    expect(report.spend.reflector).toBeCloseTo(requests.length * 0.15);

    // The files a person reviews.
    const config = parseLocalConfig(JSON.parse(await readFile(join(dir, 'belay/ticket-triage/context-local.local.json'), 'utf8')), 'ticket-triage', schema);
    expect(config.rules).toEqual(['GOOD: a ticket "about X" belongs to X.']);
    const calibration = parseCalibration(JSON.parse(await readFile(join(dir, 'belay/ticket-triage/context-local.calibration.json'), 'utf8')), 'ticket-triage');
    expect(calibration.threshold).toBe(report.best.threshold);
    expect((calibration as unknown as { localConfig: string }).localConfig).toBe(localConfigFingerprint(config));
    expect(calibration.expected.localShare).toBeCloseTo(report.best.localShare);
    const markdown = await readFile(join(dir, '.belay/tune/ticket-triage/report.md'), 'utf8');
    expect(markdown).toMatch(/A candidate passed the gate/);
    expect(markdown).toMatch(/Protected files .*: unchanged/);

    // The ledger: chained, one line per experiment, and no holdout number in it.
    const ledger = await readLedger(join(dir, '.belay/ledger.jsonl'));
    expect(ledger.intact).toBe(true);
    expect(ledger.entries).toEqual(report.entries);
    expect(ledger.entries[0]).toMatchObject({ id: 'night-1.000', rung: 'baseline', verdict: 'baseline', previous: null });
    expect(ledger.entries.at(-1)).toMatchObject({ rung: 'gate', verdict: 'promoted', gate: { passed: true, failed: [] } });
    expect(ledger.entries.at(-1)!.scores).toBeUndefined();
    expect(ledger.entries.filter((e) => e.verdict === 'kept').map((e) => e.rung)).toContain('rules');
    expect(ledger.entries.some((e) => e.verdict === 'discarded' && /BAD|vague/i.test(e.hypothesis))).toBe(true);
    expect(report.experiments.run).toBe(ledger.entries.filter((e) => e.rung === 'examples' || e.rung === 'rules').length);

    // The reflecting model saw training inputs only.
    const prompts = requests.map((r) => r.prompt).join('\n');
    expect(prompts).toContain('train ticket');
    expect(prompts).not.toContain('holdout ticket');
    expect(prompts).not.toContain('validation ticket');
  });

  it('reports a plateau and writes no config when nothing beats the baseline', async () => {
    await lock();
    const { reflector } = scripted({ rules: [[{ hypothesis: 'A vague rule.', rules: ['BAD: think carefully.'] }], [{ hypothesis: 'Another vague rule.', rules: ['BAD: be precise.'] }]] });
    const report = await tune(await options({ reflector }));
    expect(report.outcome).toBe('plateau');
    expect(report.stopped).toBe('rungs-exhausted');
    expect(report.gate).toBeUndefined();
    expect(report.datasets.holdout).toBeNull();
    expect(report.experiments).toMatchObject({ run: 2, kept: 0 });
    expect(report.notes.join(' ')).toMatch(/No candidate on rungs 1 to 3/);
    expect(existsSync(join(dir, 'belay'))).toBe(false);
    expect(await readFile(join(dir, '.belay/tune/ticket-triage/report.md'), 'utf8')).toMatch(/Plateau/);
  });

  it('rejects a candidate that does not hold up on the holdout', async () => {
    await lock();
    const { reflector } = scripted({ rules: [[{ hypothesis: 'Fits what it was shown.', rules: ['OVERFIT: answer as in training.'] }]] });
    const report = await tune(await options({ reflector }));
    expect(report.outcome).toBe('rejected');
    expect(report.gate!.passed).toBe(false);
    expect(report.gate!.checks.find((c) => c.name === 'accuracy')!.passed).toBe(false);
    expect(existsSync(join(dir, 'belay'))).toBe(false);
    const ledger = await readLedger(join(dir, '.belay/ledger.jsonl'));
    expect(ledger.entries.at(-1)).toMatchObject({ verdict: 'rejected', gate: { passed: false } });
    expect(ledger.entries.at(-1)!.gate!.failed).toContain('accuracy');
  });

  it('calls a gate the holdout cannot settle inconclusive, and tries the candidate again', async () => {
    await lock();
    const maybe = { rules: [[{ hypothesis: 'About as accurate, far more local.', rules: ['MAYBE: answer directly.'] }]] };
    const logs: string[] = [];
    const first = await tune(await options({ reflector: scripted(maybe).reflector, log: (line) => logs.push(line) }));
    expect(first.outcome).toBe('inconclusive');
    expect(first.gate).toMatchObject({ passed: false, inconclusive: true });
    expect(first.gate!.checks.filter((c) => !c.passed)).toMatchObject([{ name: 'accuracy', inconclusive: true }]);
    expect(first.gate!.holdoutNeeded).toBeGreaterThan(200);
    // Said before the night was spent, and again in the report.
    expect(logs.join('\n')).toMatch(/Warning: The holdout has 200 examples/);
    expect(first.notes.join(' ')).toMatch(/holdout examples would settle it \(there are 200\)/);
    expect(existsSync(join(dir, 'belay'))).toBe(false);
    expect(await readFile(join(dir, '.belay/tune/ticket-triage/report.md'), 'utf8')).toMatch(/\*\*inconclusive\*\*/);
    const pendingFile = join(dir, '.belay/tune/ticket-triage/context-local.pending.json');
    expect(JSON.parse(await readFile(pendingFile, 'utf8'))).toMatchObject({ run: 'night-1', rung: 'rules', config: { rules: ['MAYBE: answer directly.'] } });
    let ledger = await readLedger(join(dir, '.belay/ledger.jsonl'));
    expect(ledger.entries.at(-1)).toMatchObject({ verdict: 'inconclusive', gate: { passed: false, inconclusive: true, failed: ['accuracy'] } });

    // The next night proposes nothing new: the candidate is carried over and gated again.
    const second = await tune(await options({ run: 'night-2' }));
    expect(second.entries[1]).toMatchObject({ rung: 'rules', verdict: 'kept', patch: [{ op: 'add', path: '/rules', value: ['MAYBE: answer directly.'] }] });
    expect(second.entries[1]!.reason).toMatch(/Carried over from night-1/);
    expect(second.outcome).toBe('inconclusive');
    expect(JSON.parse(await readFile(pendingFile, 'utf8'))).toMatchObject({ run: 'night-2', carried: { run: 'night-1' } });

    // Resuming that night replays it from the caches: same entries, nothing written twice.
    const resumed = await tune(await options({ run: 'night-2', resume: true }));
    expect(resumed.entries.map((e) => e.id)).toEqual(second.entries.map((e) => e.id));
    expect(resumed.outcome).toBe('inconclusive');

    // The gate's owner accepts a wider margin and locks again: the same candidate now ships.
    await writeFile(join(dir, 'belay.gate.json'), JSON.stringify({ version: 1, accuracyMargin: 0.1 }));
    await lock();
    const third = await tune(await options({ run: 'night-3' }));
    expect(third.outcome).toBe('promoted');
    expect(existsSync(pendingFile)).toBe(false);
    ledger = await readLedger(join(dir, '.belay/ledger.jsonl'));
    expect(ledger.intact).toBe(true);
  });

  it('stops at the spend cap and at the experiment cap', async () => {
    await lock();
    const many = { examples: (ids: string[]) => [1, 2, 3, 4].map((n) => ({ hypothesis: `Set ${n}.`, examples: ids.slice(n, n + 3) })), rules: [] };
    const capped = await tune(await options({ reflector: scripted(many).reflector, prices: { big: { input: 300, output: 0 } }, budget: { reflectorSpend: 5, maxExperiments: 20 } }));
    expect(capped.stopped).toBe('budget');
    expect(capped.spend).toMatchObject({ calls: 2, reflector: 6 });

    await rm(join(dir, '.belay/ledger.jsonl'));
    const few = await tune(await options({ reflector: scripted(many).reflector, budget: { reflectorSpend: 5, maxExperiments: 3 }, cache: await OutputCache.open(null) }));
    expect(few.stopped).toBe('max-experiments');
    expect(few.experiments.run).toBe(3);
  });

  it('charges a flat price when the reflector reports no usage', async () => {
    await lock();
    const reflector = reflectorAdapter(async () => ({ candidates: [] }));
    const report = await tune(await options({ reflector, costPerCall: 0.5 }));
    // One call per rung: asking the same thing again would get the same answer.
    expect(report.spend).toMatchObject({ calls: 2, reflector: 1 });
    expect(report.notes.join(' ')).toMatch(/no usable candidate/);
  });

  it('resumes a run from the caches without asking the reflector again', async () => {
    await lock();
    const first = scripted({ examples: (ids) => [{ hypothesis: 'Three examples.', examples: ids.slice(0, 3) }], rules: GOOD_RULES });
    const partial = await tune(await options({ reflector: first.reflector, budget: { reflectorSpend: 5, maxExperiments: 1 } }));
    expect(partial.stopped).toBe('max-experiments');
    const before = (await readLedger(join(dir, '.belay/ledger.jsonl'))).entries.length;

    await expect(tune(await options({ reflector: first.reflector }))).rejects.toThrow(/--resume/);

    const second = scripted({ examples: (ids) => [{ hypothesis: 'Three examples.', examples: ids.slice(0, 3) }], rules: GOOD_RULES });
    const full = await tune(await options({ reflector: second.reflector, resume: true }));
    expect(full.outcome).toBe('promoted');
    const ledger = await readLedger(join(dir, '.belay/ledger.jsonl'));
    expect(ledger.intact).toBe(true);
    expect(new Set(ledger.entries.map((e) => e.id)).size).toBe(ledger.entries.length);
    expect(ledger.entries.slice(0, before)).toEqual(partial.entries);
    // The first round's answer came from the cache.
    expect(second.requests.some((r) => r.prompt === first.requests[0]!.prompt)).toBe(false);
  });

  it('fits the threshold again when the committed one is stale (rung 1)', async () => {
    await lock();
    const config = { version: 1, task: 'ticket-triage', backend: { runner: 'context-local' } };
    await mkdir(join(dir, 'belay/ticket-triage'), { recursive: true });
    await writeFile(join(dir, 'belay/ticket-triage/context-local.local.json'), JSON.stringify(config));
    await writeFile(
      join(dir, 'belay/ticket-triage/context-local.calibration.json'),
      JSON.stringify({ version: 1, task: 'ticket-triage', schemaFingerprint: schemaFingerprint(schema), threshold: 0.99, localConfig: localConfigFingerprint(parseLocalConfig(config, 'ticket-triage', schema)) }),
    );
    const report = await tune(await options({ reflector: reflectorAdapter(async () => ({ candidates: [] })) }));
    expect(report.entries[0]).toMatchObject({ rung: 'baseline', scores: { threshold: 0.99 } });
    expect(report.entries[1]).toMatchObject({ rung: 'threshold', verdict: 'kept' });
    expect(report.best.rung).toBe('threshold');
    expect(report.best.localShare).toBeGreaterThan(report.baseline.localShare);
    expect(report.gate).toBeDefined();
    if (report.outcome === 'promoted') {
      const calibration = JSON.parse(await readFile(join(dir, 'belay/ticket-triage/context-local.calibration.json'), 'utf8')) as { threshold: number };
      expect(calibration.threshold).toBeLessThan(0.99);
    }
  });

  it('refuses to run without a lock, or when something protected changed', async () => {
    await expect(tune(await options())).rejects.toThrow(/belay tune --lock/);
    await lock();

    await writeFile(join(dir, 'belay.gate.json'), JSON.stringify({ version: 1, minLocalShareGain: 0 }));
    await expect(tune(await options())).rejects.toThrow(/gate config changed/);
    await rm(join(dir, 'belay.gate.json'));

    await writeFile(join(dir, 'belay.tune.md'), 'Only change rules.');
    await expect(tune(await options())).rejects.toThrow(/instructions changed/);
    await rm(join(dir, 'belay.tune.md'));

    await writeFile(join(evaluator, 'index.js'), 'export const evaluate = 2;\n');
    await expect(tune(await options())).rejects.toThrow(/evaluator code changed/);
    await writeFile(join(evaluator, 'index.js'), 'export const evaluate = 1;\n');

    const shrunk = { ...manifest, assignments: Object.fromEntries(Object.entries(manifest.assignments).filter(([id]) => id !== 'holdout-000')) };
    await expect(tune(await options({ manifest: shrunk }))).rejects.toThrow(/1 inputs of the locked holdout/);
    // A holdout that grew is fine.
    const grown = { ...manifest, assignments: { ...manifest.assignments, 'holdout-new': 'holdout' as const } };
    await expect(tune(await options({ manifest: grown, reflector: reflectorAdapter(async () => ({ candidates: [] })) }))).resolves.toMatchObject({ outcome: 'plateau' });
  });

  it('stops when a protected file changes during the run', async () => {
    await lock();
    const reflector = reflectorAdapter(async (request) => {
      // An attempt to loosen the gate from inside the loop.
      await writeFile(join(dir, 'belay.gate.json'), JSON.stringify({ ...DEFAULT_GATE, accuracyMargin: 1 }));
      return request.prompt.includes('list of training example ids') ? { candidates: [] } : { candidates: GOOD_RULES[0] };
    });
    await expect(tune(await options({ reflector }))).rejects.toThrow(/stopped before the gate: the gate config changed/);
    expect(existsSync(join(dir, 'belay'))).toBe(false);
  });

  it('passes the instructions to the reflecting model', async () => {
    await writeFile(join(dir, 'belay.tune.md'), 'Never mention order numbers in a rule.');
    await lock();
    const { reflector, requests } = scripted({});
    await tune(await options({ reflector }));
    expect(requests[0]!.prompt).toContain('Never mention order numbers in a rule.');
    expect(requests[0]!.system).toMatch(/local share/);
    expect(requests[0]!.jsonSchema).toMatchObject({ required: ['candidates'] });
  });
});

describe('belay tune and belay ledger', () => {
  const CONFIG = `
const LABELS = ['bug', 'billing', 'feature', 'other'];
const truthOf = (input) => LABELS.find((l) => input.includes('about ' + l + ' '));
const sure = (input) => (input.length % 3 ? 0.9 : 0.5);
export default {
  tasks: {
    'ticket-triage': {
      schema: { type: 'categorical', options: LABELS },
      local: { id: 'cli-local', availability: async () => 'available', run: async (input, ctx) => { const good = (ctx.context ?? '').includes('GOOD'); const c = good ? 0.95 : sure(input); return { value: c > 0.6 ? truthOf(input) : 'other', confidence: c }; } },
      tune: {
        target: 0.9,
        costPerCall: 0.1,
        reflector: { id: 'cli-reflector', reflect: async (request) => ({ output: { candidates: request.prompt.includes('complete list of rules') ? [{ hypothesis: 'A rule that helps.', rules: ['GOOD rule'] }] : [] } }) },
      },
    },
  },
};`;

  it('locks, tunes, and prints the history', async () => {
    await writeFile(join(dir, 'belay.config.mjs'), CONFIG);
    const cwd = process.cwd();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const printed = () => stdout.mock.calls.map((c) => String(c[0])).join('');
    try {
      process.chdir(dir);
      await expect(tuneCommand([])).rejects.toThrow(/belay tune --lock/);
      expect(await tuneCommand(['--lock'])).toBe(0);
      expect(printed()).toMatch(/Wrote belay.tune.lock.json/);
      expect(JSON.parse(await readFile(join(dir, 'belay.tune.lock.json'), 'utf8')).tasks['ticket-triage'].holdout.ids).toHaveLength(200);
      await expect(tuneCommand(['--budget', 'lots'])).rejects.toThrow(/--budget/);

      stdout.mockClear();
      expect(await tuneCommand(['--budget', '5usd', '--max-experiments', '10', '--run', 'n1'])).toBe(0);
      expect(printed()).toMatch(/Outcome\s+a candidate passed the gate/);
      expect(printed()).toMatch(/Gate local-share\s+pass/);
      expect(printed()).toMatch(/Protected\s+unchanged/);
      expect(existsSync(join(dir, 'belay/ticket-triage/cli-local.local.json'))).toBe(true);

      stdout.mockClear();
      expect(await ledgerCommand(['--task', 'ticket-triage'])).toBe(0);
      expect(printed()).toMatch(/n1\.000\s+ticket-triage\s+baseline/);
      expect(printed()).toMatch(/A rule that helps\./);
      expect(printed()).toMatch(/1 promoted/);
      stdout.mockClear();
      expect(await ledgerCommand(['--json', '--run', 'n1'])).toBe(0);
      expect(printed().trim().split('\n').map((l) => JSON.parse(l).run)).toContain('n1');

      // An edited ledger is noticed, by the command and by the next run.
      const path = join(dir, '.belay/ledger.jsonl');
      await writeFile(path, (await readFile(path, 'utf8')).replace('"verdict":"discarded"', '"verdict":"kept"').replace('A rule that helps.', 'Edited.'));
      expect(await ledgerCommand([])).toBe(2);
      await expect(tuneCommand(['--run', 'n2'])).rejects.toThrow(/not intact/);
      expect(await ledgerCommand(['--help'])).toBe(0);
    } finally {
      process.chdir(cwd);
    }
  });
});
