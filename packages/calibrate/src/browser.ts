import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Availability, LocalOutput, TaskSchema } from '@belay/core';
import type { BrowserConfig, BrowserJudgeSpec, BrowserRunnerSpec } from './config.js';
import type { LocalBackend } from './evaluate.js';

export interface BrowserBackendOptions {
  task: string;
  schema: TaskSchema;
  context?: string;
  local: BrowserRunnerSpec;
  judge?: BrowserJudgeSpec;
  browser?: BrowserConfig;
  cacheDir: string;
  log?: (message: string) => void;
  /** Injected in tests: a script evaluated in the page before any other script (e.g. a stub `Classifier`). */
  initScript?: string;
}

type HarnessResult<T> = { ok: true; value: T } | { ok: false; error: { name: string; message: string } };

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
};

function packageDir(specifier: string): string {
  return dirname(fileURLToPath(import.meta.resolve(specifier)));
}

/** Directory holding the compiled harness (`dist/harness`), from both `src/` (tests) and `dist/`. */
function harnessDir(): string {
  return fileURLToPath(new URL('../dist/harness/', import.meta.url));
}

const HARNESS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Belay calibration harness</title>
<script type="importmap">{"imports":{"@belay/core":"/belay/core/index.js","@belay/web":"/belay/web/index.js"}}</script>
</head><body>
<p>Belay calibration harness. This page is driven by <code>belay calibrate</code>.</p>
<button id="prepare" type="button">Download model</button>
<script type="module" src="/harness/harness.js"></script>
</body></html>`;

/** Serves the harness page and the built @belay/core and @belay/web modules on 127.0.0.1 (a secure context). */
async function startServer(): Promise<{ server: Server; origin: string }> {
  const roots: Record<string, string> = {
    '/belay/core/': packageDir('@belay/core'),
    '/belay/web/': packageDir('@belay/web'),
    '/harness/': harnessDir(),
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/' || url.pathname === '/harness.html') {
      res.writeHead(200, { 'content-type': MIME['.html']! }).end(HARNESS_HTML);
      return;
    }
    for (const [prefix, root] of Object.entries(roots)) {
      if (!url.pathname.startsWith(prefix)) continue;
      const file = normalize(join(root, decodeURIComponent(url.pathname.slice(prefix.length))));
      if (!file.startsWith(resolve(root) + sep)) break;
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
      return;
    }
    res.writeHead(404).end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not start the harness server');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function unwrap<T>(result: HarnessResult<T>): T {
  if (result.ok) return result.value;
  const err = new Error(result.error.message);
  err.name = result.error.name;
  throw err;
}

/**
 * Runs a browser runner inside a real Chrome through a Playwright persistent context, optionally
 * with an unpacked extension (the WebAI Studio extension polyfills the Classifier API). The
 * profile persists in the cache directory, so a downloaded model is reused across runs.
 */
export async function browserBackend(options: BrowserBackendOptions): Promise<LocalBackend> {
  const { browser = {}, log = () => {} } = options;
  let playwright: typeof import('playwright-core');
  try {
    playwright = await import('playwright-core');
  } catch {
    throw new Error('Browser runners need playwright-core: npm install --save-dev playwright-core');
  }

  const { server, origin } = await startServer();
  const args = [...(browser.args ?? [])];
  const extension = browser.extension ? resolve(browser.extension) : undefined;
  if (extension) args.push(`--disable-extensions-except=${extension}`, `--load-extension=${extension}`);
  const userDataDir = resolve(browser.userDataDir ?? join(options.cacheDir, 'chrome-profile'));
  const executablePath = browser.executablePath ?? process.env['BELAY_CHROME'];

  const proxy =
    browser.proxy === false ? undefined : (browser.proxy ?? process.env['HTTPS_PROXY'] ?? process.env['https_proxy'] ?? process.env['HTTP_PROXY']);

  let context: import('playwright-core').BrowserContext;
  try {
    context = await playwright.chromium.launchPersistentContext(userDataDir, {
      headless: browser.headless ?? true,
      ...(executablePath ? { executablePath } : { channel: browser.channel ?? 'chrome' }),
      args,
      ...(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {}),
      ...(extension ? { ignoreDefaultArgs: ['--disable-extensions'] } : {}),
    });
  } catch (err) {
    server.close();
    throw err;
  }

  const close = async () => {
    await context.close().catch(() => {});
    await new Promise((r) => server.close(r));
  };

  try {
    if (options.initScript) await context.addInitScript(options.initScript);
    await browser.setup?.(context);
    const page = context.pages()[0] ?? (await context.newPage());
    let progress: ((loaded: number) => void) | undefined;
    await page.exposeFunction('__belayProgress', (loaded: number) => progress?.(loaded));
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') log(`[browser] ${msg.text()}`);
    });
    await page.goto(`${origin}/harness.html`);
    await page.waitForFunction(() => (globalThis as { belayHarness?: { ready: boolean } }).belayHarness?.ready === true, null, { timeout: 30_000 });

    // Extensions inject their polyfill at document_start, but give a slow extension a moment.
    if (options.local.runner === 'classifier-api') {
      await page
        .waitForFunction(() => typeof (globalThis as { Classifier?: unknown }).Classifier !== 'undefined', null, { timeout: extension ? 10_000 : 1_000 })
        .catch(() => log('window.Classifier is not defined in the calibration browser'));
    }

    const { schema } = options;
    const spec = {
      task: options.task,
      // Functions (structured `validate`) cannot cross into the page; the runners don't need them.
      schema: JSON.parse(JSON.stringify(schema)) as TaskSchema,
      ...(options.context ? { context: options.context } : {}),
      local: options.local,
      ...(options.judge ? { judge: options.judge } : {}),
    };
    type H = {
      availability(s: typeof spec): Promise<HarnessResult<Availability>>;
      run(s: typeof spec, input: string): Promise<HarnessResult<LocalOutput>>;
      judge(s: typeof spec, input: string, value: unknown): Promise<HarnessResult<number>>;
      arm(s: typeof spec): void;
      prepareResult(): Promise<HarnessResult<void>> | null;
    };
    const timeoutMs = browser.timeoutMs ?? 60_000;

    return {
      spec: { browser: options.local, judge: options.judge ?? null, extension: extension ? 'extension' : null },
      async info() {
        const userAgent = await page.evaluate(() => navigator.userAgent);
        return { runner: options.local.runner, userAgent };
      },
      async availability() {
        return unwrap(await page.evaluate(([s]) => (globalThis as unknown as { belayHarness: H }).belayHarness.availability(s), [spec] as const));
      },
      async prepare(onProgress) {
        progress = onProgress;
        await page.evaluate(([s]) => (globalThis as unknown as { belayHarness: H }).belayHarness.arm(s), [spec] as const);
        await page.click('#prepare'); // a real user gesture, as Chrome requires for model downloads
        const result = await withTimeout(
          page.evaluate(async () => {
            const harness = (globalThis as unknown as { belayHarness: H }).belayHarness;
            while (!harness.prepareResult()) await new Promise((r) => setTimeout(r, 50));
            return harness.prepareResult()!;
          }),
          browser.prepareTimeoutMs ?? 30 * 60_000,
          'model download',
        );
        unwrap(result);
      },
      async run(input) {
        return unwrap(
          await withTimeout(
            page.evaluate(([s, i]) => (globalThis as unknown as { belayHarness: H }).belayHarness.run(s, i), [spec, input] as const),
            timeoutMs,
            'local run',
          ),
        );
      },
      ...(options.judge
        ? {
            judge: async (input: string, value: unknown) =>
              unwrap(
                await withTimeout(
                  page.evaluate(([s, i, v]) => (globalThis as unknown as { belayHarness: H }).belayHarness.judge(s, i, v), [spec, input, value] as const),
                  timeoutMs,
                  'judge',
                ),
              ),
          }
        : {}),
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

