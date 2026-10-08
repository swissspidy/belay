import { CALIBRATION_VERSION, optionLabels, schemaFingerprint, type CalibrationFile, type PriceTable, type TokenPrices } from '@swissspidy/belay-core';
import { analyze, crossValidate, type Analysis, type AnalyzeOptions } from './analyze.js';
import type { OutputCache } from './cache.js';
import type { CalibrationTaskConfig } from './config.js';
import type { Dataset } from './dataset.js';
import { evaluate, type EvaluateOptions, type Evaluation, type LocalBackend } from './evaluate.js';
import { renderReport } from './report.js';

export interface CalibrateOptions {
  name: string;
  config: CalibrationTaskConfig<any>;
  dataset: Dataset;
  backend: LocalBackend;
  cache: OutputCache;
  target?: number | 'cloud' | 'max';
  perLabel?: boolean;
  /** Fixed timestamp for reproducible files. Defaults to `SOURCE_DATE_EPOCH` or now. */
  createdAt?: string;
  datasetPath?: string;
  refresh?: EvaluateOptions['refresh'];
  cloudConcurrency?: number;
  onProgress?: EvaluateOptions['onProgress'];
  log?: (message: string) => void;
}

export interface CalibrateResult {
  file: CalibrationFile;
  analysis: Analysis;
  evaluation: Evaluation;
  report: string;
}

/** The price entries the dataset's calls actually used, so the file records what was charged. */
function usedPrices(prices: PriceTable | TokenPrices, samples: Evaluation['samples']): PriceTable {
  if (typeof (prices as TokenPrices).input === 'number') return { '*': prices as TokenPrices };
  const table = prices as PriceTable;
  const used: PriceTable = {};
  for (const s of samples) for (const u of s.cloud?.usage ?? []) if (u.model && Object.hasOwn(table, u.model)) used[u.model] = table[u.model]!;
  return used;
}

export function resolveCreatedAt(explicit?: string): string {
  if (explicit) return new Date(explicit).toISOString();
  const epoch = process.env['SOURCE_DATE_EPOCH'];
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000).toISOString();
  return new Date().toISOString();
}

export async function calibrate(options: CalibrateOptions): Promise<CalibrateResult> {
  const { name, config, dataset } = options;
  const target = options.target ?? config.target ?? 'cloud';
  if (typeof target === 'number' ? !(target > 0 && target <= 1) : target !== 'cloud' && target !== 'max') {
    throw new Error(`target must be a number in (0, 1], "cloud" or "max", got ${String(target)}`);
  }
  if (config.cost && config.cost.prices === undefined && config.cost.cloudPerRun === undefined) {
    throw new Error(`task "${name}": cost needs prices (per million tokens) or cloudPerRun`);
  }

  const evaluation = await evaluate({
    name,
    config,
    dataset,
    backend: options.backend,
    cache: options.cache,
    ...(options.refresh ? { refresh: options.refresh } : {}),
    ...(options.cloudConcurrency ? { cloudConcurrency: options.cloudConcurrency } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.log ? { log: options.log } : {}),
  });

  const labels = config.schema.type === 'structured' ? undefined : optionLabels(config.schema);
  const analyzeOptions: AnalyzeOptions = {
    target,
    ...(labels ? { labels } : {}),
    perLabel: options.perLabel ?? config.perLabel ?? false,
    ...(config.cost ? { cost: { currency: config.cost.currency, ...(config.cost.cloudPerRun !== undefined ? { cloudPerRun: config.cost.cloudPerRun } : {}) } } : {}),
  };
  const analysis = analyze(evaluation.samples, analyzeOptions);
  const heldOut = crossValidate(evaluation.samples, analyzeOptions);

  let cost: CalibrationFile['cost'];
  if (analysis.cost) {
    const c = analysis.cost;
    cost = {
      currency: c.currency,
      cloudPerRun: Math.round(c.cloudPerRun * 1e9) / 1e9,
      basis: c.basis,
      ...(c.basis === 'measured' && config.cost?.prices ? { prices: usedPrices(config.cost.prices, evaluation.samples) } : {}),
      ...(c.tokensPerRun ? { tokensPerRun: c.tokensPerRun } : {}),
      ...(config.cost?.runsPerMonth ? { runsPerMonth: config.cost.runsPerMonth } : {}),
    };
  }

  const local: CalibrationFile['local'] = { runner: evaluation.local.runner };
  const localModel = config.models?.local ?? evaluation.local.model;
  if (localModel) local.model = localModel;
  if (evaluation.local.userAgent) local.userAgent = evaluation.local.userAgent;

  const file: CalibrationFile = {
    version: CALIBRATION_VERSION,
    task: name,
    schemaFingerprint: schemaFingerprint(config.schema),
    createdAt: resolveCreatedAt(options.createdAt),
    local,
    cloud: { runner: config.cloud.id, ...(config.models?.cloud ? { model: config.models.cloud } : {}) },
    dataset: { size: dataset.examples.length, fingerprint: dataset.fingerprint },
    target: { metric: 'accuracy', value: analysis.target.value, mode: analysis.target.mode },
    threshold: analysis.threshold,
    ...(analysis.thresholds ? { thresholds: analysis.thresholds } : {}),
    expected: { ...analysis.expected, ...(heldOut ? { heldOut } : {}) },
    ...(cost ? { cost } : {}),
    curve: analysis.curve,
    confidenceHistogram: analysis.confidenceHistogram,
    ...(analysis.confusion ? { confusion: analysis.confusion } : {}),
  };

  const report = renderReport({
    file,
    analysis,
    samples: evaluation.samples,
    ...(options.datasetPath ? { datasetPath: options.datasetPath } : {}),
    cached: evaluation.cached,
  });
  return { file, analysis, evaluation, report };
}
