import { defineConfig } from 'vitest/config';

// `pnpm test:fx`: only test/fx/live/, against the real rate services. Needs network access.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/fx/live/**/*.test.ts'],
    testTimeout: 60_000,
    passWithNoTests: true,
  },
});
