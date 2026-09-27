// Live receipt tests: `pnpm test:receipts`. They call the real model, need ANTHROPIC_API_KEY and cost money.
// The layout of this folder is described in README.md.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isSupportedCurrency } from '../../../src/core/index.js';
import { createAnthropicReader, detectImageType, parsePrintedAmount, type ReceiptReading } from '../../../src/receipts/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const PHOTO_TYPES = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const expectedSchema = z.object({
  merchant: z.string().nullable(),
  total: z.string().regex(/^\d+(\.\d+)?$/, 'a decimal string such as "84.50"'),
  currency: z.string().nullable(),
  items: z.number().int().min(0),
});
type Expected = z.infer<typeof expectedSchema>;

interface Row {
  receipt: string;
  merchant: string;
  total: string;
  currency: string;
  items: string;
}

const photos = readdirSync(here)
  .filter((name) => PHOTO_TYPES.has(extname(name).toLowerCase()))
  .sort();
const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
const model = (process.env.RECEIPT_MODEL ?? '').trim() || 'claude-sonnet-5';
const rows: Row[] = [];

const loose = (text: string | null) => (text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
/** Amounts are compared as numbers, so "84.5" equals "84.50". */
const sameAmount = (a: string | null, b: string) => {
  if (a === null) return false;
  const [x, y] = [parsePrintedAmount(a, 'SGD'), parsePrintedAmount(b, 'SGD')];
  return x !== null && y !== null && !x.negative && x.minor === y.minor;
};
/** Items as the app counts them: lines with a negative amount are discounts. */
const countItems = (reading: ReceiptReading) => reading.items.filter((item) => !/^\s*[-−(]/.test(item.amount)).length;
const cell = (ok: boolean, got: unknown, wanted: unknown) => (ok ? 'ok' : `got ${JSON.stringify(got)}, expected ${JSON.stringify(wanted)}`);

describe('live receipts', () => {
  if (photos.length === 0) {
    it('has no photos yet', () => {
      console.log('No receipt photos in test/receipts/live/. Add photos and expected results as described in README.md.');
      expect(photos).toEqual([]);
    });
    return;
  }

  it('has a key', () => {
    expect(apiKey, 'Set ANTHROPIC_API_KEY to run the live receipt tests.').not.toBe('');
  });

  const reader = apiKey === '' ? undefined : createAnthropicReader({ apiKey, model, timeoutMs: 100_000 });

  for (const photo of photos) {
    const name = basename(photo, extname(photo));
    it.skipIf(apiKey === '')(name, async () => {
      const expectedPath = join(here, `${name}.expected.json`);
      expect(existsSync(expectedPath), `${name}.expected.json is missing`).toBe(true);
      const expected: Expected = expectedSchema.parse(JSON.parse(readFileSync(expectedPath, 'utf8')));
      if (expected.currency !== null && !isSupportedCurrency(expected.currency)) {
        console.log(`${name}: the expected currency ${expected.currency} is not one the app supports.`);
      }

      const data = new Uint8Array(readFileSync(join(here, photo)));
      const reading = await reader!({ data, mediaType: detectImageType(data) });

      const merchantOk = loose(reading.merchant) === loose(expected.merchant);
      const totalOk = sameAmount(reading.total, expected.total);
      const currencyOk = (reading.currency ?? null) === expected.currency;
      const items = countItems(reading);
      const itemsOk = items === expected.items;
      rows.push({
        receipt: name,
        merchant: cell(merchantOk, reading.merchant, expected.merchant),
        total: cell(totalOk, reading.total, expected.total),
        currency: cell(currencyOk, reading.currency, expected.currency),
        items: cell(itemsOk, items, expected.items),
      });

      expect.soft(reading.is_receipt, 'is_receipt').toBe(true);
      expect.soft(merchantOk, `merchant: got ${reading.merchant}, expected ${expected.merchant}`).toBe(true);
      expect.soft(totalOk, `total: got ${reading.total}, expected ${expected.total}`).toBe(true);
      expect.soft(currencyOk, `currency: got ${reading.currency}, expected ${expected.currency}`).toBe(true);
      expect.soft(itemsOk, `item count: got ${items}, expected ${expected.items}`).toBe(true);
    });
  }

  afterAll(() => {
    if (rows.length === 0) return;
    console.log(`\nReceipts read with ${model}:`);
    console.table(rows);
    const count = (key: keyof Omit<Row, 'receipt'>) => `${rows.filter((r) => r[key] === 'ok').length}/${rows.length}`;
    console.log(`merchant ${count('merchant')}, total ${count('total')}, currency ${count('currency')}, item count ${count('items')}`);
  });
});
