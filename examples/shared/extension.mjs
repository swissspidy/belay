/**
 * Browser settings for calibrating against the WebAI Studio extension, which polyfills the
 * Classifier API with a local Laya model (https://web-ai.studio/extension).
 *
 * Set WEBAI_EXTENSION to the unpacked extension directory (the `release/` folder built from
 * https://github.com/etiennenoel/web-ai.studio/tree/master/extension). Without it, calibration
 * uses the browser's native Classifier API (Chrome with chrome://flags/#classifier-api).
 */

/** Chooses the extension's Classifier model variant (e.g. "laya-en-s512-wfp16"). */
export function selectVariant(variant) {
  return async (context) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup/index.html`);
    await page.evaluate(
      (value) => chrome.runtime.sendMessage({ action: 'set_setting', key: 'classifier_model_variant', value }),
      variant,
    );
    await page.close();
  };
}

/**
 * @param {{ variant?: string, profile?: string }} [options]
 * @returns {import('@belay/calibrate').BrowserConfig}
 */
export function webaiBrowser(options = {}) {
  const extension = process.env.WEBAI_EXTENSION;
  return {
    ...(extension ? { extension } : {}),
    ...(process.env.BELAY_CHROME ? { executablePath: process.env.BELAY_CHROME } : {}),
    ...(options.variant && extension ? { setup: selectVariant(options.variant) } : {}),
    ...(options.profile ? { userDataDir: options.profile } : {}),
    // Downloads of the ~650 MB model can take a while on a slow connection.
    prepareTimeoutMs: 60 * 60_000,
    timeoutMs: 120_000,
  };
}
