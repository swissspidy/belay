import { describe, expectTypeOf, it } from 'vitest';
import { task, type BelayResult } from '../src/index.js';
import { mockCloud, mockLocal } from './helpers.js';

describe('type inference', () => {
  it('infers the value type from the schema', () => {
    const categorical = task({
      name: 't',
      schema: { type: 'categorical', options: ['bug', { label: 'billing' }] as const },
      local: mockLocal({ value: 'bug', confidence: 1 }),
      cloud: mockCloud(),
      threshold: 0.8,
    });
    expectTypeOf(categorical.run).returns.resolves.toEqualTypeOf<BelayResult<'bug' | 'billing'>>();

    const binary = task({ name: 'b', schema: { type: 'binary', prompt: 'q' }, local: mockLocal({ value: true, confidence: 1 }), threshold: 0.5 });
    expectTypeOf(binary.run).returns.resolves.toEqualTypeOf<BelayResult<boolean>>();

    const structured = task({
      name: 's',
      schema: { type: 'structured', jsonSchema: {}, validate: (v: unknown): v is { title: string } => typeof v === 'object' },
      local: mockLocal({ value: {} }),
      judge: async () => 1,
      threshold: 0.5,
    });
    expectTypeOf(structured.run).returns.resolves.toEqualTypeOf<BelayResult<{ title: string }>>();
  });
});
