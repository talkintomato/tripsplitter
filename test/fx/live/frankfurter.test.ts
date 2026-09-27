import { expect, it } from 'vitest';
import { buildConfig } from '../../../src/config.js';
import { CURRENCIES } from '../../../src/core/currencies.js';
import { createRateSuggester, type RateFetch } from '../../../src/fx/index.js';

// Calls the real Frankfurter service. Run with `pnpm test:fx`. Not part of `pnpm test`.

it('fetches SGD to each supported currency', async () => {
  const bodies = new Map<string, string>();
  const recordingFetch: RateFetch = async (url, init) => {
    const response = await fetch(url, init);
    const text = await response.text();
    bodies.set(url, text);
    return { ok: response.ok, status: response.status, text: () => Promise.resolve(text) };
  };
  const suggest = createRateSuggester(buildConfig(), { fetch: recordingFetch });

  const found: Record<string, string | null> = {};
  for (const { code } of CURRENCIES) {
    if (code === 'SGD') continue;
    found[code] = await suggest('SGD', code);
  }
  console.log('SGD to each supported currency:', JSON.stringify(found));

  for (const [code, rate] of Object.entries(found)) {
    expect(rate, `rate for ${code}`).not.toBeNull();
    expect(rate, `rate for ${code}`).toMatch(/^\d+(\.\d{1,6})?$/);
    expect(Number(rate), `rate for ${code}`).toBeGreaterThan(0);

    // The digits are the ones the service sent, apart from cutting to 6 places and end zeros.
    const text = [...bodies.entries()].find(([url]) => url.endsWith(`symbols=${code}`))?.[1] ?? '';
    const sent = new RegExp(`"${code}"\\s*:\\s*([0-9.]+)`).exec(text)?.[1] ?? '';
    expect(sent, `rate text for ${code} in the response`).not.toBe('');
    expect(sent.startsWith(rate as string), `${code}: sent ${sent}, returned ${rate}`).toBe(true);
  }
  expect(Object.keys(found)).toHaveLength(CURRENCIES.length - 1);
  expect(await suggest('SGD', 'SGD')).toBe('1');
});
