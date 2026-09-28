import { defineConfig } from 'vitest/config';

// Explicit opt-in. Never part of pnpm test; never loads .env.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/agent/live/**/*.test.ts'],
    testTimeout: 420_000,
    fileParallelism: false,
    passWithNoTests: true,
  },
});
