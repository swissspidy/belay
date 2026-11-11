/**
 * `belay verify`: does the committed config still do, in today's browser, what it did when it
 * passed the gate? A browser update can change the local model without notice. See ADR 0007 §10.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCalibration, schemaFingerprint, type CalibrationFile } from '@swissspidy/belay-core';
import { evaluateLocal, OutputCache, type CalibrationTaskConfig, type LocalBackend } from '@swissspidy/belay-calibrate';
import type { DatasetManifest } from '@swissspidy/belay-trace/node';
import { cloudSide, toScored } from './dry-run.js';
import type { GateConfig } from './gate.js';
import { readLedger } from './ledger.js';
import { applyLocalConfig, contextSize, localConfigFingerprint, parseLocalConfig, type LocalConfig } from './local-config.js';
import { currentState, readLock, verifyLock, LOCK_FILE } from './protect.js';
import { pairedBootstrap, scoreAt, type FixedScore, type ScoredExample } from './score.js';
import type { SplitFile } from './split.js';

export const GATE_RECORD_VERSION = 1;

/** How a calibration file says "keep nothing local": no confidence reaches it. */
export const NO_LOCAL_THRESHOLD = 1.01;

/**
 * What a promoted config did on the holdout when it passed the gate: the reference `belay verify`
 * compares today's browser with. Written next to the config and committed with it. It holds no
 * input text, and the loop never reads it.
 */
export interface GateRecord {
  version: typeof GATE_RECORD_VERSION;
  task: string;
  backend: string;
  /** Fingerprint of the local config this record is for. */
  config: string;
  threshold: number | null;
  target: number;
  run: string;
  createdAt: string;
  environment: { runner: string; model?: string; userAgent?: string };
  scores: Pick<FixedScore, 'localShare' | 'accuracy' | 'calibrationError' | 'latencyP95Ms' | 'examples'>;
  /** Per holdout input: the local confidence (`null`: no valid local answer) and whether the local answer was right. */
  outcomes: Record<string, [confidence: number | null, correct: 0 | 1]>;
}

export function gateRecordOf(options: { task: string; backend: string; config: LocalConfig; threshold: number | null; target: number; run: string; createdAt: string; environment: GateRecord['environment']; examples: readonly ScoredExample[] }): GateRecord {
  const at = scoreAt(options.examples, options.threshold);
  return {
    version: GATE_RECORD_VERSION,
    task: options.task,
    backend: options.backend,
    config: localConfigFingerprint(options.config),
    threshold: options.threshold,
    target: options.target,
    run: options.run,
    createdAt: options.createdAt,
    environment: options.environment,
    scores: { localShare: at.localShare, accuracy: at.accuracy, calibrationError: at.calibrationError, latencyP95Ms: at.latencyP95Ms, examples: at.examples },
    outcomes: Object.fromEntries(options.examples.map((e) => [e.id, [e.local ? e.local.confidence : null, e.local?.correct ? 1 : 0]])),
  };
}

export function parseGateRecord(value: unknown, task: string): GateRecord {
  const v = value as Partial<GateRecord> | null;
  if (!v || typeof v !== 'object') throw new Error('gate record is not an object');
  if (v.version !== GATE_RECORD_VERSION) throw new Error(`unsupported gate record version ${JSON.stringify(v.version)}`);
  if (v.task !== task) throw new Error(`gate record is for task ${JSON.stringify(v.task)}, not "${task}"`);
  if (typeof v.config !== 'string' || !v.outcomes || typeof v.outcomes !== 'object' || !v.scores || !v.environment) throw new Error('gate record is incomplete');
  return v as GateRecord;
}

export interface VerifyCheck {
  name: 'lock' | 'ledger' | 'files' | 'prompt-size' | 'accuracy' | 'local-share' | 'recall' | 'calibration' | 'latency';
  passed: boolean;
  /** Could not be made, or is for information only: never fails the command. */
  skipped?: boolean;
  detail: string;
}

export interface VerifyReport {
  version: 1;
  task: string;
  backend: string;
  createdAt: string;
  passed: boolean;
  /** `false` when the task has no tuned config: only the lock and the ledger were checked. */
  tuned: boolean;
  checks: VerifyCheck[];
  /** The browser then and now, when the model ran. */
  environment?: { recorded: GateRecord['environment']; current: GateRecord['environment']; changed: boolean };
  /** On the holdout inputs of the record, at the committed threshold. */
  recorded?: FixedScore;
  current?: FixedScore;
  /** Holdout inputs added since the record was written: not compared. */
  added?: number;
  /** What to do about a failure. */
  notes: string[];
}

export interface VerifyOptions {
  name: string;
  taskConfig: CalibrationTaskConfig<any>;
  root: string;
  /** Opened only when there is a tuned config to run. */
  backend: () => Promise<LocalBackend>;
  backendName: string;
  holdout: () => Promise<SplitFile>;
  manifest: DatasetManifest;
  cloudAccuracy?: number;
  seed?: string | number;
  evaluatorRoots?: readonly string[];
  now?: () => Date;
  log?: (message: string) => void;
  onProgress?: (event: { done: number; total: number }) => void;
}

const pct = (v: number, d = 1): string => `${(v * 100).toFixed(d)}%`;
const points = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} points`;

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
};

/**
 * Checks the protected files, then runs the committed config on the holdout in the current
 * browser, without the output cache, and compares it input by input with the gate record.
 * It fails on a measured drop beyond the gate's margins, not on an uncertain one: the same
 * browser gives the same outputs, so a difference means the model or the runner changed.
 */
export async function verify(options: VerifyOptions): Promise<VerifyReport> {
  const { name, taskConfig, root } = options;
  const { schema } = taskConfig;
  const log = options.log ?? (() => {});
  const checks: VerifyCheck[] = [];
  const notes: string[] = [];
  const done = (extra: Partial<VerifyReport> = {}): VerifyReport => ({
    version: 1,
    task: name,
    backend: options.backendName,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    passed: checks.every((c) => c.passed),
    tuned: false,
    checks,
    notes,
    ...extra,
  });

  // ---- The protected files ----------------------------------------------------------
  const state = await currentState(root, options.manifest, options.evaluatorRoots ? { evaluatorRoots: options.evaluatorRoots } : {});
  const locked = (await readLock(root))?.tasks[name];
  const problems = locked ? verifyLock(locked, state.lock) : [`no lock for task "${name}" in ${LOCK_FILE}`];
  checks.push({ name: 'lock', passed: problems.length === 0, detail: problems.length ? problems.join('; ') : 'gate config, instructions, evaluator and holdout match the lock' });
  if (problems.length) notes.push(`If the change is intended, run "belay tune --lock --task ${name}" and commit ${LOCK_FILE}.`);

  const ledger = await readLedger(join(root, '.belay/ledger.jsonl'));
  checks.push(
    ledger.entries.length
      ? { name: 'ledger', passed: ledger.intact, detail: ledger.intact ? `${ledger.entries.length} entries, chain intact` : 'a line was changed or removed' }
      : { name: 'ledger', passed: true, skipped: true, detail: 'no ledger here' },
  );

  // ---- The committed files belong together ----------------------------------------------
  const files = { config: `belay/${name}/${options.backendName}.local.json`, calibration: `belay/${name}/${options.backendName}.calibration.json`, record: `belay/${name}/${options.backendName}.gate.json` };
  const rawConfig = await readJson(join(root, files.config));
  if (rawConfig === undefined) {
    notes.push(`No tuned config (${files.config}): only the lock and the ledger were checked.`);
    return done();
  }
  let config: LocalConfig;
  let calibration: CalibrationFile & { localConfig?: string };
  let record: GateRecord;
  try {
    config = parseLocalConfig(rawConfig, name, schema);
    const rawCalibration = await readJson(join(root, files.calibration));
    if (rawCalibration === undefined) throw new Error(`${files.calibration} is missing`);
    calibration = parseCalibration(rawCalibration, name);
    const rawRecord = await readJson(join(root, files.record));
    if (rawRecord === undefined) throw new Error(`${files.record} is missing: it is written when a config passes the gate`);
    record = parseGateRecord(rawRecord, name);
    const fingerprint = localConfigFingerprint(config);
    if (calibration.schemaFingerprint !== schemaFingerprint(schema)) throw new Error('the calibration file was fitted for another schema of this task');
    if (calibration.localConfig !== fingerprint) throw new Error(`${files.calibration} was fitted for another config than ${files.config}`);
    if (record.config !== fingerprint) throw new Error(`${files.record} is for another config than ${files.config}: the config was changed without passing the gate`);
    if ((record.threshold ?? NO_LOCAL_THRESHOLD) !== calibration.threshold) throw new Error(`the threshold in ${files.calibration} is not the one that passed the gate`);
    checks.push({ name: 'files', passed: true, detail: 'config, calibration file and gate record belong together' });
  } catch (err) {
    checks.push({ name: 'files', passed: false, detail: err instanceof Error ? err.message : String(err) });
    notes.push('Run "belay tune" to produce a config that passed the gate, or restore the committed files.');
    return done({ tuned: true });
  }

  const gate: GateConfig = state.gate;
  const chars = contextSize(schema, taskConfig.context, config);
  checks.push({ name: 'prompt-size', passed: chars <= gate.maxContextChars, detail: `${chars} characters; at most ${gate.maxContextChars}` });
  if (!checks.every((c) => c.passed)) return done({ tuned: true });

  // ---- Today's browser, on the holdout inputs of the record -------------------------------
  const holdout = await options.holdout();
  const cloud = cloudSide(holdout, taskConfig, options.cloudAccuracy);
  const applied = applyLocalConfig(schema, taskConfig.context, config);
  const { context: _context, ...rest } = taskConfig;
  const backend = await options.backend();
  let current: ScoredExample[];
  let environment: GateRecord['environment'];
  try {
    if (!backend.derive) throw new Error('this local backend cannot run a tuned config (no derive())');
    log(`Verify: ${holdout.examples.length} holdout examples, without the cache`);
    const evaluation = await evaluateLocal({
      name,
      config: { ...rest, schema: applied.schema, ...(applied.context ? { context: applied.context } : {}) },
      dataset: holdout.dataset,
      backend: backend.derive(applied),
      cache: await OutputCache.open(null),
      refresh: true,
      ...(options.onProgress ? { onProgress: (e) => options.onProgress!({ done: e.done, total: e.total }) } : {}),
      log,
    });
    environment = { runner: evaluation.local.runner, ...(taskConfig.models?.local ? { model: taskConfig.models.local } : {}), ...(evaluation.local.userAgent ? { userAgent: evaluation.local.userAgent } : {}) };
    current = toScored(holdout, evaluation.samples, cloud);
  } finally {
    await backend.close();
  }

  // Pair what was recorded with what ran now. The lock already holds every recorded input in place.
  const now = current.filter((e) => Object.hasOwn(record.outcomes, e.id));
  const then = now.map((e): ScoredExample => {
    const [confidence, correct] = record.outcomes[e.id]!;
    const { latencyMs: _latency, ...same } = e;
    return { ...same, local: confidence === null ? null : { confidence, correct: correct === 1 } };
  });
  if (!now.length) {
    checks.push({ name: 'accuracy', passed: false, detail: 'none of the recorded holdout inputs is in the holdout' });
    return done({ tuned: true });
  }
  const threshold = record.threshold;
  const b = scoreAt(then, threshold);
  const c = scoreAt(now, threshold);
  const difference = pairedBootstrap({ examples: then, threshold }, { examples: now, threshold }, { resamples: gate.resamples, ...(options.seed !== undefined ? { seed: options.seed } : {}) });
  const eps = 1e-9;

  checks.push({
    name: 'accuracy',
    passed: difference.accuracy >= -gate.accuracyMargin - eps,
    detail: `${pct(c.accuracy)} now vs ${pct(b.accuracy)} at the gate (${points(difference.accuracy)}, 95% CI ${points(difference.accuracyInterval[0])} to ${points(difference.accuracyInterval[1])}); may not be lower by more than ${pct(gate.accuracyMargin, 0)}`,
  });
  checks.push({
    name: 'local-share',
    passed: difference.localShare >= -gate.minLocalShareGain - eps,
    detail: `${pct(c.localShare)} now vs ${pct(b.localShare)} at the gate (${points(difference.localShare)}); may not be lower by more than ${pct(gate.minLocalShareGain, 0)}`,
  });
  const worst = Object.keys(b.recall)
    .map((label) => ({ label, drop: b.recall[label]! - (c.recall[label] ?? 0) }))
    .sort((x, y) => y.drop - x.drop)[0];
  checks.push({
    name: 'recall',
    passed: !worst || worst.drop <= gate.maxRecallDrop + eps,
    ...(worst ? {} : { skipped: true }),
    detail: worst ? `largest drop: "${worst.label}" ${points(-worst.drop)}; no label may drop by more than ${pct(gate.maxRecallDrop, 0)}` : 'no labels to compare',
  });
  const calibrated = b.calibrationError !== null && c.calibrationError !== null;
  checks.push({
    name: 'calibration',
    passed: !calibrated || c.calibrationError! <= b.calibrationError! + gate.calibrationErrorMargin + eps,
    ...(calibrated ? {} : { skipped: true }),
    detail: calibrated ? `calibration error ${c.calibrationError!.toFixed(3)} now vs ${b.calibrationError!.toFixed(3)}; may rise by at most ${gate.calibrationErrorMargin}` : 'no local answers to measure',
  });
  // CI machines are not the machine the config was tuned on: latency is shown, not judged.
  checks.push({
    name: 'latency',
    passed: true,
    skipped: true,
    detail: c.latencyP95Ms === null ? 'not measured' : `p95 ${c.latencyP95Ms.toFixed(0)} ms now${record.scores.latencyP95Ms === null ? '' : `, ${record.scores.latencyP95Ms.toFixed(0)} ms at the gate`} (for information: machines differ)`,
  });

  const changed = (record.environment.userAgent ?? '') !== (environment.userAgent ?? '') || record.environment.runner !== environment.runner;
  const flipped = now.filter((e, i) => (e.local?.correct ?? null) !== (then[i]!.local?.correct ?? null) || (e.local === null) !== (then[i]!.local === null)).length;
  const report = done({ tuned: true, environment: { recorded: record.environment, current: environment, changed }, recorded: b, current: c, added: current.length - now.length });
  if (flipped) notes.push(`${flipped} of ${now.length} holdout inputs are answered differently than at the gate${changed ? '' : ', in what reports itself as the same browser'}.`);
  if (!report.passed) {
    notes.push(
      `The config no longer does what it did when it passed the gate${changed ? ` (the browser changed: ${record.environment.userAgent ?? record.environment.runner} then, ${environment.userAgent ?? environment.runner} now)` : ''}.`,
      `Run "belay tune --task ${name}" in this browser: it fits the threshold again and, if needed, looks for a config that holds the target, and puts the result through the gate. Until then the cascade may be less accurate than its target.`,
    );
  }
  return report;
}

/** The verify report as Markdown, e.g. for a CI job summary. */
export function renderVerify(report: VerifyReport): string {
  const out: string[] = [`# Belay verify: ${report.task}`, '', `**${report.passed ? (report.tuned ? 'The tuned config still holds.' : 'The protected files match the lock.') : 'Failed.'}**`, ''];
  if (report.environment) {
    out.push(`- At the gate: ${report.environment.recorded.userAgent ?? report.environment.recorded.runner}`, `- Now: ${report.environment.current.userAgent ?? report.environment.current.runner}`, '');
  }
  out.push('| Check | Result | Detail |', '| --- | --- | --- |');
  for (const check of report.checks) out.push(`| ${check.name} | ${check.skipped ? 'info' : check.passed ? 'pass' : '**FAIL**'} | ${check.detail.replace(/\|/g, '\\|')} |`);
  out.push('');
  for (const note of report.notes) out.push(`- ${note}`);
  if (report.notes.length) out.push('');
  return out.join('\n');
}
