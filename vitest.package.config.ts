import { defineConfig } from 'vitest/config';

// Runs against the packaged app in dist/ (see test/package). Not part of `pnpm test` or `test:e2e`.
export default defineConfig({
  test: {
    include: ['test/package/**/*.package.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
