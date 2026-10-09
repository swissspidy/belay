import type { CloudRunner, Judge, LocalRunner, PriceTable, TaskSchema, TokenPrices, ValueOf } from '@swissspidy/belay-core';

/**
 * A local runner executed inside the browser (a real Chrome, via Playwright). Options must be
 * JSON-serializable because they cross into the page.
 */
export interface BrowserRunnerSpec {
  runner: 'classifier-api' | 'prompt-api';
  options?: Record<string, unknown>;
}

/** A judge executed inside the browser, for generation tasks (see @swissspidy/belay-web `classifierJudge`). */
export interface BrowserJudgeSpec {
  judge: 'classifier-judge';
  options?: Record<string, unknown>;
}

export interface CalibrationTaskConfig<S extends TaskSchema = TaskSchema> {
  /** The same schema object your app passes to `task()`. Share it through a module. */
  schema: S;
  context?: string;
  /** A browser runner spec, or a `LocalRunner` object executed in Node (mocks, replays, custom runners). */
  local: BrowserRunnerSpec | LocalRunner<S>;
  /** Generation tasks: a browser judge spec or a judge function executed in Node. */
  judge?: BrowserJudgeSpec | Judge<ValueOf<S>>;
  /** Executed in Node. Point it at the same model your backend uses. */
  cloud: CloudRunner<S>;
  /** Applied to inputs before the cloud call, like `privacy.redact` at runtime. */
  redact?: (input: string) => string | Promise<string>;
  /**
   * What the cascade must achieve. `--target` overrides it.
   * - `'cloud'` (default): at least the cloud-only accuracy, with as much local share as that allows.
   *   The cascade then only saves money; it never trades accuracy for it.
   * - `'max'`: the most accurate threshold. Picked on the same data it is scored on, so expect
   *   part of any gain over the cloud to be noise; check it on held-out data.
   * - a number in (0, 1]: a fixed accuracy, which may be below the cloud's.
   */
  target?: number | 'cloud' | 'max';
  /** Enables cost columns and savings in the report, and `costPer1k` / `savingsPer1k` in the file. */
  cost?: CostConfig;
  /** Custom correctness check; defaults to label equality (deep equality for structured tasks). */
  correct?: (value: ValueOf<S>, expected: ValueOf<S>) => boolean;
  /** Fit per-label thresholds. `--per-label` overrides it. */
  perLabel?: boolean;
  /** Model names recorded in the calibration file and report (informational). */
  models?: { local?: string; cloud?: string };
}

/**
 * How to price cloud calls. With `prices`, every call is priced from the token usage its runner
 * reports (see `CloudOutput.usage`), and a cached output without usage is fetched again.
 * `cloudPerRun` is a flat estimate, used for runners that report no usage.
 */
export interface CostConfig {
  currency: string;
  /** Per million tokens; a table keyed by the model id the provider reports, or one price for all. */
  prices?: PriceTable | TokenPrices;
  cloudPerRun?: number;
  /** Volume for the savings projection in the report (editable there). */
  runsPerMonth?: number;
}

export interface BrowserConfig {
  /** Chrome/Chromium executable. Defaults to Playwright's `channel: "chrome"`. */
  executablePath?: string;
  channel?: string;
  /** Unpacked extension directory, e.g. the WebAI Studio extension that polyfills the Classifier API. */
  extension?: string;
  headless?: boolean;
  /**
   * Proxy for the browser (model downloads). Defaults to `HTTPS_PROXY` / `HTTP_PROXY`, which
   * Chrome does not read on its own. `false` disables it. Loopback is always bypassed.
   */
  proxy?: string | false;
  /** Extra Chrome flags. They come last, so they override Belay's. */
  args?: string[];
  /** Chrome features to enable (`--enable-features`), e.g. an API behind a flag. */
  enableFeatures?: string[];
  /**
   * Run Gemini Nano on the CPU (`OnDeviceModelForceCpuBackend`) on machines without a supported
   * GPU. Chrome needs at least 16 GB of RAM and 4 cores for it.
   */
  forceCpu?: boolean;
  /** Persistent profile, so downloaded models survive between runs. Defaults to `<cacheDir>/chrome-profile`. */
  userDataDir?: string;
  /**
   * Runs once after the browser starts and before the harness page loads, e.g. to change an
   * extension setting. Receives the Playwright `BrowserContext`.
   */
  setup?: (context: import('playwright-core').BrowserContext) => Promise<void>;
  /** Per-example timeout for local runs. Defaults to 60 s. */
  timeoutMs?: number;
  /** Timeout for the initial model download / warm-up. Defaults to 30 min. */
  prepareTimeoutMs?: number;
}

export interface BelayConfig {
  tasks: Record<string, CalibrationTaskConfig<any>>;
  browser?: BrowserConfig;
  /** Where cached model outputs and the Chrome profile live. Defaults to `.belay-cache`. */
  cacheDir?: string;
  /** Concurrent cloud requests. Defaults to 4. */
  cloudConcurrency?: number;
}

/** Identity helper for typed config files. */
export function defineConfig(config: BelayConfig): BelayConfig {
  return config;
}

/** Typed helper to declare one task's calibration config with schema-inferred value types. */
export function defineTask<S extends TaskSchema>(config: CalibrationTaskConfig<S>): CalibrationTaskConfig<S> {
  return config;
}

export function isBrowserRunner(local: CalibrationTaskConfig['local']): local is BrowserRunnerSpec {
  return typeof (local as BrowserRunnerSpec).runner === 'string' && typeof (local as LocalRunner).run !== 'function';
}

export function isBrowserJudge(judge: CalibrationTaskConfig['judge']): judge is BrowserJudgeSpec {
  return !!judge && typeof judge === 'object' && (judge as BrowserJudgeSpec).judge === 'classifier-judge';
}
