import { browserBackend } from './browser.js';
import { isBrowserJudge, isBrowserRunner, type BelayConfig, type BrowserRunnerSpec, type CalibrationTaskConfig } from './config.js';
import { nodeBackend, type LocalBackend } from './evaluate.js';
import type { LocalRunner } from '@swissspidy/belay-core';

export interface CreateBackendOptions {
  name: string;
  taskConfig: CalibrationTaskConfig<any> & { local: BrowserRunnerSpec | LocalRunner<any> };
  /** The whole config, for its `browser` settings. */
  config: Pick<BelayConfig, 'browser'>;
  /** Where the Chrome profile lives. */
  cacheDir: string;
  /** Overrides of the config's browser settings, as the CLI flags set them. */
  extension?: string;
  executablePath?: string;
  headed?: boolean;
  log?: (message: string) => void;
}

/** The local backend of a task config: a real Chrome for a browser runner spec, Node for a runner object. */
export async function createBackend(options: CreateBackendOptions): Promise<LocalBackend> {
  const { name, taskConfig, config, cacheDir } = options;
  const judge = taskConfig.judge;
  if (isBrowserRunner(taskConfig.local)) {
    const browser = { ...config.browser };
    if (options.extension) browser.extension = options.extension;
    if (options.executablePath) browser.executablePath = options.executablePath;
    if (options.headed) browser.headless = false;
    if (judge && !isBrowserJudge(judge)) throw new Error('a browser runner needs a browser judge ({ judge: "classifier-judge" })');
    return browserBackend({
      task: name,
      schema: taskConfig.schema,
      ...(taskConfig.context ? { context: taskConfig.context } : {}),
      local: taskConfig.local,
      ...(judge ? { judge } : {}),
      browser,
      cacheDir,
      ...(options.log ? { log: options.log } : {}),
    });
  }
  if (judge && isBrowserJudge(judge)) throw new Error('a Node runner needs a judge function, not a browser judge spec');
  return nodeBackend(taskConfig.local, { task: name, schema: taskConfig.schema, ...(taskConfig.context ? { context: taskConfig.context } : {}) }, judge);
}
