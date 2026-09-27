import { defineConfig } from 'vitest/config';

// `pnpm test`: everything under test/ except test/receipts/live/ and test/fx/live/, which call real services.
// A test that needs a DOM (test/web/) starts with the line:  // @vitest-environment jsdom
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', 'test/receipts/live/**', 'test/fx/live/**'],
  },
});
