/**
 * The tuning loop: baseline, diagnose, propose, screen, validate, select, gate. See ADR 0007 §9.
 */
import { CALIBRATION_VERSION, costOf, schemaFingerprint, usageParts, type CalibrationFile, type CloudUsage, type PriceTable, type TokenPrices } from '@swissspidy/belay-core';
import { evaluateLocal, OutputCache, type CalibrationTaskConfig, type LocalBackend, type Reflector } from '@swissspidy/belay-calibrate';
import type { DatasetManifest } from '@swissspidy/belay-trace/node';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cloudSide, toScored, type CloudSide } from './dry-run.js';
import { holdoutPower, runGate, type GateResult } from './gate.js';
import { appendLedger, readLedger, type LedgerEntry, type LedgerRung, type LedgerScores } from './ledger.js';
import { applyConfigPatch, applyLocalConfig, contextSize, emptyLocalConfig, localConfigFingerprint, parseLocalConfig, TUNABLE_ROOTS, type ConfigPatchOp, type LocalConfig } from './local-config.js';
import { createWorkspace, currentState, lockHash, readLock, verifyLock, LOCK_FILE } from './protect.js';
import { renderPullRequest, renderReport } from './report.js';
import { gateRecordOf, NO_LOCAL_THRESHOLD, type GateRecord } from './verify.js';
import { buildReflectRequest, parseProposals, type ProposalRung, type ReflectExample } from './reflector.js';
import { score, scoreAt, type ScoredExample } from './score.js';
import type { SplitFile } from './split.js';

export interface TuneSettings {
  /** Candidates asked for per call of the reflecting model. */
  perRound: number;
  /** Validation examples a candidate is screened on before the full run. */
  screenSize: number;
  /** Training examples run to find failures to show the reflecting model. */
  diagnoseSize: number;
  /** Examples of each kind (wrong, unsure, confident) shown to the reflecting model. */
  shown: number;
  /** Rounds without a kept candidate before the loop climbs to the next rung. */
  patience: number;
  /** A candidate is kept when its local share on validation beats its parent's by at least this. */
  minGain: number;
  /** A candidate is screened out when its local share on the screening sample is lower by more than this. */
  screenSlack: number;
  /** How many kept candidates stay in the population. */
  population: number;
}

export const DEFAULT_SETTINGS: TuneSettings = { perRound: 4, screenSize: 60, diagnoseSize: 150, shown: 20, patience: 2, minGain: 0.005, screenSlack: 0.05, population: 3 };

export interface TuneOptions {
  name: string;
  taskConfig: CalibrationTaskConfig<any>;
  /** The project directory: the lock, the gate config and every output are relative to it. */
  root: string;
  /** The local backend. It must support `derive()`. */
  backend: LocalBackend;
  /** Names the config and calibration files, e.g. "classifier-api". */
  backendName: string;
  cache: OutputCache;
  train: SplitFile;
  validation: SplitFile;
  /** Loaded only when a candidate reaches the gate. */
  holdout: () => Promise<SplitFile>;
  manifest: DatasetManifest;
  reflector: Reflector;
  prices?: PriceTable | TokenPrices;
  /** Charged per call when the reflector reports no usage, or has no price. Defaults to 0.25. */
  costPerCall?: number;
  currency?: string;
  target: number;
  cloudAccuracy?: number;
  /** Cost of one cloud call, for the report. */
  cloudPerRun?: number;
  budget: { reflectorSpend: number; maxExperiments: number; maxMinutes?: number };
  /** Names the night, e.g. "2026-11-10". Ledger ids start with it. */
  run: string;
  /** Continue a run whose entries are already in the ledger. */
  resume?: boolean;
  seed?: string | number;
  settings?: Partial<TuneSettings>;
  /** Tests: the directories hashed as the evaluator. */
  evaluatorRoots?: readonly string[];
  now?: () => Date;
  log?: (message: string) => void;
  onProgress?: (event: { what: string; done: number; total: number }) => void;
}

export type TuneOutcome =
  /** A candidate passed the gate; the config and calibration files were written. */
  | 'promoted'
  /** The best candidate failed the gate. Nothing was written but the ledger and the report. */
  | 'rejected'
  /** The holdout was too small for the gate to tell. Nothing was written; the candidate is tried again next time. */
  | 'inconclusive'
  /** Nothing beat the baseline on validation. */
  | 'plateau';

export type StopReason = 'rungs-exhausted' | 'max-experiments' | 'budget' | 'time' | 'reflector-error';

export interface TuneReport {
  version: 1;
  task: string;
  backend: string;
  run: string;
  createdAt: string;
  outcome: TuneOutcome;
  stopped: StopReason;
  target: number;
  environment: { runner: string; model?: string; userAgent?: string };
  /** On validation. */
  baseline: LedgerScores;
  best: LedgerScores & { hypothesis: string; rung: LedgerRung; id: string };
  /** The gate's result on the holdout, when a candidate reached it. */
  gate?: GateResult;
  experiments: { run: number; kept: number; discarded: number; errors: number; screenedOut: number };
  spend: { currency: string; reflector: number; calls: number; cap: number };
  /** Cloud cost per 1,000 runs before and after, when `cloudPerRun` is known. */
  cloudCostPer1k?: { baseline: number; best: number };
  datasets: { train: number; validation: number; holdout: number | null; gold: { validation: number; holdout: number | null } };
  cloud: { assumed: number; assumedAccuracy: number };
  /** The lock hash at the start and at the end: equal, or the run stops. */
  protected: { start: string; end: string; unchanged: boolean };
  /** Why nothing shipped, and what to try next. */
  notes: string[];
  entries: LedgerEntry[];
  files: { config?: string; calibration?: string; record?: string; pullRequest?: string; ledger: string; report: string };
  /** `true` when the committed config no longer held the target, so that restoring it was enough to pass the gate. */
  repair?: boolean;
}

interface Member {
  id: string;
  rung: LedgerRung;
  hypothesis: string;
  config: LocalConfig;
  fingerprint: string;
  chars: number;
  validation: ScoredExample[];
  threshold: number | null;
  localShare: number;
  accuracy: number;
  targetMet: boolean;
}

const subset = (split: SplitFile, n: number): SplitFile =>
  n >= split.examples.length ? split : { examples: split.examples.slice(0, n), dataset: { examples: split.dataset.examples.slice(0, n), fingerprint: `${split.dataset.fingerprint}:${n}` } };

/** Runs one night of tuning. Throws when the lock is missing or does not match. */
export async function tune(options: TuneOptions): Promise<TuneReport> {
  const { name, taskConfig, root, cache, target, run } = options;
  const { schema } = taskConfig;
  const settings = { ...DEFAULT_SETTINGS, ...options.settings };
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const seed = String(options.seed ?? 0);
  const currency = options.currency ?? 'USD';
  const started = Date.now();
  if (!(target > 0 && target <= 1)) throw new Error(`target must be in (0, 1], got ${String(target)}`);
  if (!options.backend.derive) throw new Error('this local backend cannot run a changed config (no derive())');

  const files = {
    config: `belay/${name}/${options.backendName}.local.json`,
    calibration: `belay/${name}/${options.backendName}.calibration.json`,
    /** What the promoted config did on the holdout: the reference of `belay verify`. */
    record: `belay/${name}/${options.backendName}.gate.json`,
    pullRequest: `.belay/tune/${name}/pull-request.md`,
    pullRequestTitle: `.belay/tune/${name}/pull-request-title.txt`,
    ledger: '.belay/ledger.jsonl',
    report: `.belay/tune/${name}/report.md`,
    reportJson: `.belay/tune/${name}/report.json`,
    /** A candidate the gate could not settle, kept for the next run. */
    pending: `.belay/tune/${name}/${options.backendName}.pending.json`,
  };
  const workspace = createWorkspace(root, [`belay/${name}`, files.ledger, `.belay/tune/${name}`]);

  // ---- Protection: the lock must match before anything runs -----------------
  const lockFile = await readLock(root);
  const locked = lockFile?.tasks[name];
  if (!locked) throw new Error(`no lock for task "${name}" in ${LOCK_FILE}: run "belay tune --lock --task ${name}", review the file and commit it`);
  const check = async (when: string) => {
    const state = await currentState(root, options.manifest, options.evaluatorRoots ? { evaluatorRoots: options.evaluatorRoots } : {});
    const problems = verifyLock(locked, state.lock);
    if (problems.length) throw new Error(`belay tune stopped ${when}: ${problems.join('; ')}. If the change is intended, run "belay tune --lock" again and commit ${LOCK_FILE}.`);
    return state;
  };
  const state = await check('before it started');
  const protectedHash = lockHash(locked);
  const { gate } = state;

  // ---- Ledger -------------------------------------------------------------------
  const ledgerPath = join(root, files.ledger);
  const ledger = await readLedger(ledgerPath);
  if (!ledger.intact) throw new Error(`${files.ledger} is not intact: a line was changed or removed`);
  const earlier = new Map(ledger.entries.filter((e) => e.run === run && e.task === name).map((e) => [e.id, e]));
  if (earlier.size && !options.resume) throw new Error(`the ledger already has run "${run}" of task "${name}": pass --resume to continue it, or --run to name a new one`);
  const history = ledger.entries.filter((e) => e.task === name && e.backend === options.backendName && e.run !== run);
  const entries: LedgerEntry[] = [];
  let seq = 0;
  let environment: TuneReport['environment'] = { runner: options.backendName };
  const record = async (entry: Omit<LedgerEntry, 'version' | 'previous' | 'id' | 'run' | 'seq' | 'timestamp' | 'task' | 'backend' | 'protected' | 'seed' | 'environment'>): Promise<LedgerEntry> => {
    const id = `${run}.${String(seq).padStart(3, '0')}`;
    seq++;
    const existing = earlier.get(id);
    // A resumed run replays from the caches and writes nothing twice.
    const written =
      existing ??
      (await appendLedger(ledgerPath, ledger, { ...entry, id, run, seq: seq - 1, timestamp: now().toISOString(), task: name, backend: options.backendName, environment, protected: protectedHash, seed }));
    entries.push(written);
    return written;
  };

  // ---- Evaluation -----------------------------------------------------------------
  const clouds = new Map<SplitFile, CloudSide>();
  const cloudOf = (split: SplitFile): CloudSide => {
    let side = clouds.get(split);
    if (!side) clouds.set(split, (side = cloudSide(split, taskConfig, options.cloudAccuracy)));
    return side;
  };
  const evaluate = async (config: LocalConfig, split: SplitFile, what: string, limit?: number): Promise<ScoredExample[]> => {
    const applied = applyLocalConfig(schema, taskConfig.context, config);
    const { context: _context, ...rest } = taskConfig;
    const part = limit === undefined ? split : subset(split, limit);
    const evaluation = await evaluateLocal({
      name,
      config: { ...rest, schema: applied.schema, ...(applied.context ? { context: applied.context } : {}) },
      dataset: part.dataset,
      backend: options.backend.derive!(applied),
      cache,
      onProgress: (e) => options.onProgress?.({ what, done: e.done, total: e.total }),
      log,
    });
    environment = { runner: evaluation.local.runner, ...(taskConfig.models?.local ? { model: taskConfig.models.local } : {}), ...(evaluation.local.userAgent ? { userAgent: evaluation.local.userAgent } : {}) };
    // The cloud's side is the whole split's, so that a part is scored as the whole would be.
    return toScored(split, evaluation.samples, cloudOf(split));
  };
  const scoresOf = (m: Pick<Member, 'localShare' | 'accuracy' | 'threshold' | 'targetMet' | 'chars' | 'validation'>): LedgerScores => {
    const at = scoreAt(m.validation, m.threshold);
    return { localShare: m.localShare, accuracy: m.accuracy, threshold: m.threshold, targetMet: m.targetMet, goldAccuracy: at.goldAccuracy, cloudAgreement: at.cloudAgreement, contextChars: m.chars, examples: m.validation.length };
  };

  // ---- Baseline: the committed config, at its committed threshold ---------------
  let baseConfig = emptyLocalConfig(name, { runner: options.backendName, ...(taskConfig.models?.local ? { model: taskConfig.models.local } : {}) });
  let committedThreshold: number | undefined;
  try {
    baseConfig = parseLocalConfig(JSON.parse(await readFile(join(root, files.config), 'utf8')), name, schema);
    try {
      const calibration = JSON.parse(await readFile(join(root, files.calibration), 'utf8')) as CalibrationFile & { localConfig?: string };
      if (calibration.localConfig === localConfigFingerprint(baseConfig) && calibration.schemaFingerprint === schemaFingerprint(schema)) committedThreshold = calibration.threshold;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  log(`Baseline: ${options.validation.examples.length} validation examples`);
  const baseValidation = await evaluate(baseConfig, options.validation, 'baseline');
  const baseFit = score(baseValidation, { target, seed, resamples: 0 });
  const baseAt = committedThreshold === undefined ? null : scoreAt(baseValidation, committedThreshold);
  const base: Member = {
    id: '',
    rung: 'baseline',
    hypothesis: 'The config as committed.',
    config: baseConfig,
    fingerprint: localConfigFingerprint(baseConfig),
    chars: contextSize(schema, taskConfig.context, baseConfig),
    validation: baseValidation,
    threshold: baseAt ? committedThreshold! : baseFit.threshold,
    localShare: baseAt ? baseAt.localShare : baseFit.localShare,
    accuracy: baseAt ? baseAt.accuracy : baseFit.accuracy,
    targetMet: baseAt ? baseAt.accuracy >= target - 1e-9 : baseFit.targetMet,
  };
  base.id = (
    await record({
      rung: 'baseline',
      hypothesis: base.hypothesis,
      parent: null,
      candidate: base.fingerprint,
      patch: [],
      stage: 'baseline',
      scores: scoresOf(base),
      verdict: 'baseline',
      reason: baseAt ? 'The committed config at its committed threshold.' : 'The committed config, with the threshold fitted on validation.',
    })
  ).id;

  let population: Member[] = [base];
  const seen = new Set<string>([base.fingerprint]);
  const counts = { run: 0, kept: 0, discarded: 0, errors: 0, screenedOut: 0 };
  const rank = (a: Member, b: Member): number => Number(b.targetMet) - Number(a.targetMet) || b.localShare - a.localShare || a.chars - b.chars;
  const best = (): Member => [...population].sort(rank)[0]!;

  // ---- Rung 1: the threshold, fitted again on fresh traces ---------------------------
  if (baseAt) {
    counts.run++;
    // Drift: the committed threshold no longer holds the target, and a new one does.
    const repairs = baseFit.targetMet && !base.targetMet;
    const kept = repairs || (baseFit.targetMet && baseFit.localShare >= base.localShare + settings.minGain);
    const refit: Member = { ...base, rung: 'threshold', hypothesis: 'The threshold, fitted again on the current validation split.', threshold: baseFit.threshold, localShare: baseFit.localShare, accuracy: baseFit.accuracy, targetMet: baseFit.targetMet };
    refit.id = (
      await record({
        rung: 'threshold',
        hypothesis: refit.hypothesis,
        parent: base.fingerprint,
        candidate: base.fingerprint,
        patch: [],
        stage: 'validation',
        scores: scoresOf(refit),
        verdict: kept ? 'kept' : 'discarded',
        reason: repairs ? 'The committed threshold no longer holds the target accuracy; this one does.' : kept ? `Local share up ${((baseFit.localShare - base.localShare) * 100).toFixed(1)} points at the target accuracy.` : 'The committed threshold is as good as a new one.',
      })
    ).id;
    if (kept) {
      counts.kept++;
      population.push(refit);
    } else {
      counts.discarded++;
    }
  }

  // ---- Before the night is spent: can this holdout settle the accuracy check? ---------
  const notes: string[] = [];
  const power = holdoutPower(locked.holdout.ids.length, base.accuracy, gate);
  if (!power.enough) {
    const warning = `The holdout has ${locked.holdout.ids.length} examples. The gate's accuracy check (at most ${(gate.accuracyMargin * 100).toFixed(1)} points lower) will probably need ${power.needed === null ? 'far more' : `about ${power.needed}`}: expect "inconclusive" rather than a promotion. Collect more traces, or have the gate's owner widen accuracyMargin in belay.gate.json.`;
    log(`Warning: ${warning}`);
    notes.push(warning);
  }

  // ---- A candidate an earlier gate could not settle is tried again first ---------------
  let pendingFrom: string | null = null;
  let carried: unknown;
  try {
    type Pending = { run?: unknown; id?: unknown; rung?: unknown; hypothesis?: unknown; config?: unknown; carried?: unknown };
    let pending = JSON.parse(await readFile(join(root, files.pending), 'utf8')) as Pending;
    // Written by this very run (it is being resumed): replay what it started from.
    if (pending.run === run) pending = (pending.carried ?? {}) as Pending;
    if (typeof pending.hypothesis === 'string' && (pending.rung === 'examples' || pending.rung === 'rules')) {
      const config = parseLocalConfig(pending.config, name, schema);
      const fingerprint = localConfigFingerprint(config);
      const chars = contextSize(schema, taskConfig.context, config);
      if (!seen.has(fingerprint) && chars <= gate.maxContextChars) {
        seen.add(fingerprint);
        counts.run++;
        carried = pending;
        pendingFrom = String(pending.id ?? pending.run);
        const patch: ConfigPatchOp[] = TUNABLE_ROOTS.flatMap((key): ConfigPatchOp[] =>
          config[key] !== undefined ? [{ op: 'add', path: `/${key}`, value: config[key] }] : baseConfig[key] !== undefined ? [{ op: 'remove', path: `/${key}` }] : [],
        );
        const validation = await evaluate(config, options.validation, 'carried over');
        const fit = score(validation, { target, seed, resamples: 0 });
        const member: Member = { id: '', rung: pending.rung, hypothesis: pending.hypothesis, config, fingerprint, chars, validation, threshold: fit.threshold, localShare: fit.localShare, accuracy: fit.accuracy, targetMet: fit.targetMet };
        const gain = fit.localShare - base.localShare;
        const kept = fit.targetMet && gain >= settings.minGain;
        member.id = (
          await record({
            rung: pending.rung,
            hypothesis: pending.hypothesis,
            parent: base.fingerprint,
            candidate: fingerprint,
            patch,
            stage: 'validation',
            scores: scoresOf(member),
            verdict: kept ? 'kept' : 'discarded',
            reason: `Carried over from ${pendingFrom}, where the gate was inconclusive. ${kept ? `Local share up ${(gain * 100).toFixed(1)} points on validation at the target accuracy.` : 'It no longer beats the baseline on validation.'}`,
          })
        ).id;
        if (kept) {
          counts.kept++;
          population.push(member);
        } else {
          counts.discarded++;
        }
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`Ignoring ${files.pending}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- Rungs 2 and 3: examples, then rules --------------------------------------------
  const trainById = new Map(options.train.examples.map((e) => [e.id, { input: e.input, label: e.label }]));
  const trainLabels = new Map(options.train.dataset.examples.map((e) => [e.id, e.truth]));
  let rung: ProposalRung | null = 'examples';
  let stale = 0;
  let spend = 0;
  let calls = 0;
  let stopped: StopReason = 'rungs-exhausted';
  const asked = new Set<string>();
  const timeUp = (): boolean => options.budget.maxMinutes !== undefined && (Date.now() - started) / 60000 >= options.budget.maxMinutes;

  while (rung) {
    if (counts.run >= options.budget.maxExperiments) {
      stopped = 'max-experiments';
      break;
    }
    if (spend >= options.budget.reflectorSpend) {
      stopped = 'budget';
      break;
    }
    if (timeUp()) {
      stopped = 'time';
      break;
    }
    const parent = best();

    // Diagnose: what does the parent get wrong, on training inputs?
    const applied = applyLocalConfig(schema, taskConfig.context, parent.config);
    const { context: _context, ...rest } = taskConfig;
    const trainPart = subset(options.train, settings.diagnoseSize);
    const diagnosis = await evaluateLocal({
      name,
      config: { ...rest, schema: applied.schema, ...(applied.context ? { context: applied.context } : {}) },
      dataset: trainPart.dataset,
      backend: options.backend.derive!(applied),
      cache,
      onProgress: (e) => options.onProgress?.({ what: 'diagnose', done: e.done, total: e.total }),
      log,
    });
    const shown: Record<'wrong' | 'unsure' | 'confident', ReflectExample[]> = { wrong: [], unsure: [], confident: [] };
    for (const sample of diagnosis.samples) {
      const example: ReflectExample = { id: sample.id, input: sample.input, label: trainLabels.get(sample.id) ?? sample.truth, local: sample.local?.label ?? null, confidence: sample.local?.confidence ?? null };
      const kind = !sample.local || !sample.local.correct ? 'wrong' : parent.threshold !== null && sample.local.confidence >= parent.threshold ? 'confident' : 'unsure';
      shown[kind].push(example);
    }
    // The most confident mistakes and the least sure right answers say the most.
    shown.wrong.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    shown.unsure.sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0));

    const count = Math.min(settings.perRound, options.budget.maxExperiments - counts.run);
    const request = buildReflectRequest({
      task: name,
      schema,
      ...(taskConfig.context ? { taskContext: taskConfig.context } : {}),
      ...(state.instructions ? { instructions: state.instructions } : {}),
      rung,
      parent: parent.config,
      parentScore: { localShare: parent.localShare, accuracy: parent.accuracy, threshold: parent.threshold },
      target,
      wrong: shown.wrong.slice(0, settings.shown),
      unsure: shown.unsure.slice(0, settings.shown),
      confident: shown.confident.slice(0, Math.ceil(settings.shown / 2)),
      history: [...history, ...entries],
      count,
      maxContextChars: gate.maxContextChars,
    });

    // The answer is cached, so a resumed run asks (and pays) only once.
    const key = OutputCache.key({ side: 'reflector', reflector: options.reflector.id, request });
    if (asked.has(key)) {
      // Nothing changed since this was last asked in this run: the answer would be the same.
      stale++;
      if (stale >= settings.patience) {
        rung = rung === 'examples' ? 'rules' : null;
        stale = 0;
      }
      continue;
    }
    asked.add(key);
    let answer = cache.get<{ output: unknown; usage?: CloudUsage[] }>(key);
    if (!answer) {
      try {
        const reply = await options.reflector.reflect(request, {});
        answer = { output: reply.output, ...(reply.usage ? { usage: usageParts(reply.usage) } : {}) };
        await cache.set(key, answer);
      } catch (err) {
        notes.push(`The reflecting model failed: ${err instanceof Error ? err.message : String(err)}`);
        stopped = 'reflector-error';
        break;
      }
    }
    calls++;
    let cost = options.costPerCall ?? 0.25;
    if (answer.usage?.length && options.prices) {
      try {
        cost = costOf(answer.usage, options.prices);
      } catch (err) {
        notes.push(`A reflector call was charged the flat ${cost} ${currency}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    spend += cost;

    const { proposals, rejected } = parseProposals(answer.output, rung, trainById, count);
    for (const reason of rejected) log(`reflector: ${reason}`);
    const share = proposals.length ? cost / proposals.length : cost;
    let keptThisRound = false;

    for (const proposal of proposals) {
      counts.run++;
      const common = { rung: proposal.rung as LedgerRung, hypothesis: proposal.hypothesis, parent: parent.fingerprint, patch: proposal.patch, cost: { currency, reflector: share, ...(answer.usage ? { usage: answer.usage } : {}) } };
      let config: LocalConfig;
      try {
        config = applyConfigPatch(parent.config, proposal.patch, schema, [proposal.rung]);
      } catch (err) {
        counts.errors++;
        await record({ ...common, candidate: parent.fingerprint, stage: 'screen', verdict: 'error', reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const fingerprint = localConfigFingerprint(config);
      const chars = contextSize(schema, taskConfig.context, config);
      if (seen.has(fingerprint)) {
        counts.discarded++;
        await record({ ...common, candidate: fingerprint, stage: 'screen', verdict: 'discarded', reason: 'The same config was tried before.' });
        continue;
      }
      seen.add(fingerprint);
      if (chars > gate.maxContextChars) {
        counts.discarded++;
        await record({ ...common, candidate: fingerprint, stage: 'screen', verdict: 'discarded', reason: `Too large: ${chars} characters, at most ${gate.maxContextChars}.` });
        continue;
      }

      try {
        // Screen on a part of validation first: most ideas fail, and a full run is slow.
        const size = Math.min(settings.screenSize, options.validation.examples.length);
        if (size < options.validation.examples.length) {
          const screened = await evaluate(config, options.validation, `screen ${counts.run}`, size);
          const mine = score(screened, { target, resamples: 0 });
          const theirs = score(parent.validation.slice(0, size), { target, resamples: 0 });
          if ((!mine.targetMet && theirs.targetMet) || mine.localShare < theirs.localShare - settings.screenSlack) {
            counts.discarded++;
            counts.screenedOut++;
            await record({
              ...common,
              candidate: fingerprint,
              stage: 'screen',
              scores: { localShare: mine.localShare, accuracy: mine.accuracy, threshold: mine.threshold, targetMet: mine.targetMet, contextChars: chars, examples: size },
              verdict: 'discarded',
              reason: `Screened out on ${size} validation examples: local share ${(mine.localShare * 100).toFixed(1)}% against the parent's ${(theirs.localShare * 100).toFixed(1)}%${mine.targetMet ? '' : ', and the target accuracy was not met'}.`,
            });
            continue;
          }
        }
        const validation = await evaluate(config, options.validation, `validate ${counts.run}`);
        const fit = score(validation, { target, seed, resamples: 0 });
        const member: Member = { id: '', rung: proposal.rung, hypothesis: proposal.hypothesis, config, fingerprint, chars, validation, threshold: fit.threshold, localShare: fit.localShare, accuracy: fit.accuracy, targetMet: fit.targetMet };
        const gain = fit.localShare - parent.localShare;
        // A parent that does not hold the target is beaten by any candidate that does.
        const kept = fit.targetMet && (gain >= settings.minGain || !parent.targetMet);
        member.id = (
          await record({
            ...common,
            candidate: fingerprint,
            stage: 'validation',
            scores: scoresOf(member),
            verdict: kept ? 'kept' : 'discarded',
            reason: kept
              ? gain >= settings.minGain
                ? `Local share up ${(gain * 100).toFixed(1)} points on validation at the target accuracy.`
                : 'Holds the target accuracy on validation, which its parent does not.'
              : fit.targetMet
                ? `Local share ${gain >= 0 ? 'up' : 'down'} ${(Math.abs(gain) * 100).toFixed(1)} points on validation: not a gain.`
                : 'The target accuracy was not met on validation.',
          })
        ).id;
        if (kept) {
          counts.kept++;
          keptThisRound = true;
          population.push(member);
        } else {
          counts.discarded++;
        }
      } catch (err) {
        counts.errors++;
        await record({ ...common, candidate: fingerprint, stage: 'screen', verdict: 'error', reason: err instanceof Error ? err.message : String(err) });
      }
      if (timeUp()) break;
    }
    if (!proposals.length) notes.push(`A reflector answer had no usable candidate (${rejected.join('; ') || 'empty'}).`);
    population = [...population].sort(rank).slice(0, Math.max(1, settings.population));
    if (!population.includes(base)) population.push(base);
    stale = keptThisRound ? 0 : stale + 1;
    if (stale >= settings.patience) {
      rung = rung === 'examples' ? 'rules' : null;
      stale = 0;
    }
  }

  // ---- Gate ---------------------------------------------------------------------------
  const winner = best();
  // A committed config that no longer holds the target (a browser update, new traces) is repaired
  // by any candidate that does: it need not gain local share.
  const repair = !base.targetMet && committedThreshold !== undefined;
  const improved = winner !== base && winner.targetMet && (repair || winner.localShare >= base.localShare + settings.minGain);
  let gateRecord: GateRecord | undefined;
  let outcome: TuneOutcome = 'plateau';
  let gateResult: GateResult | undefined;
  let holdoutSize: number | null = null;
  let holdoutGold: number | null = null;
  let end = state;
  if (improved) {
    await check('before the gate');
    const holdout = await options.holdout();
    holdoutSize = holdout.examples.length;
    log(`Gate: ${holdoutSize} holdout examples, baseline and candidate`);
    const baseHoldout = await evaluate(base.config, holdout, 'gate baseline');
    const winnerHoldout = winner.fingerprint === base.fingerprint ? baseHoldout : await evaluate(winner.config, holdout, 'gate candidate');
    // Both thresholds were fitted on validation: the holdout only scores.
    gateResult = runGate({ examples: baseHoldout, threshold: base.threshold, contextChars: base.chars }, { examples: winnerHoldout, threshold: winner.threshold, contextChars: winner.chars }, gate, { seed, ...(repair ? { repair: true } : {}) });
    if (gateResult.passed) gateRecord = gateRecordOf({ task: name, backend: options.backendName, config: winner.config, threshold: winner.threshold, target, run, createdAt: now().toISOString(), environment, examples: winnerHoldout });
    holdoutGold = gateResult.candidate.gold;
    outcome = gateResult.passed ? 'promoted' : gateResult.inconclusive ? 'inconclusive' : 'rejected';
    // The ledger is read by the reflecting model: it learns pass or fail, never a holdout number.
    await record({
      rung: 'gate',
      hypothesis: winner.hypothesis,
      parent: base.fingerprint,
      candidate: winner.fingerprint,
      patch: [],
      stage: 'gate',
      gate: { passed: gateResult.passed, ...(gateResult.inconclusive ? { inconclusive: true } : {}), failed: gateResult.checks.filter((c) => !c.passed).map((c) => c.name), basis: gateResult.basis },
      verdict: outcome,
      reason: gateResult.passed ? `Passed the gate (${winner.id}).` : gateResult.inconclusive ? `The gate could not tell (${winner.id}): the holdout is too small for the accuracy check. Every other check passed.` : `Failed the gate (${winner.id}): ${gateResult.checks.filter((c) => !c.passed).map((c) => c.name).join(', ')}.`,
    });
    end = await check('after the gate');
  } else {
    end = await check('at the end');
  }

  // ---- Report ---------------------------------------------------------------------------
  if (outcome === 'plateau') {
    notes.push(
      stopped === 'rungs-exhausted'
        ? `No candidate on rungs 1 to 3 (threshold, examples, rules) beat the baseline's local share by ${(settings.minGain * 100).toFixed(1)} points on validation at the target accuracy.`
        : `The run stopped early (${stopped}) before any candidate beat the baseline on validation.`,
    );
    if (!base.targetMet) notes.push('The baseline does not hold the target accuracy at any threshold: the cloud side, or the labels, limit it more than the local side does.');
    if (counts.screenedOut && counts.screenedOut === counts.run - (baseAt ? 1 : 0)) notes.push('Every candidate was screened out: adding context made the local model worse on this task.');
    notes.push('Next: rung 4 (reword the options or split the task), or more labeled traces: with few examples, small gains cannot be told from noise.');
  } else if (outcome === 'inconclusive') {
    notes.push(
      `The gate could not tell whether the best candidate is as accurate as the baseline: the holdout is too small. Every other check passed. Nothing was written.${gateResult?.holdoutNeeded ? ` About ${gateResult.holdoutNeeded} holdout examples would settle it (there are ${holdoutSize}).` : ''}`,
      `${winner.rung === 'threshold' ? 'The next run fits the threshold again.' : `The candidate is kept in ${files.pending} and is tried again first on the next run.`} To accept a wider margin instead, the gate's owner can raise accuracyMargin in belay.gate.json and run "belay tune --lock".`,
    );
  } else if (outcome === 'rejected') {
    notes.push('The best candidate on validation did not pass every check of the gate on the holdout (see the table). Nothing was written. The candidate stays in the ledger as rejected, so it is not proposed again.');
  }
  if (repair) notes.unshift(`The committed config no longer held the target accuracy on validation (${(base.accuracy * 100).toFixed(1)}% against ${(target * 100).toFixed(1)}%): the local model or the traffic changed. This run looked for a config that restores it; such a config need not gain local share to pass the gate.`);
  if (cloudOf(options.validation).assumed) notes.push(`The cloud's accuracy on ${cloudOf(options.validation).assumed} validation examples without a recorded cloud answer is assumed to be ${(cloudOf(options.validation).assumedAccuracy * 100).toFixed(1)}%.`);

  const report: TuneReport = {
    version: 1,
    task: name,
    backend: options.backendName,
    run,
    createdAt: now().toISOString(),
    outcome,
    stopped,
    target,
    environment,
    baseline: scoresOf(base),
    best: { ...scoresOf(winner), hypothesis: winner.hypothesis, rung: winner.rung, id: winner.id },
    ...(gateResult ? { gate: gateResult } : {}),
    experiments: counts,
    spend: { currency, reflector: spend, calls, cap: options.budget.reflectorSpend },
    ...(options.cloudPerRun !== undefined ? { cloudCostPer1k: { baseline: (1 - base.localShare) * options.cloudPerRun * 1000, best: (1 - winner.localShare) * options.cloudPerRun * 1000 } } : {}),
    datasets: {
      train: options.train.examples.length,
      validation: options.validation.examples.length,
      holdout: holdoutSize,
      gold: { validation: options.validation.examples.filter((e) => e.labelKind === 'gold').length, holdout: holdoutGold },
    },
    cloud: { assumed: cloudOf(options.validation).assumed, assumedAccuracy: cloudOf(options.validation).assumedAccuracy },
    protected: { start: lockHash(state.lock), end: lockHash(end.lock), unchanged: verifyLock(state.lock, end.lock).length === 0 && verifyLock(end.lock, state.lock).length === 0 },
    notes,
    entries,
    files: { ...(outcome === 'promoted' ? { config: files.config, calibration: files.calibration, record: files.record, pullRequest: files.pullRequest } : {}), ledger: files.ledger, report: files.report },
    ...(repair ? { repair: true } : {}),
  };

  if (outcome === 'promoted') {
    await workspace.write(files.record, JSON.stringify(gateRecord, null, 2) + '\n');
    const pr = renderPullRequest(report);
    await workspace.write(files.pullRequest, pr.body);
    await workspace.write(files.pullRequestTitle, pr.title + '\n');
    await workspace.write(files.config, JSON.stringify(winner.config, null, 2) + '\n');
    await workspace.write(files.calibration, JSON.stringify(calibrationOf(winner, { name, schema, environment, target, createdAt: report.createdAt, fingerprint: options.validation.dataset.fingerprint }), null, 2) + '\n');
  }
  // A candidate waits for a larger holdout only while the gate cannot tell; any other end settles it.
  if (outcome === 'inconclusive' && winner.rung !== 'threshold') {
    await workspace.write(files.pending, JSON.stringify({ version: 1, run, id: winner.id, rung: winner.rung, hypothesis: winner.hypothesis, config: winner.config, ...(carried ? { carried } : {}) }, null, 2) + '\n');
  } else {
    await workspace.remove(files.pending);
  }
  // A pull request text from an earlier night must not be picked up for this one.
  if (outcome !== 'promoted') {
    await workspace.remove(files.pullRequest);
    await workspace.remove(files.pullRequestTitle);
  }
  await workspace.write(files.reportJson, JSON.stringify(report, null, 2) + '\n');
  await workspace.write(files.report, renderReport(report));
  return report;
}

/** A v1 calibration file for a tuned config: the threshold fitted on validation, and its curve. */
function calibrationOf(
  member: Member,
  info: { name: string; schema: CalibrationTaskConfig<any>['schema']; environment: TuneReport['environment']; target: number; createdAt: string; fingerprint: string },
): CalibrationFile & { localConfig: string } {
  const examples = member.validation;
  const at = scoreAt(examples, member.threshold);
  const cloudOnly = scoreAt(examples, null);
  const curve = Array.from({ length: 21 }, (_, i) => {
    const threshold = i / 20;
    const point = scoreAt(examples, threshold);
    return { threshold, accuracy: point.accuracy, localShare: point.localShare, localAccuracy: point.localAccuracy };
  });
  const counts = new Array<number>(10).fill(0);
  for (const e of examples) if (e.local) counts[Math.min(9, Math.floor(e.local.confidence * 10))]!++;
  return {
    version: CALIBRATION_VERSION,
    task: info.name,
    schemaFingerprint: schemaFingerprint(info.schema),
    createdAt: info.createdAt,
    local: { runner: info.environment.runner, ...(info.environment.model ? { model: info.environment.model } : {}), ...(info.environment.userAgent ? { userAgent: info.environment.userAgent } : {}) },
    cloud: null,
    dataset: { size: examples.length, fingerprint: info.fingerprint },
    target: { metric: 'accuracy', value: info.target, mode: 'fixed' },
    // Above 1, nothing is accepted locally.
    threshold: member.threshold ?? NO_LOCAL_THRESHOLD,
    expected: { accuracy: at.accuracy, localShare: at.localShare, localAccuracy: at.localAccuracy, cloudAccuracy: cloudOnly.accuracy },
    curve,
    confidenceHistogram: { edges: Array.from({ length: 11 }, (_, i) => i / 10), counts },
    localConfig: member.fingerprint,
  };
}
