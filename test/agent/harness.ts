import { vi } from 'vitest';
import type { Update, User } from 'grammy/types';
import { buildConfig, type Config } from '../../src/config.js';
import { createBot } from '../../src/bot/index.js';
import * as d from '../../src/db/index.js';
import { registerAgentHandlers, registerAgentUnavailableHandlers } from '../../src/agent/handlers.js';
import { registerReceiptHandlers } from '../../src/receipts/index.js';
import { fakeNotifier, reading } from '../receipts/harness.js';
import { ANA, SAM, BOT_INFO, CHAT, BOT_USERNAME } from '../bot/helpers.js';
import { ScriptedAgentModel, type ScriptStep } from './fakeModel.js';
export { ANA, SAM, BOT_INFO, CHAT, BOT_USERNAME };
export const NOW = new Date('2026-09-28T04:00:00Z');
export const args = { description: 'Taxi', amount: '24', currency: 'SGD', payer: 'me', date: '2026-09-28', splitType: 'even', people: [{ name: 'everyone' }] };
export interface Button { text: string; callback_data?: string; url?: string; web_app?: { url: string } }
export function harness(script: ScriptStep[] = [], options: { config?: Partial<Config>; groups?: number; receiptAfter?: boolean; fallback?: boolean; noModel?: boolean } = {}) {
  const config = buildConfig({ agentEnabled: true, botUsername: BOT_USERNAME, ...options.config });
  const db = d.openDatabase(':memory:');
  const groups = Array.from({ length: options.groups ?? 1 }, (_, i) => {
    const g = d.ensureGroup(db, CHAT - i, `Trip ${i}`, [{ telegramUserId: ANA.id, displayName: 'Ana', username: 'ana' }, { telegramUserId: SAM.id, displayName: 'Sam Tan' }]);
    d.setIntroMessage(db, d.systemScope(g.group.id), 400);
    return g;
  });
  const created = createBot(config, db, { botInfo: BOT_INFO, logger: { error: vi.fn() } });
  const bot = created.bot;
  const api: Array<{ method: string; payload: Record<string, any> }> = [];
  const failing = new Set<string>();
  let messageId = 1000, updateId = 1;
  bot.api.config.use(async (_prev, method, payload) => {
    const data = payload as Record<string, any>;
    api.push({ method, payload: data });
    if (failing.has(method)) return { ok: false, error_code: 403, description: 'Fake failure' };
    if (method === 'getChatAdministrators') return { ok: true, result: [] } as never;
    const result = method === 'sendMessage' ? { message_id: ++messageId, date: 0, chat: { id: data.chat_id, type: data.chat_id > 0 ? 'private' : 'group' }, text: data.text } : true;
    return { ok: true, result } as never;
  });
  const model = new ScriptedAgentModel(script);
  const notifier = fakeNotifier();
  const deps = { isAllowedChat: created.isAllowedChat, notifier, suggestRate: async () => null };
  const readReceipt = vi.fn(async () => reading());
  const receipts = () => registerReceiptHandlers(bot, config, db, { ...deps, readReceipt, downloadPhoto: async () => new Uint8Array([1]), logError: () => {} });
  if (!options.receiptAfter) receipts();
  if (options.fallback) registerAgentUnavailableHandlers(bot, config, db, deps);
  else registerAgentHandlers(bot, config, db, { ...deps, ...(!options.noModel ? { model } : {}) });
  if (options.receiptAfter) receipts();
  const passed = vi.fn();
  bot.use(ctx => { passed(ctx.update); });
  const chat = (id: number) => id > 0 ? { id, type: 'private', first_name: 'Ana' } : { id, type: 'group', title: `Trip ${CHAT - id}` };
  async function send(text: string, extra: Record<string, unknown> = {}, from: User = ANA, chatId = CHAT) {
    const id = ++messageId;
    await bot.handleUpdate({ update_id: updateId++, message: { message_id: id, date: NOW.getTime() / 1000, chat: chat(chatId), from, text, ...extra } } as unknown as Update);
    return id;
  }
  const mention = (text: string, extra = {}, from = ANA, chatId = CHAT) => send(`@${BOT_USERNAME} ${text}`, { entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }], ...extra }, from, chatId);
  const privateText = (text: string, from = ANA) => send(text, {}, from, from.id);
  async function tap(data: string, from = ANA, chatId = CHAT) {
    await bot.handleUpdate({ update_id: updateId++, callback_query: { id: `cb${updateId}`, from, chat_instance: 'test', data, message: { message_id: 999, date: 1, chat: chat(chatId), from: BOT_INFO, text: 'Proposal', reply_to_message: { message_id: 998, date: 1, chat: chat(chatId), from } } } } as unknown as Update);
  }
  const sent = (method = 'sendMessage') => api.filter(c => c.method === method).map(c => c.payload);
  const buttons = (): Button[] => (sent().at(-1)?.reply_markup?.inline_keyboard ?? []).flat();
  const data = (label: string) => buttons().find(b => b.text === label)!.callback_data!;
  return { config, db, groups, bot, api, model, notifier, readReceipt, passed, failing, send, mention, privateText, tap, sent, buttons, data };
}
export type Harness = ReturnType<typeof harness>;
