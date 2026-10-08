import { LocalUnavailableError, buildInstruction, toJsonSchema } from '@swissspidy/belay-core';
import type { Availability, LocalOutput, LocalRunner, PrepareOptions, RunnerContext, TaskSchema } from '@swissspidy/belay-core';
import type { LanguageModelCreateOptions, LanguageModelExpected, LanguageModelSession, LanguageModelStatic } from './prompt-types.js';

export interface PromptApiOptions {
  /** System prompt. Defaults to the task instruction from `buildInstruction(schema, context)`. */
  systemPrompt?: string | ((ctx: RunnerContext<TaskSchema>) => string);
  /** Defaults to English text in and out. */
  expectedInputs?: LanguageModelExpected[];
  expectedOutputs?: LanguageModelExpected[];
  /** Keep the JSON Schema out of the model's context window (the system prompt already describes the format). */
  omitResponseConstraintInput?: boolean;
  /** The `LanguageModel` implementation. Defaults to `globalThis.LanguageModel`. */
  languageModel?: LanguageModelStatic;
  /** Max number of cached base sessions (one per distinct system prompt). Defaults to 4. */
  maxSessions?: number;
}

type Ctx = RunnerContext<TaskSchema>;

/**
 * Local runner backed by the Prompt API with structured output (`responseConstraint`). It reports
 * no confidence of its own: pair it with a task `judge` (e.g. `classifierJudge()`), and the output
 * is validated against the schema before the judge sees it.
 *
 * Every run prompts a clone of a base session, so runs never see each other's history. Like
 * `classifierApi()`, `run()` never triggers a model download; call `task.prepare()` from a click.
 */
export function promptApi(options: PromptApiOptions = {}): LocalRunner<any> {
  const maxSessions = Math.max(1, options.maxSessions ?? 4);
  const sessions = new Map<string, Promise<LanguageModelSession>>();
  const expected = {
    expectedInputs: options.expectedInputs ?? [{ type: 'text' as const, languages: ['en'] }],
    expectedOutputs: options.expectedOutputs ?? [{ type: 'text' as const, languages: ['en'] }],
  };

  const api = (): LanguageModelStatic | undefined =>
    options.languageModel ?? (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel;

  const systemPromptFor = (ctx: Ctx): string =>
    typeof options.systemPrompt === 'function'
      ? options.systemPrompt(ctx)
      : (options.systemPrompt ?? buildInstruction(ctx.schema, ctx.context));

  function session(ctx: Ctx, prepare?: PrepareOptions): Promise<LanguageModelSession> {
    const LanguageModel = api();
    if (!LanguageModel) return Promise.reject(new LocalUnavailableError('Prompt API is not available'));
    const key = systemPromptFor(ctx);
    const cached = sessions.get(key);
    if (cached) {
      sessions.delete(key);
      sessions.set(key, cached);
      return cached;
    }
    // Only prepare()'s signal: the session is cached and shared, so a per-run abort must not destroy it.
    const signal = prepare?.signal;
    const createOptions: LanguageModelCreateOptions = {
      ...expected,
      initialPrompts: [{ role: 'system', content: key }],
      ...(signal ? { signal } : {}),
      ...(prepare?.onProgress
        ? {
            monitor: (m: EventTarget) =>
              m.addEventListener('downloadprogress', (e) => prepare.onProgress!((e as Event & { loaded: number }).loaded)),
          }
        : {}),
    };
    const created = LanguageModel.create(createOptions);
    sessions.set(key, created);
    created.catch(() => {
      if (sessions.get(key) === created) sessions.delete(key);
    });
    while (sessions.size > maxSessions) {
      const [oldestKey, oldest] = sessions.entries().next().value as [string, Promise<LanguageModelSession>];
      sessions.delete(oldestKey);
      oldest.then((s) => s.destroy(), () => {});
    }
    return created;
  }

  async function availability(ctx: Ctx): Promise<Availability> {
    const LanguageModel = api();
    if (!LanguageModel) return 'unavailable';
    if (sessions.has(systemPromptFor(ctx))) return 'available';
    try {
      return await LanguageModel.availability(expected);
    } catch {
      return 'unavailable';
    }
  }

  return {
    id: 'prompt-api',
    availability,

    async run(input: string, ctx: Ctx): Promise<LocalOutput> {
      if (!sessions.has(systemPromptFor(ctx))) {
        const state = await availability(ctx);
        if (state !== 'available') throw new LocalUnavailableError(`Prompt API model is ${state}`);
      }
      const base = await session(ctx);
      // A fresh clone per run keeps runs independent. Without clone(), fall back to a new session.
      const LanguageModel = api()!;
      const turn = base.clone
        ? await base.clone(ctx.signal ? { signal: ctx.signal } : {})
        : await LanguageModel.create({ ...expected, initialPrompts: [{ role: 'system', content: systemPromptFor(ctx) }], ...(ctx.signal ? { signal: ctx.signal } : {}) });
      try {
        const text = await turn.prompt(input, {
          responseConstraint: toJsonSchema(ctx.schema),
          ...(options.omitResponseConstraintInput ? { omitResponseConstraintInput: true } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        let value: unknown = text;
        try {
          value = JSON.parse(text);
        } catch {
          // Leave the raw text: the task's schema validation reports it as invalid output.
        }
        return { value, raw: text };
      } finally {
        turn.destroy();
      }
    },

    async prepare(ctx: Ctx, prepareOptions?: PrepareOptions) {
      const state = await availability(ctx);
      if (state === 'unavailable') throw new LocalUnavailableError('Prompt API model is unavailable on this device');
      await session(ctx, prepareOptions);
    },

    destroy() {
      for (const s of sessions.values()) s.then((c) => c.destroy(), () => {});
      sessions.clear();
    },
  };
}

