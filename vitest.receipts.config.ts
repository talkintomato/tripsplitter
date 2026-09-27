import { defineConfig } from 'vitest/config';

// `pnpm test:receipts`: only test/receipts/live/, against the live model. Needs ANTHROPIC_API_KEY and costs money.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/receipts/live/**/*.test.ts'],
    testTimeout: 120_000,
    passWithNoTests: true,
  },
});
