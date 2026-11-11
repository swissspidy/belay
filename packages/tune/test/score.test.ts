import { describe, expect, it } from 'vitest';
import { score, type ScoredExample } from '../src/index.js';

const ex = (id: string, confidence: number | null, correct: boolean, extra: Partial<ScoredExample> = {}): ScoredExample => ({
  id,
  weight: 1,
  labelKind: 'silver',
  local: confidence === null ? null : { confidence, correct },
  cloudCorrect: 1,
  ...extra,
});

/** n examples: the local answer is right when its confidence is above `wrongBelow`. */
const ramp = (n: number, wrongBelow: number): ScoredExample[] => Array.from({ length: n }, (_, i) => ex(`e${i}`, (i + 0.5) / n, (i + 0.5) / n >= wrongBelow));

describe('score', () => {
  it('finds the lowest threshold that holds the target', () => {
    // Local is wrong below 0.4. At a target of 95%, 5 of 100 wrong answers may stay local.
    const s = score(ramp(100, 0.4), { target: 0.95 });
    expect(s.targetMet).toBe(true);
    expect(s.threshold).toBeCloseTo(0.355);
    expect(s.localShare).toBeCloseTo(0.65);
    expect(s.accuracy).toBeCloseTo(0.95);
    expect(s.localAccuracy).toBeCloseTo(60 / 65);
    expect(s.cloudOnlyAccuracy).toBe(1);
    expect(s.cloudAgreement).toBeCloseTo(0.95);
    expect(s.goldAccuracy).toBeNull();
    expect(s.catchRate).toBeCloseTo(35 / 40);
    expect(s).toMatchObject({ examples: 100, gold: 0, silver: 100 });
    expect(s.localShareInterval![0]).toBeLessThanOrEqual(s.localShare);
    expect(s.localShareInterval![1]).toBeGreaterThanOrEqual(s.localShare);
    expect(s.localShareInterval![1] - s.localShareInterval![0]).toBeLessThan(0.35);
    expect(s.accuracyInterval![0]).toBeGreaterThan(0.9);
  });

  it('keeps everything local when the local side is always right, and nothing when it never is', () => {
    expect(score(ramp(50, 0), { target: 1 })).toMatchObject({ localShare: 1, threshold: 0.01, accuracy: 1, catchRate: null });
    expect(score(ramp(50, 2), { target: 1 })).toMatchObject({ localShare: 0, threshold: null, targetMet: true, localAccuracy: null, catchRate: 1 });
  });

  it('counts examples without a local answer as escalated', () => {
    const s = score([ex('a', 0.9, true), ex('b', null, false), ex('c', 0.8, true), ex('d', null, false)], { target: 1, resamples: 0 });
    expect(s).toMatchObject({ localShare: 0.5, threshold: 0.8, accuracy: 1, localShareInterval: null, accuracyInterval: null });
  });

  it('never splits equal confidences', () => {
    // Keeping both 0.7s costs too much; a threshold cannot keep only the right one.
    const s = score([ex('a', 0.9, true), ex('b', 0.7, true), ex('c', 0.7, false), ex('d', 0.5, false)], { target: 0.9, resamples: 0 });
    expect(s).toMatchObject({ threshold: 0.9, localShare: 0.25 });
  });

  it('weighs examples: one explored run stands for many confident ones', () => {
    const examples = [ex('explored', 0.95, true, { weight: 20 }), ...Array.from({ length: 20 }, (_, i) => ex(`esc${i}`, 0.3, false))];
    const s = score(examples, { target: 0.99, resamples: 0 });
    expect(s.localShare).toBeCloseTo(0.5);
    expect(score(examples.map((e) => ({ ...e, weight: 1 })), { target: 0.99, resamples: 0 }).localShare).toBeCloseTo(1 / 21);
  });

  it('gains accuracy where the local side is right and the cloud is wrong', () => {
    const examples = [
      ex('a', 0.9, true, { labelKind: 'gold', cloudCorrect: 0 }),
      ex('b', 0.8, true, { labelKind: 'gold', cloudCorrect: 1 }),
      ex('c', 0.2, false, { labelKind: 'gold', cloudCorrect: 1 }),
      ex('d', 0.1, false, { labelKind: 'gold', cloudCorrect: 0.5 }),
    ];
    const s = score(examples, { target: 0.8, resamples: 0 });
    expect(s).toMatchObject({ cloudOnlyAccuracy: 0.625, accuracy: 0.875, goldAccuracy: 0.875, cloudAgreement: null, threshold: 0.8, gold: 4 });
  });

  it('reports the most accurate threshold when the target is out of reach', () => {
    const examples = [ex('a', 0.9, true, { labelKind: 'gold', cloudCorrect: 0 }), ex('b', 0.5, false, { labelKind: 'gold', cloudCorrect: 0 })];
    expect(score(examples, { target: 0.9, resamples: 0 })).toMatchObject({ targetMet: false, threshold: 0.9, accuracy: 0.5, localShare: 0.5 });
  });

  it('gives the same intervals for the same seed, in any example order', () => {
    const examples = ramp(200, 0.3);
    const a = score(examples, { target: 0.97, seed: 'night-1' });
    expect(score(examples, { target: 0.97, seed: 'night-1' })).toEqual(a);
    expect(score(examples, { target: 0.97, seed: 'night-2' }).localShareInterval).not.toEqual(a.localShareInterval);
    expect(score([...examples].reverse(), { target: 0.97, seed: 'night-1' })).toMatchObject({ localShare: a.localShare, threshold: a.threshold });
  });

  it('validates its input', () => {
    expect(() => score([], { target: 0.9 })).toThrow(/no examples/);
    expect(() => score(ramp(3, 0), { target: 1.2 })).toThrow(/target/);
    expect(() => score([ex('a', 0.5, true, { weight: 0 })], { target: 0.9 })).toThrow(/weight/);
  });
});

import { applyConfigPatch, applyLocalConfig, contextSize, createWorkspace, emptyLocalConfig, holdoutPower, localConfigFingerprint, pairedBootstrap, parseGateConfig, parseLocalConfig, parseProposals, runGate, scoreAt, withLocalConfig, DEFAULT_GATE } from '../src/index.js';

describe('scoreAt and pairedBootstrap', () => {
  const examples = [
    ex('a', 0.9, true, { truth: 'x', latencyMs: 10 }),
    ex('b', 0.8, false, { truth: 'x', latencyMs: 20 }),
    ex('c', 0.4, true, { truth: 'y', latencyMs: 30 }),
    ex('d', null, false, { truth: 'y', labelKind: 'gold', cloudCorrect: 0 }),
  ];

  it('scores a fixed threshold, per label, with calibration error and latency', () => {
    const s = scoreAt(examples, 0.5);
    expect(s).toMatchObject({ localShare: 0.5, accuracy: 0.5, localAccuracy: 0.5, recall: { x: 0.5, y: 0.5 }, goldAccuracy: 0, gold: 1, examples: 4 });
    expect(s.cloudAgreement).toBeCloseTo(2 / 3);
    expect(s.latencyP95Ms).toBeCloseTo(29);
    // Bins: 0.9 right (off by 0.1), 0.8 wrong (off by 0.8), 0.4 right (off by 0.6).
    expect(s.calibrationError).toBeCloseTo(1.5 / 3);
    expect(scoreAt(examples, null)).toMatchObject({ localShare: 0, accuracy: 0.75, localAccuracy: null });
  });

  it('compares a candidate with a baseline on the same examples', () => {
    const better = examples.map((e) => (e.id === 'b' ? { ...e, local: { confidence: 0.8, correct: true } } : e));
    const same = pairedBootstrap({ examples, threshold: 0.5 }, { examples, threshold: 0.5 });
    expect(same).toMatchObject({ accuracy: 0, localShare: 0, accuracyInterval: [0, 0] });
    const d = pairedBootstrap({ examples, threshold: 0.5 }, { examples: better, threshold: 0.3 }, { seed: 1 });
    expect(d.accuracy).toBeCloseTo(0.25);
    expect(d.localShare).toBeCloseTo(0.25);
    expect(d.accuracyInterval[0]).toBeGreaterThanOrEqual(0);
    expect(() => pairedBootstrap({ examples, threshold: 0.5 }, { examples: examples.slice(1), threshold: 0.5 })).toThrow(/same examples/);
  });
});

describe('runGate', () => {
  const side = (correct: (i: number) => boolean, confidence = 0.9) => Array.from({ length: 200 }, (_, i) => ex(`e${i}`, confidence, correct(i), { truth: i % 2 ? 'x' : 'y', latencyMs: 100 }));
  const baseline = { examples: side(() => true, 0.4), threshold: 0.5, contextChars: 100 };

  it('passes a candidate that keeps more local at the same accuracy', () => {
    const result = runGate(baseline, { examples: side(() => true), threshold: 0.5, contextChars: 150 }, DEFAULT_GATE);
    expect(result.passed).toBe(true);
    expect(result.basis).toBe('cloud-agreement');
    expect(result.difference.localShare).toBe(1);
  });

  it('fails each check for its own reason', () => {
    const failed = (candidate: Parameters<typeof runGate>[1], gate = DEFAULT_GATE) => runGate(baseline, candidate, gate).checks.filter((c) => !c.passed).map((c) => c.name);
    expect(failed({ examples: side((i) => i % 10 !== 0), threshold: 0.5, contextChars: 150 })).toEqual(['accuracy', 'recall']);
    expect(failed({ examples: side(() => true, 0.4), threshold: 0.5, contextChars: 150 })).toEqual(['local-share']);
    expect(failed({ examples: side(() => true, 0.4), threshold: 0.5, contextChars: 50 })).toEqual([]);
    expect(failed({ examples: side(() => true), threshold: 0.5, contextChars: 5000 })).toEqual(['prompt-size']);
    expect(failed({ examples: side(() => true).map((e) => ({ ...e, latencyMs: 200 })), threshold: 0.5, contextChars: 150 })).toEqual(['latency']);
    // Only the "x" label gets worse.
    expect(failed({ examples: side((i) => !(i % 2 && i % 8 === 1)), threshold: 0.5, contextChars: 150 }, { ...DEFAULT_GATE, accuracyMargin: 1, calibrationErrorMargin: 1 })).toEqual(['recall']);
  });

  it('tells a holdout that is too small from a candidate that is worse', () => {
    const candidate = (wrongEvery: number) => ({ examples: side((i) => i % wrongEvery !== 0), threshold: 0.5, contextChars: 150 });
    const gate = { ...DEFAULT_GATE, maxRecallDrop: 1, calibrationErrorMargin: 1 };
    // 1% worse on 200 examples: the interval reaches below the margin, and above it.
    const unsure = runGate(baseline, candidate(100), gate);
    expect(unsure).toMatchObject({ passed: false, inconclusive: true });
    expect(unsure.checks[0]).toMatchObject({ name: 'accuracy', passed: false, inconclusive: true });
    expect(unsure.holdoutNeeded).toBeGreaterThan(200);
    // 10% worse: the whole interval is below the margin.
    const worse = runGate(baseline, candidate(10), gate);
    expect(worse).toMatchObject({ passed: false, inconclusive: false });
    expect(worse.checks[0]!.inconclusive).toBeUndefined();
    expect(worse.holdoutNeeded).toBeUndefined();
    // Unsure about accuracy and failing something else is a plain failure.
    expect(runGate(baseline, { ...candidate(100), contextChars: 5000 }, gate)).toMatchObject({ passed: false, inconclusive: false });
  });

  it('estimates whether a holdout can settle the accuracy check', () => {
    expect(holdoutPower(300, 0.952, DEFAULT_GATE)).toEqual({ enough: false, needed: 950 });
    expect(holdoutPower(1000, 0.952, DEFAULT_GATE)).toEqual({ enough: true, needed: 950 });
    expect(holdoutPower(300, 0.952, { accuracyMargin: 0.03 })).toMatchObject({ enough: true });
    expect(holdoutPower(300, 1, DEFAULT_GATE)).toEqual({ enough: true, needed: 0 });
    expect(holdoutPower(300, 0.9, { accuracyMargin: 0 })).toEqual({ enough: false, needed: null });
  });

  it('reads a gate config and rejects unknown fields', () => {
    expect(parseGateConfig({ version: 1, minLocalShareGain: 0.05 })).toEqual({ ...DEFAULT_GATE, minLocalShareGain: 0.05 });
    expect(() => parseGateConfig({ version: 1, accuracyMargn: 0.5 })).toThrow(/unknown field/);
    expect(() => parseGateConfig({ version: 1, accuracyMargin: -1 })).toThrow(/at least 0/);
    expect(() => parseGateConfig({ version: 2 })).toThrow(/version/);
  });
});

describe('local config', () => {
  const schema = { type: 'categorical', prompt: 'Which team?', options: ['bug', { label: 'billing', description: 'Invoices' }] } as const;
  const base = emptyLocalConfig('t', { runner: 'classifier-api' });

  it('renders rules and examples into the context and rewords for the local model only', () => {
    const config = parseLocalConfig({ ...base, context: 'Tickets.', rules: [' A refund is billing. '], examples: [{ input: 'charged   twice', label: 'billing' }], wording: { prompt: 'Who handles it?', options: { bug: 'Crashes' } } }, 't', schema);
    const applied = applyLocalConfig(schema, 'Original context.', config);
    expect(applied.context).toBe('Tickets.\n\nRules:\n- A refund is billing.\n\nExamples:\n"charged twice" -> billing');
    expect(applied.schema).toEqual({ type: 'categorical', prompt: 'Who handles it?', options: [{ label: 'bug', description: 'Crashes' }, { label: 'billing', description: 'Invoices' }] });
    expect(schema.prompt).toBe('Which team?');
    expect(applyLocalConfig(schema, 'Original context.', base)).toEqual({ schema, context: 'Original context.' });
    expect(applyLocalConfig(schema, undefined, base)).toEqual({ schema });
    expect(contextSize(schema, 'Original context.', config)).toBeGreaterThan(contextSize(schema, 'Original context.', base));
    expect(localConfigFingerprint(config)).not.toBe(localConfigFingerprint(base));
    expect(localConfigFingerprint({ ...base, rules: [] })).toBe(localConfigFingerprint(base));
  });

  it('rejects configs that rename labels or belong elsewhere', () => {
    expect(() => parseLocalConfig({ ...base, wording: { options: { refunds: 'x' } } }, 't', schema)).toThrow(/not an option/);
    expect(() => parseLocalConfig({ ...base, examples: [{ input: 'x', label: 'nope' }] }, 't', schema)).toThrow(/example 1/);
    expect(() => parseLocalConfig({ ...base, threshold: 0.5 }, 't', schema)).toThrow(/unknown field "threshold"/);
    expect(() => parseLocalConfig(base, 'other', schema)).toThrow(/not "other"/);
    expect(() => parseLocalConfig({ ...base, rules: [''] }, 't', schema)).toThrow(/rules/);
  });

  it('patches only what a rung may change', () => {
    const withRules = applyConfigPatch(base, [{ op: 'add', path: '/rules', value: ['One.'] }, { op: 'add', path: '/rules/-', value: 'Two.' }], schema, ['rules']);
    expect(withRules.rules).toEqual(['One.', 'Two.']);
    expect(base.rules).toBeUndefined();
    expect(applyConfigPatch(withRules, [{ op: 'replace', path: '/rules/0', value: 'First.' }, { op: 'remove', path: '/rules/1' }], schema).rules).toEqual(['First.']);
    expect(() => applyConfigPatch(base, [{ op: 'add', path: '/examples', value: [] }], schema, ['rules'])).toThrow(/may not change/);
    expect(() => applyConfigPatch(base, [{ op: 'replace', path: '/task', value: 'other' }], schema)).toThrow(/may not change/);
    expect(() => applyConfigPatch(base, [{ op: 'add', path: '/rules', value: [3] }], schema)).toThrow(/rules/);
    expect(() => applyConfigPatch(withRules, [{ op: 'remove', path: '/rules/7' }], schema)).toThrow(/out of range/);
  });

  it('wraps a runner so that it sees the config, and the task does not', async () => {
    const seen: unknown[] = [];
    const runner = { id: 'r', availability: async () => 'available' as const, run: async (_input: string, ctx: unknown) => (seen.push(ctx), { value: 'bug', confidence: 1 }) };
    const wrapped = withLocalConfig(runner, { ...base, rules: ['A refund is billing.'] });
    await wrapped.run('x', { task: 't', schema, context: 'Tickets.' });
    expect(seen[0]).toMatchObject({ task: 't', context: 'Tickets.\n\nRules:\n- A refund is billing.' });
    expect(wrapped.id).toBe('r');
  });
});

describe('parseProposals', () => {
  const train = new Map([['t1', { input: 'one', label: 'bug' }], ['t2', { input: 'two', label: 'billing' }]]);

  it('turns valid candidates into patches and names the rest', () => {
    const { proposals, rejected } = parseProposals(
      '```json\n' + JSON.stringify({ candidates: [{ hypothesis: ' Two  examples. ', examples: ['[t2]', 't1', 't2'] }, { hypothesis: 'Unknown.', examples: ['t9'] }, { examples: ['t1'] }, { hypothesis: 'Empty.', examples: [] }] }) + '\n```',
      'examples',
      train,
      4,
    );
    expect(proposals).toEqual([{ rung: 'examples', hypothesis: 'Two examples.', patch: [{ op: 'add', path: '/examples', value: [{ input: 'two', label: 'billing' }, { input: 'one', label: 'bug' }] }] }]);
    expect(rejected).toEqual(['candidate 2: unknown training ids t9', 'candidate 3 has no hypothesis', 'candidate 4: no examples']);
  });

  it('takes rules, caps the count, and survives nonsense', () => {
    const many = { candidates: [1, 2, 3].map((n) => ({ hypothesis: `H${n}`, rules: [`Rule ${n}.`, `Rule ${n}.`, ''] })) };
    const { proposals } = parseProposals(many, 'rules', train, 2);
    expect(proposals.map((p) => p.patch[0]!.value)).toEqual([['Rule 1.'], ['Rule 2.']]);
    expect(parseProposals('not json', 'rules', train, 2).rejected).toEqual(['the answer is not JSON']);
    expect(parseProposals({ nope: 1 }, 'rules', train, 2).rejected).toEqual(['the answer has no "candidates" array']);
    expect(parseProposals(null, 'rules', train, 2).proposals).toEqual([]);
  });
});

describe('createWorkspace', () => {
  it('refuses to write outside its outputs', async () => {
    const workspace = createWorkspace('/tmp/belay-workspace-test', ['belay/t', '.belay/ledger.jsonl']);
    expect(workspace.allows('belay/t/x.local.json')).toBe(true);
    expect(workspace.allows('.belay/ledger.jsonl')).toBe(true);
    for (const path of ['belay.gate.json', 'belay.tune.lock.json', '.belay/datasets/t/holdout.jsonl', 'belay/t/../../belay.gate.json', '/etc/passwd', 'belay/tx/file', 'node_modules/@swissspidy/belay-tune/dist/gate.js']) {
      expect(workspace.allows(path)).toBe(false);
      await expect(workspace.write(path, 'x')).rejects.toThrow(/may not write/);
    }
  });
});
