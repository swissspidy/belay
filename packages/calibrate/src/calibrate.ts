import { CALIBRATION_VERSION, optionLabels, schemaFingerprint, type CalibrationFile } from '@belay/core';
import { analyze, type Analysis } from './analyze.js';
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
  target?: number;
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

export function resolveCreatedAt(explicit?: string): string {
  if (explicit) return new Date(explicit).toISOString();
  const epoch = process.env['SOURCE_DATE_EPOCH'];
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000).toISOString();
  return new Date().toISOString();
}

export async function calibrate(options: CalibrateOptions): Promise<CalibrateResult> {
  const { name, config, dataset } = options;
  const target = options.target ?? config.target ?? 0.95;
  if (!(target > 0 && target <= 1)) throw new Error(`target must be in (0, 1], got ${target}`);

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
  const analysis = analyze(evaluation.samples, {
    target,
    ...(labels ? { labels } : {}),
    perLabel: options.perLabel ?? config.perLabel ?? false,
    ...(config.cost ? { cost: config.cost } : {}),
  });

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
    target: { metric: 'accuracy', value: target },
    threshold: analysis.threshold,
    ...(analysis.thresholds ? { thresholds: analysis.thresholds } : {}),
    expected: analysis.expected,
    ...(config.cost ? { cost: config.cost } : {}),
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
