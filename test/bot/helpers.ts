import type { Bot } from 'grammy';
import type { Update, User, UserFromGetMe } from 'grammy/types';
import { buildConfig, type Config } from '../../src/config.js';
import { createBot, type BotLogger, type CreatedBot } from '../../src/bot/index.js';
import { openDatabase, type Db } from '../../src/db/index.js';

export const CHAT = -5001;
export const OTHER_CHAT = -5002;
export const SUPER_CHAT = -1005001;
export const BOT_ID = 9000;
export const BOT_USERNAME = 'tripsplit_bot';

export const BOT_INFO: UserFromGetMe = {
  id: BOT_ID,
  is_bot: true,
  first_name: 'TripSplitter',
  username: BOT_USERNAME,
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
} as UserFromGetMe;

export const ANA: User = { id: 101, is_bot: false, first_name: 'Ana', username: 'ana' };
export const SAM: User = { id: 102, is_bot: false, first_name: 'Sam', last_name: 'Tan' };
export const LEO: User = { id: 103, is_bot: false, first_name: 'Leo' };
export const OTHER_BOT: User = { id: 777, is_bot: true, first_name: 'Helper', username: 'helper_bot' };

export interface Call {
  method: string;
  payload: Record<string, unknown>;
}

export interface UrlButton {
  text: string;
  url: string;
}

export interface Harness extends CreatedBot {
  config: Config;
  db: Db;
  calls: Call[];
  errors: Array<{ message: string; details?: Record<string, unknown> }>;
  /** Methods that answer with an error from now on. */
  failing: Set<string>;
  administrators: User[];
  sent(method?: string): Call[];
  texts(): string[];
}

/** Replaces the network: every call to Telegram is recorded and answered here. */
export function fakeTelegram(bot: Bot, harness: Pick<Harness, 'calls' | 'failing' | 'administrators'>): void {
  let nextMessageId = 500;
  bot.api.config.use(async (_prev, method, payload) => {
    const data = payload as Record<string, unknown>;
    harness.calls.push({ method, payload: data });
    if (harness.failing.has(method)) {
      return { ok: false, error_code: 403, description: `Forbidden: fake failure of ${method}` };
    }
    let result: unknown = true;
    if (method === 'sendMessage') {
      nextMessageId += 1;
      result = { message_id: nextMessageId, date: 0, chat: { id: data.chat_id, type: 'group', title: 'x' }, text: data.text };
    } else if (method === 'getChatAdministrators') {
      result = harness.administrators.map((user, index) =>
        index === 0 ? { status: 'creator', user, is_anonymous: false } : { status: 'administrator', user, is_anonymous: false },
      );
    }
    // The fake answers every method, so the result type of the one called cannot be named here.
    return { ok: true, result } as never;
  });
}

export function harness(options: { allowed?: number[]; db?: Db; administrators?: User[] } = {}): Harness {
  const config = buildConfig({ allowedChatIds: options.allowed ?? [CHAT], botUsername: BOT_USERNAME });
  const db = options.db ?? openDatabase(':memory:');
  const errors: Harness['errors'] = [];
  const logger: BotLogger = {
    error: (message, details) => {
      errors.push(details === undefined ? { message } : { message, details });
    },
  };
  const created = createBot(config, db, { botInfo: BOT_INFO, logger });
  const calls: Call[] = [];
  const result: Harness = {
    ...created,
    config,
    db,
    calls,
    errors,
    failing: new Set(),
    administrators: options.administrators ?? [ANA],
    sent: (method = 'sendMessage') => calls.filter((call) => call.method === method),
    texts: () => calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.payload.text)),
  };
  fakeTelegram(created.bot, result);
  return result;
}

export function buttons(call: Call | undefined): UrlButton[] {
  const markup = call?.payload.reply_markup as { inline_keyboard?: UrlButton[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((button) => ({ text: button.text, url: button.url }));
}

let nextUpdateId = 1;
let nextMessageId = 1;

function groupChat(chatId: number, title: string): Record<string, unknown> {
  return { id: chatId, type: chatId <= -1000000000000 || chatId === SUPER_CHAT ? 'supergroup' : 'group', title };
}

/** A message in a group. `extra` adds or replaces fields of the message, such as `photo` or `from`. */
export function messageUpdate(chatId: number, from: User, extra: Record<string, unknown> = {}, title = 'Japan 2026'): Update {
  nextUpdateId += 1;
  nextMessageId += 1;
  return {
    update_id: nextUpdateId,
    message: { message_id: nextMessageId, date: 1_790_000_000, chat: groupChat(chatId, title), from, ...extra },
  } as unknown as Update;
}

export function textUpdate(chatId: number, from: User, text = 'hello there'): Update {
  return messageUpdate(chatId, from, { text });
}

export function mentionUpdate(chatId: number, from: User): Update {
  const text = `hi @${BOT_USERNAME}`;
  return messageUpdate(chatId, from, { text, entities: [{ type: 'mention', offset: 3, length: BOT_USERNAME.length + 1 }] });
}

export function memberStatus(user: User, status: 'member' | 'left' | 'kicked' | 'administrator'): Record<string, unknown> {
  if (status === 'kicked') return { status, user, until_date: 0 };
  if (status === 'administrator') return { status, user, is_anonymous: false, can_be_edited: false };
  return { status, user };
}

export function chatMemberUpdate(
  kind: 'my_chat_member' | 'chat_member',
  chatId: number,
  from: User,
  user: User,
  before: 'member' | 'left' | 'kicked',
  after: 'member' | 'left' | 'kicked' | 'administrator',
): Update {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    [kind]: {
      chat: groupChat(chatId, 'Japan 2026'),
      from,
      date: 1_790_000_000,
      old_chat_member: memberStatus(user, before),
      new_chat_member: memberStatus(user, after),
    },
  } as unknown as Update;
}
