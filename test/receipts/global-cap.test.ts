import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildConfig, loadConfig } from '../../src/config.js';
import { openDatabase, setClockForTests, type Db } from '../../src/db/index.js';
import { ReceiptReadError, TEXT } from '../../src/receipts/index.js';
import { ANA, CHAT_A, CHAT_B, harness, NOW } from './harness.js';
let db: Db;
beforeEach(() => { db = openDatabase(':memory:'); setClockForTests(() => NOW); });
afterEach(() => { db.close(); setClockForTests(null); });

it('stops another group before download or model call at the overall cap', async () => {
  const h = harness({ db, config: { receiptGlobalDailyCap: 1 } });
  await h.sendPhoto('@tripsplitter_test_bot', ANA, CHAT_A);
  await h.sendPhoto('@tripsplitter_test_bot', ANA, CHAT_B);
  expect(h.readReceipt).toHaveBeenCalledTimes(1);
  expect(h.downloadPhoto).toHaveBeenCalledTimes(1);
  expect(h.finalText()).toBe(TEXT.limitReached);
});
it('reserves retries against the overall cap too', async () => {
  const h = harness({ db, config: { receiptGlobalDailyCap: 1 }, reader: async () => { throw new ReceiptReadError('network', 'timeout'); } });
  await h.sendPhoto('@tripsplitter_test_bot');
  expect(h.readReceipt).toHaveBeenCalledTimes(1);
  expect(h.finalText()).toBe(TEXT.unavailable);
});
it('zero disables the overall cap', async () => {
  const h = harness({ db, config: { receiptGlobalDailyCap: 0 } });
  await h.sendPhoto('@tripsplitter_test_bot', ANA, CHAT_A);
  await h.sendPhoto('@tripsplitter_test_bot', ANA, CHAT_B);
  expect(h.readReceipt).toHaveBeenCalledTimes(2);
});
it('defaults to 300 and parses an optional nonnegative overall cap', () => {
  const env = { BOT_TOKEN: 'test', BOT_USERNAME: 'test_bot', MINI_APP_NAME: 'app', LINK_SECRET: 'a'.repeat(32) };
  expect(buildConfig().receiptGlobalDailyCap).toBe(300);
  expect(loadConfig(env).receiptGlobalDailyCap).toBe(300);
  expect(loadConfig({ ...env, RECEIPT_GLOBAL_DAILY_CAP: '0' }).receiptGlobalDailyCap).toBe(0);
  for (const value of ['-1', '1.5', 'no']) expect(() => loadConfig({ ...env, RECEIPT_GLOBAL_DAILY_CAP: value })).toThrow('RECEIPT_GLOBAL_DAILY_CAP');
});
