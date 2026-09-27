import type { User } from 'grammy/types';
import { isChatIdListed, type Config } from '../config.js';
import { findGroupByChatId, type Db, type TelegramProfile } from '../db/index.js';

/** Where the bot writes its errors. Message text from the chat is never passed to it. */
export interface BotLogger {
  error(message: string, details?: Record<string, unknown>): void;
}

export const consoleLogger: BotLogger = {
  error(message, details) {
    if (details === undefined) console.error(message);
    else console.error(message, details);
  },
};

/** A short description of an error, without the payload of the call that failed. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * With ALLOWED_CHAT_IDS empty, the bot works in every chat it is added to. With IDs listed, the chat is
 * allowed when its current ID or any earlier ID (before an upgrade to a supergroup) is in the list.
 */
export function isAllowedChat(config: Config, db: Db, chatId: number): boolean {
  if (config.allowedChatIds.length === 0) return true;
  if (isChatIdListed(config, chatId)) return true;
  const group = findGroupByChatId(db, chatId);
  if (group === undefined) return false;
  return [group.chatId, ...group.previousChatIds].some((id) => isChatIdListed(config, id));
}

/** The profile of a Telegram user. Callers check `is_bot` first: a bot never becomes a member. */
export function profileOf(user: User): TelegramProfile {
  const name = [user.first_name, user.last_name ?? ''].map((part) => part.trim()).filter((part) => part !== '').join(' ');
  return {
    telegramUserId: user.id,
    displayName: name !== '' ? name : (user.username ?? `User ${user.id}`),
    username: user.username ?? null,
  };
}
