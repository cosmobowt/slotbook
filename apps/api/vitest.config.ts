import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files share one real Postgres database, so they run one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
