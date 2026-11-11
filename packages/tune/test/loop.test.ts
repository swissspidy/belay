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
  verify,
  verifyCommand,
  parseGateRecord,
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
function contextLocal(): LocalRunner<any> & { contexts: Set<string>; updated: boolean } {
  const contexts = new Set<string>();
  return {
    id: 'context-local',
    contexts,
    /** A browser update: the model stays as sure, and is wrong far more often. */
    updated: false,
    availability: async () => 'available',
    async run(input, ctx) {
      // What the model is given: the context, the question and the option descriptions.
      const options = ctx.schema.type === 'categorical' ? ctx.schema.options.map((o: unknown) => (typeof o === 'string' ? o : `${(o as { label: string }).label}: ${(o as { description?: string }).description ?? ''}`)).join('; ') : '';
      const context = [ctx.context ?? '', (ctx.schema as { prompt?: string }).prompt ?? '', options].join(' | ');
      contexts.add(ctx.context ?? '');
      const truth = truthOf(input);
      let confidence = 0.3 + 0.7 * hash01(`conf:${input}`);
      let right = hash01(`right:${input}`) < confidence;
      if (this.updated) {
        confidence = 0.97;
        right = hash01(`updated:${input}`) < 0.75;
      } else if (context.includes('MAYBE')) {
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
function scripted(answers: { examples?: (ids: string[]) => unknown[]; rules?: unknown[][]; wording?: unknown[][] }) {
  const requests: ReflectRequest[] = [];
  let ruleRound = 0;
  let wordingRound = 0;
  const reflector = reflectorAdapter(async (request, { reportUsage }) => {
    requests.push(request);
    reportUsage({ model: 'big', inputTokens: 10_000, outputTokens: 1_000 });
    const ids = [...request.prompt.matchAll(/^\[([\w-]+)\]/gm)].map((m) => m[1]!);
    if (request.prompt.includes('list of training example ids')) return { candidates: answers.examples?.(ids) ?? [] };
    if (request.prompt.includes('rewords what the small model is asked')) return { candidates: answers.wording?.[wordingRound++] ?? [] };
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
    const markdown = await readFile(join(dir, '.belay/tune/ticket-triage/context-local.report.md'), 'utf8');
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
    expect(report.notes.join(' ')).toMatch(/No candidate on rungs 1 to 4/);
    expect(existsSync(join(dir, 'belay'))).toBe(false);
    expect(await readFile(join(dir, '.belay/tune/ticket-triage/context-local.report.md'), 'utf8')).toMatch(/Plateau/);
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
    expect(await readFile(join(dir, '.belay/tune/ticket-triage/context-local.report.md'), 'utf8')).toMatch(/\*\*inconclusive\*\*/);
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

  it('writes the pull request and the gate record, and verify passes until the model changes', async () => {
    await lock();
    const o = await options({ reflector: scripted({ rules: GOOD_RULES }).reflector });
    const report = await tune(o);
    expect(report.outcome).toBe('promoted');
    expect(report.files).toMatchObject({ record: 'belay/ticket-triage/context-local.gate.json', pullRequest: '.belay/tune/ticket-triage/context-local.pull-request.md' });

    const title = await readFile(join(dir, '.belay/tune/ticket-triage/context-local.pull-request-title.txt'), 'utf8');
    expect(title).toMatch(/^Belay Tune: ticket-triage keeps \d+\.\d points more local at 90% accuracy\n$/);
    const body = await readFile(join(dir, '.belay/tune/ticket-triage/context-local.pull-request.md'), 'utf8');
    expect(body).toMatch(/\*\*Change\*\* \(rules\): Naming the pattern/);
    expect(body).toMatch(/\| After, holdout \|/);
    expect(body).toMatch(/\| accuracy \| pass \|/);
    expect(body).toMatch(/belay verify --task ticket-triage/);
    expect(body).not.toMatch(/BAD|vague/i); // discarded experiments stay in the ledger

    const record = parseGateRecord(JSON.parse(await readFile(join(dir, 'belay/ticket-triage/context-local.gate.json'), 'utf8')), 'ticket-triage');
    expect(Object.keys(record.outcomes)).toHaveLength(200);
    expect(record.threshold).toBe(report.best.threshold);
    expect(JSON.stringify(record)).not.toMatch(/ticket #/); // no input text

    const check = (local = o.local) =>
      verify({
        name: 'ticket-triage',
        taskConfig: o.taskConfig,
        root: dir,
        backend: async () => nodeBackend(local, { task: 'ticket-triage', schema, context: 'Support tickets.' }),
        backendName: 'context-local',
        holdout: o.holdout,
        manifest,
        evaluatorRoots: [evaluator],
      });

    // The same model: every input is answered as at the gate.
    const same = await check();
    expect(same).toMatchObject({ passed: true, tuned: true, added: 0 });
    expect(same.checks.map((c) => c.name)).toEqual(['lock', 'ledger', 'files', 'prompt-size', 'accuracy', 'local-share', 'recall', 'calibration', 'latency']);
    expect(same.current!.accuracy).toBe(same.recorded!.accuracy);
    expect(same.notes).toEqual([]);

    // A browser update makes the model worse without making it less sure.
    const updated = contextLocal();
    updated.updated = true;
    const drifted = await check(updated);
    expect(drifted.passed).toBe(false);
    expect(drifted.checks.filter((c) => !c.passed).map((c) => c.name)).toContain('accuracy');
    expect(drifted.notes.join(' ')).toMatch(/answered differently than at the gate/);
    expect(drifted.notes.join(' ')).toMatch(/Run "belay tune --task ticket-triage"/);

    // A config edited by hand has not passed the gate: the model is not even run.
    const configPath = join(dir, 'belay/ticket-triage/context-local.local.json');
    const original = await readFile(configPath, 'utf8');
    await writeFile(configPath, original.replace('GOOD:', 'GOOD, and more:'));
    const edited = await check();
    expect(edited.passed).toBe(false);
    expect(edited.checks.at(-1)).toMatchObject({ name: 'files', passed: false });
    expect(edited.checks.at(-1)!.detail).toMatch(/fitted for another config/);
    await writeFile(configPath, original);

    // A changed gate config no longer matches the lock.
    await writeFile(join(dir, 'belay.gate.json'), JSON.stringify({ version: 1, accuracyMargin: 0.5 }));
    const unlocked = await check();
    expect(unlocked.checks[0]).toMatchObject({ name: 'lock', passed: false });
    expect(unlocked.passed).toBe(false);
  });

  it('verifies only the lock for a task without a tuned config', async () => {
    await lock();
    const o = await options();
    let opened = false;
    const report = await verify({ name: 'ticket-triage', taskConfig: o.taskConfig, root: dir, backend: async () => ((opened = true), o.backend), backendName: 'context-local', holdout: o.holdout, manifest, evaluatorRoots: [evaluator] });
    expect(report).toMatchObject({ passed: true, tuned: false });
    expect(report.checks.map((c) => c.name)).toEqual(['lock', 'ledger']);
    expect(opened).toBe(false);
  });

  it('repairs a config that a browser update broke, without asking for a gain', async () => {
    await lock();
    const first = await options({ reflector: scripted({ rules: GOOD_RULES }).reflector });
    expect((await tune(first)).outcome).toBe('promoted');

    // The next night the model is worse and as sure: the committed threshold lets mistakes through.
    const local = contextLocal();
    local.updated = true;
    const second = await tune(await options({ run: 'night-2', backend: nodeBackend(local, { task: 'ticket-triage', schema, context: 'Support tickets.' }), cache: await OutputCache.open(null) }));
    expect(second.baseline.targetMet).toBe(false);
    expect(second.repair).toBe(true);
    expect(second.entries[1]).toMatchObject({ rung: 'threshold', verdict: 'kept' });
    expect(second.entries[1]!.reason).toMatch(/no longer holds the target/);
    expect(second.outcome).toBe('promoted');
    expect(second.best.targetMet).toBe(true);
    expect(second.best.localShare).toBeLessThan(second.baseline.localShare);
    expect(second.gate!.checks.find((c) => c.name === 'local-share')).toMatchObject({ passed: true, skipped: true });
    expect(second.notes[0]).toMatch(/no longer held the target accuracy/);
    expect(await readFile(join(dir, '.belay/tune/ticket-triage/context-local.pull-request-title.txt'), 'utf8')).toBe('Belay Tune: restore 90% accuracy for ticket-triage\n');

    // And the repaired config verifies in the updated browser.
    const o = await options();
    const verified = await verify({ name: 'ticket-triage', taskConfig: o.taskConfig, root: dir, backend: async () => nodeBackend(local, { task: 'ticket-triage', schema, context: 'Support tickets.' }), backendName: 'context-local', holdout: o.holdout, manifest, evaluatorRoots: [evaluator] });
    expect(verified.passed).toBe(true);
  });

  it('climbs to the wording rung when examples and rules have stopped helping', async () => {
    await lock();
    const { reflector, requests } = scripted({
      wording: [
        [
          { hypothesis: 'Describing the labels by what tickets say settles the unsure ones.', prompt: 'Which team handles this ticket?', options: [{ label: 'bug', description: 'GOOD: something is broken.' }] },
          { hypothesis: 'A label the task does not have.', prompt: '', options: [{ label: 'refund', description: 'Money back.' }] },
          { hypothesis: 'Nothing at all.', prompt: '', options: [] },
        ],
      ],
    });
    const report = await tune(await options({ reflector }));
    expect(report.outcome).toBe('promoted');
    expect(report.best.rung).toBe('wording');
    const asked = requests.at(-1)!;
    expect(asked.prompt).toMatch(/rewords what the small model is asked/);
    expect(JSON.stringify(asked.jsonSchema)).toMatch(/"prompt"/);
    const config = parseLocalConfig(JSON.parse(await readFile(join(dir, 'belay/ticket-triage/context-local.local.json'), 'utf8')), 'ticket-triage', schema);
    expect(config.wording).toEqual({ prompt: 'Which team handles this ticket?', options: { bug: 'GOOD: something is broken.' } });
    // The task's own labels are untouched: only their description for the local model changed.
    expect(report.entries.filter((e) => e.rung === 'wording')).toHaveLength(1);
  });

  it('keeps a separate config, ledger history and reports per backend', async () => {
    await lock();
    const first = await tune(await options({ reflector: scripted({ rules: GOOD_RULES }).reflector }));
    expect(first.outcome).toBe('promoted');

    // A second backend of the same task: another model, which this rule does not help.
    const other: LocalRunner<any> = { id: 'other-local', availability: async () => 'available', run: async (input) => ({ value: truthOf(input), confidence: 0.3 + 0.7 * hash01(`other:${input}`) }) };
    const second = scripted({ rules: [[{ hypothesis: 'A rule for the other model.', rules: ['Tickets "about X" belong to X.'] }]] });
    const o = await options({ reflector: second.reflector, backend: nodeBackend(other, { task: 'ticket-triage', schema, context: 'Support tickets.' }), backendName: 'other-local' });
    const report = await tune(o);
    // It starts from nothing: the first backend's config is not its baseline, and its history is not shown.
    expect(report.backend).toBe('other-local');
    expect(report.baseline.contextChars).toBeLessThan(first.best.contextChars!);
    expect(second.requests[0]!.prompt).not.toMatch(/GOOD/);
    expect(report.entries[0]!.id).toBe('night-1.000'); // the same run id as the first backend's, without a clash
    expect(existsSync(join(dir, '.belay/tune/ticket-triage/other-local.report.md'))).toBe(true);
    expect(await readFile(join(dir, '.belay/tune/ticket-triage/context-local.report.md'), 'utf8')).toMatch(/A candidate passed the gate/);
    expect(existsSync(join(dir, 'belay/ticket-triage/context-local.local.json'))).toBe(true);
    const ledger = await readLedger(join(dir, '.belay/ledger.jsonl'));
    expect(ledger.intact).toBe(true);
    expect(new Set(ledger.entries.map((e) => e.backend))).toEqual(new Set(['context-local', 'other-local']));

    // A config is not portable: handing one backend's file to the other is refused.
    await mkdir(join(dir, 'belay/ticket-triage'), { recursive: true });
    await writeFile(join(dir, 'belay/ticket-triage/third.local.json'), await readFile(join(dir, 'belay/ticket-triage/context-local.local.json'), 'utf8'));
    await expect(tune(await options({ run: 'night-2', backendName: 'third' }))).rejects.toThrow(/is for backend "context-local", not "third"/);
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
    expect(report.spend).toMatchObject({ calls: 3, reflector: 1.5 });
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
        backends: { second: { model: 'another model', local: { id: 'cli-second', availability: async () => 'available', run: async (input, ctx) => { const good = (ctx.context ?? '').includes('GOOD'); const c = good ? 0.93 : (input.length % 2 ? 0.9 : 0.5); return { value: c > 0.6 ? truthOf(input) : 'other', confidence: c }; } } } },
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
      expect(printed()).toMatch(/n1\.000\s+ticket-triage\s+cli-local\s+baseline/);
      expect(printed()).toMatch(/A rule that helps\./);
      expect(printed()).toMatch(/1 promoted/);
      stdout.mockClear();
      expect(await ledgerCommand(['--json', '--run', 'n1'])).toBe(0);
      expect(printed().trim().split('\n').map((l) => JSON.parse(l).run)).toContain('n1');

      // A second backend of the same task gets its own config, tuned with its own runner.
      stdout.mockClear();
      expect(await tuneCommand(['--backend', 'second', '--max-experiments', '10', '--run', 'n1'])).toBe(0);
      expect(JSON.parse(await readFile(join(dir, 'belay/ticket-triage/second.local.json'), 'utf8')).backend).toEqual({ runner: 'second', model: 'another model' });
      expect(JSON.parse(await readFile(join(dir, 'belay/ticket-triage/cli-local.local.json'), 'utf8')).backend).toEqual({ runner: 'cli-local' });

      // CI: both committed configs still do what they did at the gate.
      stdout.mockClear();
      expect(await verifyCommand([])).toBe(0);
      expect(printed()).toMatch(/Backend\s+cli-local[\s\S]*Backend\s+second/);
      expect(existsSync(join(dir, '.belay/tune/ticket-triage/second.verify.md'))).toBe(true);
      expect(printed()).toMatch(/Result\s+the tuned config still holds/);
      expect(printed()).toMatch(/Check accuracy\s+pass/);
      expect(await readFile(join(dir, '.belay/tune/ticket-triage/cli-local.verify.md'), 'utf8')).toMatch(/The tuned config still holds/);
      expect(await verifyCommand(['--help'])).toBe(0);

      // An edited ledger is noticed, by the command and by the next run.
      const path = join(dir, '.belay/ledger.jsonl');
      await writeFile(path, (await readFile(path, 'utf8')).replace('"verdict":"discarded"', '"verdict":"kept"').replace('A rule that helps.', 'Edited.'));
      expect(await ledgerCommand([])).toBe(2);
      await expect(tuneCommand(['--run', 'n2'])).rejects.toThrow(/not intact/);
      expect(await verifyCommand(['--quiet'])).toBe(1);
      expect(await ledgerCommand(['--help'])).toBe(0);
    } finally {
      process.chdir(cwd);
    }
  });
});
