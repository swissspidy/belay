/**
 * Types for Chrome's built-in classifier, the DecisionModel API (`window.DecisionModel`), as
 * Chrome 157 implements it behind the `AIDecisionModelAPI` feature and as the WebAI Studio
 * extension polyfills it (https://web-ai.studio/docs/classifier). It was proposed as the
 * Classifier API (https://github.com/michaelwasserman/classifier-api); Belay's names
 * (`classifierApi()`, these types) still say so. Only the members Belay relies on are typed, and
 * result fields are checked at runtime. See ADR 0008.
 */

import type { Availability } from '@swissspidy/belay-core';

/** `boolean`: yes/no. `choice`: one of the options. `score`: one of the ordered options. */
export type ClassifierQuestionType = 'boolean' | 'choice' | 'score';

export interface ClassifierOption {
  label: string;
  description?: string;
}

export interface ClassifierQuestion {
  id: string;
  type: ClassifierQuestionType;
  prompt: string;
  /** Not allowed on `boolean` questions. */
  options?: ClassifierOption[];
}

export interface ClassifierExpectedInput {
  type: 'text';
  languages?: string[];
}

export interface ClassifierSchema {
  context?: string;
  questions: ClassifierQuestion[];
  expectedInputs?: ClassifierExpectedInput[];
}

export interface ClassifierCreateOptions extends ClassifierSchema {
  /** Same pattern as the other built-in AI APIs: `downloadprogress` events carry `loaded` in [0, 1]. */
  monitor?: (monitor: EventTarget) => void;
  signal?: AbortSignal;
}

export interface ClassifierClassifyOptions {
  signal?: AbortSignal;
  context?: string;
}

export interface ClassifierProbability {
  label: string;
  probability: number;
}

export interface ClassifierDecision {
  id: string;
  /** The chosen option; "true" or "false" for a `boolean` question. */
  label: string;
  /** Calibrated confidence in [0, 1]: the probability of `label`. */
  confidence: number;
  /** `score` questions only: E[S]. */
  expectedScore?: number;
  /** Probability per label, keyed by label ("true" and "false" for a `boolean` question). */
  probabilities?: Record<string, number>;
}

/** Keyed by question `id`. */
export type ClassifierResult = Record<string, ClassifierDecision>;

export interface ClassifierInstance {
  decide(input: string, options?: ClassifierClassifyOptions): Promise<ClassifierResult>;
  destroy(): void;
}

/** The shape of `globalThis.DecisionModel`. */
export interface ClassifierStatic {
  availability(options?: ClassifierSchema): Promise<Availability>;
  create(options: ClassifierCreateOptions): Promise<ClassifierInstance>;
}
