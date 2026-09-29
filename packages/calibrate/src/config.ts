import type { CloudRunner, Judge, LocalRunner, TaskSchema, ValueOf } from '@belay/core';

/**
 * A local runner executed inside the browser (a real Chrome, via Playwright). Options must be
 * JSON-serializable because they cross into the page.
 */
export interface BrowserRunnerSpec {
  runner: 'classifier-api' | 'prompt-api';
  options?: Record<string, unknown>;
}

/** A judge executed inside the browser, for generation tasks (see @belay/web `classifierJudge`). */
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
  /** Target cascade accuracy. Defaults to 0.95; `--target` overrides it. */
  target?: number;
  /** Enables cost columns in the report and `costPer1k` in the file. */
  cost?: { currency: string; cloudPerRun: number };
  /** Custom correctness check; defaults to label equality (deep equality for structured tasks). */
  correct?: (value: ValueOf<S>, expected: ValueOf<S>) => boolean;
  /** Fit per-label thresholds. `--per-label` overrides it. */
  perLabel?: boolean;
  /** Model names recorded in the calibration file and report (informational). */
  models?: { local?: string; cloud?: string };
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
  /** Extra Chrome flags, e.g. to enable built-in AI features. */
  args?: string[];
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
