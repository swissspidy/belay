/**
 * Types for the Prompt API (`LanguageModel`), after the explainer at
 * https://github.com/webmachinelearning/prompt-api (Sep 2026). Only the members Belay uses.
 */

import type { Availability } from '@belay/core';

export interface LanguageModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LanguageModelExpected {
  type: 'text' | 'image' | 'audio';
  languages?: string[];
}

export interface LanguageModelCreateOptions {
  initialPrompts?: LanguageModelMessage[];
  expectedInputs?: LanguageModelExpected[];
  expectedOutputs?: LanguageModelExpected[];
  monitor?: (monitor: EventTarget) => void;
  signal?: AbortSignal;
}

export interface LanguageModelPromptOptions {
  responseConstraint?: Record<string, unknown> | RegExp;
  omitResponseConstraintInput?: boolean;
  signal?: AbortSignal;
}

export interface LanguageModelSession {
  prompt(input: string, options?: LanguageModelPromptOptions): Promise<string>;
  clone?(options?: { signal?: AbortSignal }): Promise<LanguageModelSession>;
  destroy(): void;
}

export interface LanguageModelStatic {
  availability(options?: Omit<LanguageModelCreateOptions, 'monitor' | 'signal' | 'initialPrompts'>): Promise<Availability>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
}
