import { Bot } from 'grammy';
import type { Update, User } from 'grammy/types';
import { vi } from 'vitest';
import { buildConfig, type Config } from '../../src/config.js';
import type { Notifier, RateSuggester } from '../../src/core/index.js';
import type { Db } from '../../src/db/index.js';
import { registerReceiptHandlers, type ReceiptReader, type ReceiptReading } from '../../src/receipts/index.js';

export const CHAT_A = -1001234567890;
export const CHAT_B = -1009876543210;
/** 2026-09-27 12:00 in Singapore */
export const NOW = new Date('2026-09-27T04:00:00Z');
export const TODAY = '2026-09-27';

export const ANA: User = { id: 101, is_bot: false, first_name: 'Ana', username: 'ana' };
export const SAM: User = { id: 102, is_bot: false, first_name: 'Sam' };
export const OTHER_BOT: User = { id: 999, is_bot: true, first_name: 'Other bot', username: 'other_bot' };
const BOT_USER = { id: 123456, is_bot: true as const, first_name: 'TripSplitter', username: 'tripsplitter_test_bot' };

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}

export function fakeNotifier(): Notifier {
  const fn = () => vi.fn(async () => {});
  return {
    expenseSaved: fn(),
    expenseEdited: fn(),
    expenseDeleted: fn(),
    expenseRestored: fn(),
    settlementRecorded: fn(),
    settlementUndone: fn(),
    settlementRestored: fn(),
    tripRateChanged: fn(),
    tripEnded: fn(),
    tripReopened: fn(),
    linkReset: fn(),
    memberJoinedByLink: fn(),
  };
}

export function reading(over: Partial<ReceiptReading> = {}): ReceiptReading {
  return {
    is_receipt: true,
    merchant: 'Casa Pepe',
    date: '2026-09-26',
    currency: 'SGD',
    currency_certain: true,
    items: [
      { label: 'Paella', quantity: 1, amount: '60.00' },
      { label: 'Beer', quantity: 2, amount: '16.00' },
      { label: 'Water', quantity: 1, amount: '8.50' },
    ],
    tax: null,
    tax_included: null,
    tip: null,
    service_charge: null,
    discount: null,
    total: '84.50',
    ...over,
  };
}

export interface HarnessOptions {
  db: Db;
  config?: Partial<Config>;
  /** `null` registers the handlers without a reader. */
  reader?: ReceiptReader | null;
  suggestRate?: RateSuggester;
  allowed?: number[];
}

export function harness(options: HarnessOptions) {
  const config = buildConfig({ anthropicApiKey: undefined, ...options.config });
  const calls: ApiCall[] = [];
  const passedOn: Update[] = [];
  const errors: string[] = [];
  const sentIds: number[] = [];
  let nextMessageId = 5000;
  let nextUpdateId = 1;
  const allowed = options.allowed ?? [CHAT_A, CHAT_B];

  const bot = new Bot(config.botToken, { botInfo: { ...BOT_USER, can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: true, has_topics_enabled: false, allows_users_to_create_topics: false } as never });
  bot.api.config.use(async (_prev, method, payload) => {
    const data = payload as Record<string, unknown>;
    calls.push({ method, payload: data });
    let result: unknown = true;
    if (method === 'sendMessage') {
      sentIds.push(nextMessageId);
      result = { message_id: nextMessageId++, date: Math.floor(NOW.getTime() / 1000), chat: { id: data.chat_id, type: 'supergroup', title: 'Trip' }, text: data.text };
    }
    return { ok: true, result } as never;
  });

  const readReceipt = vi.fn<ReceiptReader>(options.reader ?? (async () => reading()));
  const downloadPhoto = vi.fn(async (_fileId: string) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  const suggestRate = vi.fn<RateSuggester>(options.suggestRate ?? (async () => null));
  const notifier = fakeNotifier();

  registerReceiptHandlers(bot, config, options.db, {
    isAllowedChat: (chatId) => allowed.includes(chatId),
    notifier,
    suggestRate,
    ...(options.reader === null ? {} : { readReceipt }),
    downloadPhoto,
    logError: (message) => errors.push(message),
  });
  // Whatever the receipt handlers pass on ends up here.
  bot.use(async (ctx) => {
    passedOn.push(ctx.update);
  });

  const chatOf = (chatId: number) => ({ id: chatId, type: 'supergroup' as const, title: 'Trip' });
  const photo = [
    { file_id: 'photo-small', file_unique_id: 's', width: 90, height: 120 },
    { file_id: 'photo-large', file_unique_id: 'l', width: 960, height: 1280 },
    { file_id: 'photo-medium', file_unique_id: 'm', width: 320, height: 427 },
  ];
  const send = (update: Omit<Update, 'update_id'>) => bot.handleUpdate({ update_id: nextUpdateId++, ...update } as Update);
  const base = (from: User, chatId: number) => ({
    message_id: nextMessageId++,
    date: Math.floor(NOW.getTime() / 1000),
    chat: chatOf(chatId),
    from,
  });

  return {
    bot,
    config,
    calls,
    passedOn,
    errors,
    sentIds,
    readReceipt,
    downloadPhoto,
    suggestRate,
    notifier,
    /** A photo, with or without a caption. */
    sendPhoto: (caption: string | undefined, from: User = ANA, chatId = CHAT_A) =>
      send({ message: { ...base(from, chatId), photo, ...(caption !== undefined ? { caption } : {}) } as never }),
    /** A text message that replies to a photo. */
    sendReplyToPhoto: (text: string, from: User = ANA, chatId = CHAT_A) =>
      send({ message: { ...base(from, chatId), text, reply_to_message: { ...base(SAM, chatId), photo } } as never }),
    sendText: (text: string, from: User = ANA, chatId = CHAT_A) => send({ message: { ...base(from, chatId), text } as never }),
    tap: (data: string, from: User = ANA, chatId = CHAT_A) =>
      send({
        callback_query: {
          id: `cb-${nextUpdateId}`,
          from,
          chat_instance: 'ci',
          data,
          message: { ...base(BOT_USER, chatId), text: 'draft' },
        } as never,
      }),
    sent: () => calls.filter((c) => c.method === 'sendMessage'),
    edits: () => calls.filter((c) => c.method === 'editMessageText'),
    answers: () => calls.filter((c) => c.method === 'answerCallbackQuery'),
    /** The text the member ends up seeing: the last edit, else the last message sent. */
    finalText: (): string => {
      const last = [...calls].reverse().find((c) => c.method === 'editMessageText' || c.method === 'sendMessage');
      return String(last?.payload.text ?? '');
    },
    buttons: (): Button[] => {
      const last = [...calls].reverse().find((c) => c.method === 'editMessageText');
      const markup = last?.payload.reply_markup as { inline_keyboard?: Button[][] } | undefined;
      return (markup?.inline_keyboard ?? []).flat();
    },
  };
}

export type Harness = ReturnType<typeof harness>;

/** The data of the Split evenly button of the last draft message. */
export function splitEvenlyData(h: Harness): string {
  const data = h.buttons().find((b) => b.text === 'Split evenly')?.callback_data;
  if (!data) throw new Error('No Split evenly button.');
  return data;
}
