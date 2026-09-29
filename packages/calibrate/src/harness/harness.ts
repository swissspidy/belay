/**
 * Runs inside the calibration browser page. `@belay/core` and `@belay/web` are resolved through
 * an import map served by the calibration CLI, so the page runs exactly the runners apps ship.
 */
import type { Judge, LocalRunner, TaskSchema } from '@belay/core';
import * as web from '@belay/web';

interface HarnessSpec {
  task: string;
  schema: TaskSchema;
  context?: string;
  local: { runner: string; options?: Record<string, unknown> };
  judge?: { judge: string; options?: Record<string, unknown> };
}

type Result<T> = { ok: true; value: T } | { ok: false; error: { name: string; message: string } };

const runners = new Map<string, LocalRunner<any>>();
const judges = new Map<string, Judge<any>>();

function runnerFor(spec: HarnessSpec): LocalRunner<any> {
  const key = JSON.stringify(spec.local);
  let runner = runners.get(key);
  if (!runner) {
    const factories: Record<string, (options: any) => LocalRunner<any>> = {
      'classifier-api': (o) => web.classifierApi(o),
    };
    const promptApi = (web as Record<string, unknown>)['promptApi'];
    if (typeof promptApi === 'function') factories['prompt-api'] = promptApi as (o: any) => LocalRunner<any>;
    const factory = factories[spec.local.runner];
    if (!factory) throw new Error(`Unknown browser runner "${spec.local.runner}"`);
    runner = factory(spec.local.options ?? {});
    runners.set(key, runner);
  }
  return runner;
}

function judgeFor(spec: HarnessSpec): Judge<any> {
  if (!spec.judge) throw new Error('No judge configured');
  const key = JSON.stringify(spec.judge);
  let judge = judges.get(key);
  if (!judge) {
    const factory = (web as Record<string, unknown>)['classifierJudge'];
    if (spec.judge.judge !== 'classifier-judge' || typeof factory !== 'function') {
      throw new Error(`Unknown browser judge "${spec.judge.judge}"`);
    }
    judge = (factory as (o: unknown) => Judge<any>)(spec.judge.options ?? {});
    judges.set(key, judge);
  }
  return judge;
}

const ctxOf = (spec: HarnessSpec) => ({ task: spec.task, schema: spec.schema, ...(spec.context ? { context: spec.context } : {}) });

async function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return { ok: false, error: { name: e.name, message: e.message } };
  }
}

let armed: HarnessSpec | null = null;
let prepared: Promise<Result<void>> | null = null;

const harness = {
  ready: true,
  hasClassifier: () => typeof (globalThis as { Classifier?: unknown }).Classifier !== 'undefined',
  availability: (spec: HarnessSpec) => wrap(() => runnerFor(spec).availability(ctxOf(spec))),
  run: (spec: HarnessSpec, input: string) =>
    wrap(async () => {
      const out = await runnerFor(spec).run(input, ctxOf(spec));
      return { value: out.value, confidence: out.confidence, probabilities: out.probabilities };
    }),
  judge: (spec: HarnessSpec, input: string, value: unknown) =>
    wrap(() => judgeFor(spec)({ input, value, task: spec.task })),
  /** Arms the prepare button; the CLI then clicks it so the download runs under a user gesture. */
  arm(spec: HarnessSpec) {
    armed = spec;
    prepared = null;
  },
  prepareResult: () => prepared,
};

(globalThis as unknown as { belayHarness: typeof harness }).belayHarness = harness;

document.getElementById('prepare')!.addEventListener('click', () => {
  if (!armed) return;
  const spec = armed;
  prepared = wrap(async () => {
    const runner = runnerFor(spec);
    await runner.prepare?.(ctxOf(spec), {
      onProgress: (loaded) => (globalThis as unknown as { __belayProgress?: (n: number) => void }).__belayProgress?.(loaded),
    });
    if (spec.judge) {
      // A judge built on the Classifier API may need its own model: warm it with the same gesture.
      const judge = judgeFor(spec) as Judge<any> & { prepare?: () => Promise<void> };
      await judge.prepare?.();
    }
  });
});
