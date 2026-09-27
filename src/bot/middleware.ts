import type { Api, Context, MiddlewareFn } from 'grammy';
import type { ChatMember, Message, MessageEntity, User } from 'grammy/types';
import { isChatIdListed, type Config } from '../config.js';
import {
  ensureGroup,
  findGroupByChatId,
  findMemberByTelegramId,
  migrateChat,
  now,
  renameGroup,
  setMemberActive,
  systemScope,
  upsertTelegramMember,
  type Db,
  type Group,
  type TelegramProfile,
} from '../db/index.js';
import { postIntro } from './intro.js';
import { describeError, isAllowedChat, profileOf, type BotLogger } from './support.js';

export const REFUSAL_INTERVAL_MS = 60 * 60 * 1000;

export interface GroupMiddlewareDeps {
  api: Api;
  config: Config;
  db: Db;
  logger: BotLogger;
}

const IN_CHAT: ReadonlyArray<ChatMember['status']> = ['creator', 'administrator', 'member'];

function isInChat(member: ChatMember): boolean {
  if (member.status === 'restricted') return member.is_member;
  return IN_CHAT.includes(member.status);
}

/** True when the text or caption of the message mentions the bot. The text itself is not kept. */
function mentionsBot(message: Message | undefined, botUsername: string): boolean {
  if (message === undefined) return false;
  const wanted = `@${botUsername}`.toLowerCase();
  const has = (text: string | undefined, entities: MessageEntity[] | undefined): boolean =>
    text !== undefined &&
    (entities ?? []).some(
      (entity) =>
        (entity.type === 'mention' || entity.type === 'bot_command') &&
        text.slice(entity.offset, entity.offset + entity.length).toLowerCase().endsWith(wanted),
    );
  return has(message.text, message.entities) || has(message.caption, message.caption_entities);
}

/**
 * The steps every update from a group passes through before any other handler: allowed chat, group exists,
 * learn the sender, continue.
 */
export function groupMiddleware(deps: GroupMiddlewareDeps): MiddlewareFn<Context> {
  const { api, config, db, logger } = deps;
  /** When the refusal was last posted, per chat. Kept in memory: a restart may post it once more. */
  const lastRefusal = new Map<number, number>();
  /** Set-up in progress per chat, so two updates arriving together post one intro. */
  const settingUp = new Map<number, Promise<Group>>();

  async function refuse(chatId: number): Promise<void> {
    const at = now().getTime();
    const last = lastRefusal.get(chatId);
    if (last !== undefined && at - last < REFUSAL_INTERVAL_MS) return;
    lastRefusal.set(chatId, at);
    const prefix = "This group isn't enabled. Chat ID: ";
    const id = String(chatId);
    try {
      await api.sendMessage(chatId, prefix + id, {
        entities: [{ type: 'code', offset: prefix.length, length: id.length }],
      });
    } catch (error) {
      logger.error('Could not post the refusal', { chatId, error: describeError(error) });
    }
  }

  async function humanAdministrators(chatId: number): Promise<TelegramProfile[]> {
    try {
      const administrators = await api.getChatAdministrators(chatId);
      return administrators.filter((admin) => !admin.user.is_bot).map((admin) => profileOf(admin.user));
    } catch (error) {
      logger.error('Could not read the administrators', { chatId, error: describeError(error) });
      return [];
    }
  }

  async function setUp(chatId: number, title: string): Promise<Group> {
    let group = findGroupByChatId(db, chatId);
    if (group === undefined) {
      const humans = await humanAdministrators(chatId);
      // ensureGroup returns an existing group unchanged, should one have appeared in the meantime.
      group = ensureGroup(db, chatId, title, humans).group;
    }
    if (title !== '' && group.title !== title) group = renameGroup(db, systemScope(group.id), title);
    if (group.introMessageId === null) {
      await postIntro(api, config, db, group, logger);
      group = findGroupByChatId(db, chatId) ?? group;
    }
    return group;
  }

  function setUpOnce(chatId: number, title: string): Promise<Group> {
    const previous = settingUp.get(chatId);
    const run = (previous ?? Promise.resolve()).then(
      () => setUp(chatId, title),
      () => setUp(chatId, title),
    );
    settingUp.set(chatId, run);
    const forget = (): void => {
      if (settingUp.get(chatId) === run) settingUp.delete(chatId);
    };
    run.then(forget, forget);
    return run;
  }

  /** Moves the group to its new chat ID and tells the owner. Does nothing the second time. */
  async function migrate(oldChatId: number, newChatId: number): Promise<void> {
    const group = findGroupByChatId(db, oldChatId);
    if (group === undefined || group.chatId === newChatId) return;
    migrateChat(db, oldChatId, newChatId);
    if (isChatIdListed(config, newChatId)) return;
    const prefix = 'This group was upgraded by Telegram and has a new chat ID: ';
    const id = String(newChatId);
    const text = `${prefix}${id}\nI keep working here. Please add the new ID to ALLOWED_CHAT_IDS.`;
    try {
      await api.sendMessage(newChatId, text, { entities: [{ type: 'code', offset: prefix.length, length: id.length }] });
    } catch (error) {
      logger.error('Could not post the new chat ID', { chatId: newChatId, error: describeError(error) });
    }
  }

  function learn(group: Group, user: User | undefined): void {
    if (user === undefined || user.is_bot) return;
    upsertTelegramMember(db, systemScope(group.id), profileOf(user));
  }

  function markLeft(group: Group, user: User): void {
    if (user.is_bot) return;
    const scope = systemScope(group.id);
    const member = findMemberByTelegramId(db, scope, user.id);
    if (member !== undefined) setMemberActive(db, scope, member.id, false);
  }

  return async (ctx, next) => {
    const chat = ctx.chat;
    if (chat === undefined || (chat.type !== 'group' && chat.type !== 'supergroup')) {
      await next();
      return;
    }
    const chatId = chat.id;
    const message = ctx.update.message;
    const me = ctx.me.id;

    // The first message in an upgraded chat. When it arrives before the one in the old chat, the group is
    // still known by its old ID only.
    if (message?.migrate_from_chat_id !== undefined && isAllowedChat(config, db, message.migrate_from_chat_id)) {
      await migrate(message.migrate_from_chat_id, chatId);
    }

    // 1. Allowed chat
    const myChange = ctx.update.my_chat_member;
    const botJoined =
      (myChange !== undefined && isInChat(myChange.new_chat_member) && !isInChat(myChange.old_chat_member)) ||
      (message?.new_chat_members ?? []).some((user) => user.id === me) ||
      message?.group_chat_created === true ||
      message?.supergroup_chat_created === true;
    if (!isAllowedChat(config, db, chatId)) {
      if (botJoined || mentionsBot(message, config.botUsername)) await refuse(chatId);
      return;
    }

    // The bot was removed: nothing can be posted there, and nobody is learned from it.
    const botLeft = (myChange !== undefined && !isInChat(myChange.new_chat_member)) || message?.left_chat_member?.id === me;
    if (botLeft) return;

    // The chat is being upgraded. This chat ID stops existing, so no intro is posted to it.
    if (message?.migrate_to_chat_id !== undefined) {
      if (findGroupByChatId(db, chatId) === undefined) ensureGroup(db, chatId, chat.title, []);
      await migrate(chatId, message.migrate_to_chat_id);
      await next();
      return;
    }

    // 2. Group exists
    const group = await setUpOnce(chatId, chat.title);

    // 3. Learn the sender. Posts as the group or as a channel (anonymous admins) have no person behind them.
    const left = message?.left_chat_member;
    const postedAsChat = (message ?? ctx.update.edited_message)?.sender_chat !== undefined;
    if (!postedAsChat && ctx.from?.id !== left?.id) learn(group, ctx.from);
    for (const user of message?.new_chat_members ?? []) learn(group, user);
    if (left !== undefined) markLeft(group, left);
    const change = ctx.update.chat_member;
    if (change !== undefined) {
      if (isInChat(change.new_chat_member)) learn(group, change.new_chat_member.user);
      else markLeft(group, change.new_chat_member.user);
    }

    // 4. Continue
    await next();
  };
}
