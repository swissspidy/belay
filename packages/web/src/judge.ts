import type { Judge, PrepareOptions, RunnerContext } from '@belay/core';
import { classifierApi } from './classifier.js';
import type { ClassifierExpectedInput, ClassifierStatic } from './classifier-types.js';

export interface ClassifierJudgeOptions {
  /** The yes/no question the Classifier answers about the (input, output) pair. */
  question?: string;
  /** Shared context for the judge, e.g. what a good answer looks like for this task. */
  context?: string;
  /** Serializes the pair for the Classifier. Defaults to "Input: … / Proposed answer: …". */
  format?: (input: string, value: unknown) => string;
  /** Truncation limits, because on-device classifiers have small windows (e.g. 256 tokens). */
  maxInputChars?: number;
  maxValueChars?: number;
  classifier?: ClassifierStatic;
  expectedInputs?: ClassifierExpectedInput[];
}

export const DEFAULT_JUDGE_QUESTION =
  'Is the proposed answer a correct and complete response to the input, with no invented facts?';

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * A judge for generation tasks built on the Classifier API: one binary question over the input and
 * the generated output. Its calibrated P(true) becomes the confidence (combined with schema
 * validation by the task; see ADR 0001). Costs one classifier forward pass, not a second LLM call.
 */
export function classifierJudge(options: ClassifierJudgeOptions = {}): Judge<unknown> {
  const runner = classifierApi({
    ...(options.classifier ? { classifier: options.classifier } : {}),
    ...(options.expectedInputs ? { expectedInputs: options.expectedInputs } : {}),
    questionId: 'judgement',
  });
  const schema = { type: 'binary' as const, prompt: options.question ?? DEFAULT_JUDGE_QUESTION };
  const maxInput = options.maxInputChars ?? 600;
  const maxValue = options.maxValueChars ?? 400;
  const format =
    options.format ??
    ((input: string, value: unknown) =>
      `Input:\n${truncate(input, maxInput)}\n\nProposed answer:\n${truncate(typeof value === 'string' ? value : JSON.stringify(value), maxValue)}`);
  const ctx = (signal?: AbortSignal): RunnerContext<typeof schema> => ({
    task: 'belay-judge',
    schema,
    ...(options.context ? { context: options.context } : {}),
    ...(signal ? { signal } : {}),
  });

  const judge = (async ({ input, value, signal }) => {
    const out = await runner.run(format(input, value), ctx(signal));
    const pTrue = out.probabilities?.find((p) => p.label === 'true')?.probability;
    if (typeof pTrue === 'number') return pTrue;
    // Fall back to the returned label's probability.
    return out.value === true ? out.confidence! : 1 - out.confidence!;
  }) as Judge<unknown>;
  judge.availability = () => runner.availability(ctx());
  judge.prepare = (prepareOptions?: PrepareOptions) => runner.prepare!(ctx(), prepareOptions);
  judge.destroy = () => runner.destroy?.();
  return judge;
}
