import { describe, expect, it, vi } from 'vitest';
import { task, type Availability, type CloudRunner } from '@belay/core';
import {
  classifierJudge,
  DEFAULT_JUDGE_QUESTION,
  promptApi,
  type ClassifierCreateOptions,
  type ClassifierStatic,
  type LanguageModelCreateOptions,
  type LanguageModelPromptOptions,
  type LanguageModelStatic,
} from '../src/index.js';

function fakeLanguageModel(answer: (input: string) => string, initial: Availability = 'available', withClone = true) {
  let state: Availability = initial;
  const prompts: { system: string | undefined; input: string; options: LanguageModelPromptOptions | undefined }[] = [];
  const destroyed: number[] = [];
  let ids = 0;
  const makeSession = (system: string | undefined): any => {
    const id = ++ids;
    const history: string[] = [];
    return {
      id,
      history,
      async prompt(input: string, options?: LanguageModelPromptOptions) {
        history.push(input);
        prompts.push({ system, input, options });
        return answer(input);
      },
      ...(withClone ? { clone: async () => makeSession(system) } : {}),
      destroy: () => destroyed.push(id),
    };
  };
  const api = {
    availability: vi.fn(async () => state),
    create: vi.fn(async (options: LanguageModelCreateOptions = {}) => {
      if (state !== 'available') {
        const m = new EventTarget();
        options.monitor?.(m);
        m.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 1 }));
        state = 'available';
      }
      return makeSession(options.initialPrompts?.[0]?.content);
    }),
  };
  return { api: api satisfies LanguageModelStatic, prompts, destroyed };
}

/** A Classifier whose binary P(true) is looked up from the text being judged. */
function fakeJudgeClassifier(pTrue: (text: string) => number) {
  const created: ClassifierCreateOptions[] = [];
  const api: ClassifierStatic = {
    availability: vi.fn(async () => 'available' as const),
    create: vi.fn(async (options: ClassifierCreateOptions) => {
      created.push(options);
      return {
        classify: async (text: string) => {
          const p = pTrue(text);
          return { judgement: { id: 'judgement', label: p >= 0.5 ? 'true' : 'false', probability: p, confidence: Math.max(p, 1 - p) } };
        },
        destroy: () => {},
      };
    }),
  };
  return { api, created };
}

const summarySchema = {
  type: 'structured' as const,
  prompt: 'Summarize the support ticket.',
  jsonSchema: {
    type: 'object',
    properties: { title: { type: 'string' }, urgent: { type: 'boolean' } },
    required: ['title', 'urgent'],
  },
  validate: (v: unknown): v is { title: string; urgent: boolean } =>
    !!v && typeof (v as { title?: unknown }).title === 'string' && typeof (v as { urgent?: unknown }).urgent === 'boolean',
};

describe('promptApi runner', () => {
  const ctx = { task: 'summarize', schema: summarySchema, context: 'SaaS support desk' };

  it('prompts a fresh clone with the JSON Schema as responseConstraint', async () => {
    const { api, prompts, destroyed } = fakeLanguageModel(() => '{"title":"Crash on save","urgent":true}');
    const runner = promptApi({ languageModel: api });
    const out = await runner.run('App crashes on save!', ctx);
    expect(out).toMatchObject({ value: { title: 'Crash on save', urgent: true } });
    expect(out.confidence).toBeUndefined();
    expect(prompts[0]!.options?.responseConstraint).toEqual(summarySchema.jsonSchema);
    expect(prompts[0]!.system).toContain('SaaS support desk');
    expect(prompts[0]!.system).toContain('Summarize the support ticket.');
    await runner.run('second', ctx);
    expect(api.create).toHaveBeenCalledTimes(1); // one base session
    expect(destroyed).toHaveLength(2); // each clone destroyed after its run
  });

  it('returns unparseable text as-is (the task reports invalid output)', async () => {
    const { api } = fakeLanguageModel(() => 'Sure! Here is a summary');
    expect((await promptApi({ languageModel: api }).run('x', ctx)).value).toBe('Sure! Here is a summary');
  });

  it('wraps categorical outputs like the cloud JSON Schema', async () => {
    const { api, prompts } = fakeLanguageModel(() => '{"value":"billing"}');
    const schema = { type: 'categorical' as const, options: ['bug', 'billing'] };
    const out = await promptApi({ languageModel: api, omitResponseConstraintInput: true }).run('charged twice', { task: 't', schema });
    expect(out.value).toEqual({ value: 'billing' });
    expect(prompts[0]!.options).toMatchObject({ omitResponseConstraintInput: true, responseConstraint: { properties: { value: { enum: ['bug', 'billing'] } } } });
  });

  it('never creates (downloads) from run(); prepare() does, with progress', async () => {
    const { api } = fakeLanguageModel(() => '{"title":"x","urgent":false}', 'downloadable');
    const runner = promptApi({ languageModel: api });
    await expect(runner.run('x', ctx)).rejects.toMatchObject({ name: 'LocalUnavailableError' });
    expect(api.create).not.toHaveBeenCalled();
    const progress: number[] = [];
    await runner.prepare!(ctx, { onProgress: (p) => progress.push(p) });
    expect(progress).toEqual([1]);
    expect((await runner.run('x', ctx)).value).toEqual({ title: 'x', urgent: false });
  });

  it('falls back to a new session per run without clone()', async () => {
    const { api } = fakeLanguageModel(() => '{"title":"x","urgent":false}', 'available', false);
    const runner = promptApi({ languageModel: api });
    await runner.run('a', ctx);
    await runner.run('b', ctx);
    expect(api.create).toHaveBeenCalledTimes(3);
  });

  it('is unavailable without the API', async () => {
    expect(await promptApi().availability(ctx)).toBe('unavailable');
  });
});

describe('classifierJudge', () => {
  it('asks one binary question about the (input, output) pair and returns P(true)', async () => {
    const { api, created } = fakeJudgeClassifier(() => 0.83);
    const judge = classifierJudge({ classifier: api, context: 'Ticket summaries' });
    const p = await judge({ input: 'App crashes', value: { title: 'Crash', urgent: true }, task: 't' });
    expect(p).toBe(0.83);
    expect(created[0]).toMatchObject({
      context: 'Ticket summaries',
      questions: [{ id: 'judgement', type: 'binary', prompt: DEFAULT_JUDGE_QUESTION }],
    });
    expect(await judge.availability!()).toBe('available');
  });

  it('truncates long inputs and outputs for small context windows', async () => {
    const seen: string[] = [];
    const { api } = fakeJudgeClassifier((text) => {
      seen.push(text);
      return 0.5;
    });
    await classifierJudge({ classifier: api, maxInputChars: 20, maxValueChars: 10 })({ input: 'x'.repeat(100), value: 'y'.repeat(100), task: 't' });
    expect(seen[0]).toBe(`Input:\n${'x'.repeat(19)}…\n\nProposed answer:\n${'y'.repeat(9)}…`);
  });
});

describe('generation task: Prompt API + schema validation + classifier judge', () => {
  it('keeps judged-good outputs local, escalates doubtful and invalid ones', async () => {
    const outputs: Record<string, string> = {
      'App crashes on save': '{"title":"Crash on save","urgent":true}',
      'Can I get an invoice copy?': '{"title":"Invoice","urgent":"no"}', // invalid: urgent not boolean
      'Something weird': '{"title":"Unclear request","urgent":false}',
    };
    const { api } = fakeLanguageModel((input) => outputs[input]!);
    const { api: classifier } = fakeJudgeClassifier((text) => (text.includes('Unclear') ? 0.35 : 0.92));
    const cloud: CloudRunner = { id: 'cloud', run: vi.fn(async () => ({ value: { title: 'From cloud', urgent: false } })) };
    const summarize = task({
      name: 'summarize',
      schema: summarySchema,
      local: promptApi({ languageModel: api }),
      judge: classifierJudge({ classifier }),
      cloud,
      threshold: 0.8,
    });

    expect(await summarize.run('App crashes on save')).toMatchObject({ source: 'local', confidence: 0.92, value: { title: 'Crash on save', urgent: true } });
    expect(await summarize.run('Can I get an invoice copy?')).toMatchObject({ source: 'cloud', escalationReason: 'invalid-output' });
    expect(await summarize.run('Something weird')).toMatchObject({ source: 'cloud', escalationReason: 'low-confidence', local: { confidence: 0.35 } });
    expect(cloud.run).toHaveBeenCalledTimes(2);
  });

  it('task.availability() and prepare() cover the judge model too', async () => {
    const { api } = fakeLanguageModel(() => '{}');
    const judgeState = { value: 'downloadable' as Availability };
    const classifier: ClassifierStatic = {
      availability: async () => judgeState.value,
      create: vi.fn(async () => {
        judgeState.value = 'available';
        return { classify: async () => ({}), destroy: () => {} };
      }),
    };
    const t = task({ name: 's', schema: summarySchema, local: promptApi({ languageModel: api }), judge: classifierJudge({ classifier }), threshold: 0.5 });
    expect(await t.availability()).toBe('downloadable');
    await t.prepare();
    expect(await t.availability()).toBe('available');
  });
});
