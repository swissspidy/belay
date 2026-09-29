import { describe, expect, it } from 'vitest';
import { optionLabels } from '@belay/core';
import { loadDataset, type BelayConfig } from '@belay/calibrate';

const examples = [
  { dir: 'ticket-triage', task: 'ticket-triage' },
  { dir: 'content-moderation', task: 'content-moderation' },
  { dir: 'intent-detection', task: 'intent-detection' },
];

describe.each(examples)('$dir', ({ dir, task }) => {
  it('has a config whose dataset parses against the schema: 300 examples, balanced labels', async () => {
    process.env['BELAY_CLOUD'] ??= 'reference'; // no credentials needed to load the config
    const config = ((await import(`../${dir}/belay.config.mjs`)) as { default: BelayConfig }).default;
    const taskConfig = config.tasks[task]!;
    expect(taskConfig).toBeDefined();
    const dataset = await loadDataset(new URL(`../${dir}/examples.jsonl`, import.meta.url).pathname, taskConfig.schema);
    expect(dataset.examples).toHaveLength(300);
    const counts = new Map<string, number>();
    for (const e of dataset.examples) counts.set(e.truth, (counts.get(e.truth) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual([...optionLabels(taskConfig.schema)].sort());
    const sizes = [...counts.values()];
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(new Set(dataset.examples.map((e) => e.input.toLowerCase())).size).toBe(300);
  });
});
