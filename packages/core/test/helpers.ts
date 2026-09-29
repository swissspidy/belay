import { vi } from 'vitest';
import type { Availability, CloudRequest, CloudRunner, LocalOutput, LocalRunner, RunnerContext, TaskSchema } from '../src/index.js';

export const triageSchema = {
  type: 'categorical',
  options: ['bug', 'billing', 'feature', 'other'],
} as const satisfies TaskSchema;

export function mockLocal<S extends TaskSchema = TaskSchema>(
  output: LocalOutput | ((input: string, ctx?: RunnerContext) => LocalOutput | Promise<LocalOutput>),
  availability: Availability = 'available',
) {
  const runner = {
    id: 'mock-local',
    availability: vi.fn(async () => availability),
    run: vi.fn(async (input: string, ctx?: RunnerContext): Promise<LocalOutput> => (typeof output === 'function' ? output(input, ctx) : output)),
    prepare: vi.fn(async () => {}),
    destroy: vi.fn(),
  };
  return runner as typeof runner & LocalRunner<S>;
}

export function mockCloud<S extends TaskSchema = TaskSchema>(value: unknown = 'billing') {
  const runner = {
    id: 'mock-cloud',
    run: vi.fn(async (_request: CloudRequest, _options: { signal?: AbortSignal }) => ({ value })),
  };
  return runner as typeof runner & CloudRunner<S>;
}

/** Deterministic PRNG (mulberry32) so property-style tests are reproducible. */
export function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
