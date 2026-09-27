import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Bot } from 'grammy';
import { createHttpApp } from '../../src/main.js';
import { createConsoleNotifier } from '../../src/api/dev-server.js';
import { buildConfig } from '../../src/config.js';
import { openDatabase, type Db } from '../../src/db/index.js';

let db: Db;
beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => { if (db.open) db.close(); });
const config = buildConfig({ webhookUrl: 'https://example.invalid', webhookSecret: 'test-webhook-secret' });
function app() {
  const handleUpdate = vi.fn(async () => {});
  return { handleUpdate, http: createHttpApp(config, db, {
    notifier: createConsoleNotifier(() => {}), suggestRate: async () => null,
  }, { handleUpdate } as unknown as Bot, 'web') };
}
it('reports database availability without exposing database details', async () => {
  const { http } = app();
  expect(await (await http.request('/health')).json()).toEqual({ status: 'ok', database: 'ok' });
  db.close();
  const unavailable = await http.request('/health');
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ status: 'unavailable', database: 'unavailable' });
});
it('refuses missing and incorrect webhook secret headers before dispatching an update', async () => {
  const { http, handleUpdate } = app();
  for (const headers of [new Headers(), new Headers({ 'X-Telegram-Bot-Api-Secret-Token': 'wrong' })]) {
    expect((await http.request('/telegram/test-webhook-secret', { method: 'POST', headers, body: JSON.stringify({ update_id: 1 }) })).status).toBe(401);
  }
  expect(handleUpdate).not.toHaveBeenCalled();
  const response = await http.request('/telegram/test-webhook-secret', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' }, body: JSON.stringify({ update_id: 1 }) });
  expect(response.status).toBe(200);
  expect(handleUpdate).toHaveBeenCalledWith({ update_id: 1 });
  expect((await http.request('/telegram/wrong', { method: 'POST' })).status).toBe(404);
});
it('serves the Mini App and its fallback, while unknown API routes require authentication', async () => {
  const { http } = app();
  expect((await http.request('/')).headers.get('content-type')).toContain('text/html');
  expect((await http.request('/trips/123')).status).toBe(200);
  expect((await http.request('/api/not-a-route')).status).toBe(401);
});
