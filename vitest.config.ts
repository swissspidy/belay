import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@swissspidy/belay-core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@swissspidy/belay-web': new URL('./packages/web/src/index.ts', import.meta.url).pathname,
      '@swissspidy/belay-calibrate': new URL('./packages/calibrate/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'examples/test/**/*.test.ts'],
  },
});
