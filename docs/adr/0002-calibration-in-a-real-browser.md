# ADR 0002: Calibration runs the shipped runners in a real browser

- Status: Accepted
- Date: 2026-09-29
- Scope: `@swissspidy/belay-calibrate`, `@swissspidy/belay-web`

## Context

A calibration file is only valid for the exact local model, runner code and schema it was
measured with (ADR 0001, Decision 4). The local model lives in the browser: Chrome's built-in APIs,
or the WebAI Studio extension, which polyfills `window.Classifier` with Laya on LiteRT.js.
Calibration therefore has to drive a browser. That raises three questions: which code runs in the
page, how the model download gets its user gesture, and how to keep runs reproducible when cloud
models are not deterministic.

## Decisions

### 1. The page runs the published `@swissspidy/belay-web` runners, unmodified

`belay calibrate` starts a small HTTP server on `127.0.0.1` (a secure context, so built-in AI APIs
and extensions work) and serves:

- `harness.html`, whose import map points `@swissspidy/belay-core` and `@swissspidy/belay-web` at the built `dist/`
  folders;
- `harness.js`, a thin wrapper that instantiates `classifierApi()`, `promptApi()` or
  `classifierJudge()` from JSON options and exposes `run`, `judge`, `availability` and `prepare`.

Node calls those through Playwright's `page.evaluate`. The confidence recorded in a calibration
file is therefore computed by the same code as in production, including `readDecision()`'s
choice of the label probability. The confidence combination (`combineConfidence`) and schema
validation (`parseValue`) run in Node from `@swissspidy/belay-core`, the same functions `task()` uses. A test
asserts that replaying a calibrated threshold through `task()` reproduces the file's expected
accuracy and local share exactly.

Local runners can also be plain `LocalRunner` objects executed in Node (mocks, replays, runners
for other environments). The pipeline treats both kinds identically.

### 2. Downloads happen under a real click, in a persistent profile

Runners never download from `run()` (ADR 0001). Calibration needs the model, so the CLI arms the
harness and then `page.click()`s a button. That is a real user activation, which is what Chrome
requires for model downloads. Progress events are forwarded to the terminal. The Chrome profile
lives in `.belay-cache/chrome-profile`, so the model (and the extension's OPFS cache) survives
between runs.

### 3. Cloud runners run in Node

The cloud side of a calibration is whatever the app's backend calls, so it runs in Node with
the app's credentials. It is never exposed to the page. Requests go out concurrently (default 4),
with retries.

### 4. Every model output is cached

Outputs are appended to `.belay-cache/<task>.outputs.jsonl`. Each entry is keyed by a hash of:

- the side (local or cloud);
- the task name;
- the runner spec (including extension and judge);
- the schema fingerprint;
- the context;
- the (redacted) input;
- for cloud entries, the local guess sent along.

A re-run replays the cache, so the same dataset gives a byte-identical calibration file. Pin
`createdAt` with `--created-at` or `SOURCE_DATE_EPOCH`. Failures are not cached (they are usually
transient). `--refresh local|cloud|all` re-queries a side.

### 5. The browser gets the environment's proxy

Chrome ignores `HTTPS_PROXY`. The backend passes it as Playwright's `proxy` option (loopback
bypassed, so the harness stays reachable). Behind a TLS-intercepting proxy, Chrome also needs the
proxy CA in its trust store (NSS on Linux). Belay never disables certificate checks.

### 6. `setup` hook for browser preparation

`browser.setup(context)` runs after launch and before the harness loads, for example to select
a WebAI Studio model variant through the extension's settings message (`selectVariant()` in
`examples/shared/extension.mjs`).

### 7. Without cloud credentials, the examples use the dataset labels as a reference cloud

The build environment had no cloud-LLM credentials. Two model stand-ins were tried and rejected:

- The larger English Laya variants fail on the extension's wasm path ("memory access out of
  bounds").
- A DeBERTa-v3-large zero-shot classifier (Transformers.js) reached only 36% on ticket triage,
  against 88% for the local model. That's worse than no escalation, so the report would have
  been misleading.

The examples therefore fall back to `referenceCloud()`, which answers with the dataset's labels.
It is a perfect cloud and is named that way in the file and report. The local half of such a
report is real. The cascade numbers are an upper bound. `ANTHROPIC_API_KEY` switches the examples
to Claude with no other change.

### 8. Built-in AI under Playwright

Added when the first generation example (Gemini Nano through the Prompt API) was calibrated,
following [web-ai-evals](https://github.com/swissspidy/web-ai-evals/blob/main/docs/browser-automation.md).
Verified with Google Chrome 154 on a 4-core, 16 GB Linux VM without a GPU.

- **Google Chrome, not Chromium.** Gemini Nano is delivered by Chrome's component updater, which
  Chromium and Chrome for Testing lack. The default `channel: 'chrome'` stays.
- **Playwright's defaults are removed.** `--disable-component-update`,
  `--disable-background-networking`, `--disable-field-trial-config`, `--disable-extensions`,
  `--disable-component-extensions-with-background-pages` and `--disable-default-apps` go through
  `ignoreDefaultArgs`. Playwright's `--disable-features` list disables `OptimizationHints`, the
  on-device model service ("Unable to create a text session because the service is not running"),
  so a later `--disable-features` with only its harmless entries overrides it.
- **Extensions load through the DevTools protocol.** Google Chrome 137+ ignores `--load-extension`
  (and the `DisableLoadExtensionCommandLineSwitch` opt-out no longer works in 154). The launcher
  adds `--enable-unsafe-extension-debugging` and calls `Extensions.loadUnpacked` on a browser-level
  session. Tabs opened before that never get the extension's content scripts, so the harness uses
  a new tab.
- **`forceCpu`** enables `OnDeviceModelForceCpuBackend` for machines without a supported GPU.
- **The judge counts for availability.** The harness reports the less ready of the local runner and
  its judge, as `task.availability()` does, so a missing judge model is downloaded with the same
  gesture instead of failing every judgement.

Environment-specific, and therefore in the examples' browser config rather than the library:
behind a proxy that only tunnels HTTPS, the component updater's plain-HTTP update check is
redirected with `--component-updater=url-source=https://update.googleapis.com/service/update2/json`,
and the proxy's CA must be in Chrome's NSS store. The first model download ran headful under Xvfb.

## Consequences

- Calibration needs Chrome (or Chromium) and `playwright-core`. The latter is an optional peer
  dependency, loaded only for browser runners.
- The extension polyfill is a moving target. On the day this was written, its hard-coded model
  byte counts were stale against a re-exported model repository, which broke downloads until
  patched. The runner isolates Belay from the polyfill's internals, but calibrations must record
  which model ran (`local.model`, `local.userAgent`).
- Example reports made with the reference cloud say so in their header. They show the local
  model's real confidence profile. The cascade side is an upper bound until re-run against a real
  cloud model.
