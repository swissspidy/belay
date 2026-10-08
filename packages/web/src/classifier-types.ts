/**
 * Types for the proposed Classifier API (`window.Classifier`), as described in the explainer
 * (https://github.com/michaelwasserman/classifier-api, the current revision of
 * explainers-by-googlers/classifier-api) and implemented by Chrome behind `#classifier-api` and by
 * the WebAI Studio extension polyfill (https://web-ai.studio/docs/classifier). The proposal is in
 * flux: only the members Belay relies on are typed, and result fields are checked at runtime.
 */

import type { Availability } from '@swissspidy/belay-core';

export type ClassifierQuestionType = 'binary' | 'categorical' | 'ordinal';

export interface ClassifierOption {
  label: string;
  description?: string;
}

export interface ClassifierQuestion {
  id: string;
  type: ClassifierQuestionType;
  prompt: string;
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
  label: string;
  /** Calibrated confidence in [0, 1]. */
  confidence: number;
  /** Binary questions only: calibrated P(true). */
  probability?: number;
  /** Ordinal questions only: E[S]. */
  expectedScore?: number;
  probabilities?: ClassifierProbability[];
}

/** Keyed by question `id`. */
export type ClassifierResult = Record<string, ClassifierDecision>;

export interface ClassifierInstance {
  classify(input: string, options?: ClassifierClassifyOptions): Promise<ClassifierResult>;
  destroy(): void;
}

export interface ClassifierStatic {
  availability(options?: ClassifierSchema): Promise<Availability>;
  create(options: ClassifierCreateOptions): Promise<ClassifierInstance>;
}
