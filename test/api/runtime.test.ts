import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConfig } from '../../src/config.js';

const fake = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  setWebhook: vi.fn(async () => true),
  deleteWebhook: vi.fn(async () => true),
  start: vi.fn<(...args: unknown[]) => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
  catch: vi.fn(),
  running: false,
  receipt: vi.fn(),
  createApi: vi.fn(),
  suggest: vi.fn(async () => null),
  notifier: {},
  db: undefined as { open: boolean } | undefined,
}));
vi.mock('../../src/bot/index.js', () => ({
  ALLOWED_UPDATES: ['message', 'edited_message', 'callback_query', 'my_chat_member', 'chat_member'],
  createBot: (_config: unknown, db: { open: boolean }) => {
    fake.db = db;
    return { bot: { init: fake.init, api: { setWebhook: fake.setWebhook, deleteWebhook: fake.deleteWebhook }, start: fake.start, stop: fake.stop, catch: fake.catch, isRunning: () => fake.running }, notifier: fake.notifier, isAllowedChat: () => true };
  },
}));
vi.mock('../../src/receipts/index.js', () => ({ registerReceiptHandlers: fake.receipt }));
vi.mock('../../src/fx/index.js', () => ({ createRateSuggester: () => fake.suggest }));
vi.mock('../../src/api/index.js', async () => {
  const { Hono } = await import('hono');
  return { createApi: (...args: unknown[]) => { fake.createApi(...args); return new Hono(); } };
});
vi.mock('@hono/node-server', async () => {
  const { EventEmitter } = await import('node:events');
  return { serve: () => Object.assign(new EventEmitter(), { close: (done: () => void) => done() }) };
});
import { startApp } from '../../src/main.js';

afterEach(() => { vi.clearAllMocks(); fake.running = false; });
const updates = ['message', 'edited_message', 'callback_query', 'my_chat_member', 'chat_member'];

describe('one-process runtime without external calls', () => {
  it('polls with all update types, shares the suggester, and drains the bot before closing SQLite', async () => {
    let finish!: () => void;
    fake.start.mockImplementation(() => { fake.running = true; return new Promise<void>((resolve) => { finish = resolve; }); });
    fake.stop.mockImplementation(async () => {
      expect(fake.db?.open).toBe(true);
      fake.running = false;
      finish();
    });
    const runtime = await startApp(buildConfig());
    try {
      expect(fake.deleteWebhook).toHaveBeenCalledOnce();
      expect(fake.setWebhook).not.toHaveBeenCalled();
      expect(fake.start).toHaveBeenCalledWith({ allowed_updates: updates });
      expect(fake.catch).toHaveBeenCalledOnce();
      const receiptDeps = fake.receipt.mock.calls[0]![3];
      const apiDeps = fake.createApi.mock.calls[0]![2];
      expect(receiptDeps.suggestRate).toBe(fake.suggest);
      expect(apiDeps.suggestRate).toBe(receiptDeps.suggestRate);
      expect(apiDeps.notifier).toBe(receiptDeps.notifier);
    } finally { await runtime.close(); }
    expect(fake.stop).toHaveBeenCalledOnce();
    expect(fake.db?.open).toBe(false);
    await runtime.close();
    expect(fake.stop).toHaveBeenCalledOnce();
  });
  it('registers the secret webhook and allowed updates without polling', async () => {
    const runtime = await startApp(buildConfig({ webhookUrl: 'https://example.invalid', webhookSecret: 'test-webhook-secret' }));
    try {
      expect(fake.init).toHaveBeenCalledOnce();
      expect(fake.setWebhook).toHaveBeenCalledWith('https://example.invalid/telegram/test-webhook-secret', { secret_token: 'test-webhook-secret', allowed_updates: updates });
      expect(fake.start).not.toHaveBeenCalled();
      expect(fake.deleteWebhook).not.toHaveBeenCalled();
    } finally { await runtime.close(); }
    expect(fake.db?.open).toBe(false);
  });
  it('releases SQLite if Telegram startup fails', async () => {
    fake.deleteWebhook.mockRejectedValueOnce(new Error('offline'));
    await expect(startApp(buildConfig())).rejects.toThrow('Could not start Telegram');
    expect(fake.db?.open).toBe(false);
  });
});
