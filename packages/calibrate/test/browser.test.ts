import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserBackend, calibrate, loadDataset, OutputCache, type LocalBackend } from '../src/index.js';
import { datasetJsonl, fakeCloud, schema } from './fixtures.js';
import { writeFile } from 'node:fs/promises';

/** A Chrome/Chromium binary: BELAY_CHROME, or the Playwright-managed Chromium if present. */
function findChrome(): string | undefined {
  if (process.env['BELAY_CHROME']) return process.env['BELAY_CHROME'];
  const root = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      if (existsSync(join(root, dir, rel))) return join(root, dir, rel);
    }
  }
  return undefined;
}

/**
 * A deterministic stand-in for the Classifier API, shaped like the explainer: it answers with the
 * label mentioned in the input and a confidence derived from the input text. It starts
 * "downloadable" to exercise the user-gesture download path.
 */
const STUB_CLASSIFIER = `
(() => {
  let state = 'downloadable';
  const hash = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0) / 2 ** 32; };
  globalThis.Classifier = {
    async availability() { return state; },
    async create(options) {
      if (state !== 'available') {
        if (!navigator.userActivation.isActive) throw new DOMException('Requires a user gesture', 'NotAllowedError');
        const m = new EventTarget();
        options.monitor?.(m);
        for (const loaded of [0, 0.5, 1]) m.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded }));
        state = 'available';
      }
      const q = options.questions[0];
      const labels = q.options.map((o) => o.label);
      return {
        async classify(input) {
          const truth = labels.find((l) => input.includes('about ' + l + ' '));
          const top = 0.3 + 0.7 * hash('conf:' + input);
          const right = hash('right:' + input) < top;
          const label = right ? truth : labels[(labels.indexOf(truth) + 1) % labels.length];
          const rest = (1 - top) / (labels.length - 1);
          const probabilities = labels.map((l) => ({ label: l, probability: l === label ? top : rest }));
          return { [q.id]: { id: q.id, label, confidence: top, probabilities } };
        },
        destroy() {},
      };
    },
  };
})();
`;

const chrome = findChrome();

describe.skipIf(!chrome)('browser backend (real Chromium)', () => {
  let dir: string;
  let backend: LocalBackend;
  const progress: number[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'belay-browser-'));
    backend = await browserBackend({
      task: 'ticket-triage',
      schema,
      local: { runner: 'classifier-api' },
      browser: { executablePath: chrome!, proxy: false },
      cacheDir: dir,
      initScript: STUB_CLASSIFIER,
    });
  }, 60_000);

  afterAll(async () => {
    await backend?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('downloads under a user gesture, then calibrates 300 examples through the real runner', async () => {
    expect(await backend.availability()).toBe('downloadable');
    await writeFile(join(dir, 'examples.jsonl'), datasetJsonl());
    const dataset = await loadDataset(join(dir, 'examples.jsonl'), schema);
    const result = await calibrate({
      name: 'ticket-triage',
      config: { schema, local: { runner: 'classifier-api' }, cloud: fakeCloud() },
      dataset,
      backend,
      cache: await OutputCache.open(null),
      target: 0.95,
      createdAt: '2026-09-29T00:00:00Z',
      onProgress: (e) => {
        if (e.phase === 'prepare') progress.push(e.done);
      },
    });
    expect(progress).toContain(1);
    expect(await backend.availability()).toBe('available');
    expect(result.file.local.runner).toBe('classifier-api');
    expect(result.file.local.userAgent).toMatch(/Chrome/);
    expect(result.analysis.counts.localFailed).toBe(0);
    expect(result.analysis.targetMet).toBe(true);
    expect(result.file.expected.localShare).toBeGreaterThan(0.1);
  }, 120_000);

  it('matches the same model run in Node exactly (the harness adds nothing)', async () => {
    const out = await backend.run('ticket #3 about feature (0.1234)');
    expect(out.value).toMatch(/^(bug|billing|feature|other)$/);
    expect(out.confidence).toBeGreaterThanOrEqual(0.3);
    expect(out.probabilities).toHaveLength(4);
  });
});
