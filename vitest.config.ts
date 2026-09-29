import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@belay/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
