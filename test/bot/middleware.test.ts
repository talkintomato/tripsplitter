import { afterEach, describe, expect, it } from 'vitest';
import { decodeLaunch } from '../../src/core/index.js';
import {
  findGroupByChatId,
  listActivity,
  listMembers,
  openDatabase,
  setClockForTests,
  systemScope,
  upsertTelegramMember,
  type Db,
  type Member,
} from '../../src/db/index.js';
import { isAllowedChat } from '../../src/bot/index.js';
import {
  ANA,
  BOT_ID,
  BOT_INFO,
  BOT_USERNAME,
  CHAT,
  LEO,
  OTHER_BOT,
  OTHER_CHAT,
  SAM,
  SUPER_CHAT,
  buttons,
  chatMemberUpdate,
  harness,
  mentionUpdate,
  messageUpdate,
  textUpdate,
} from './helpers.js';

afterEach(() => setClockForTests(null));

function members(db: Db, chatId: number): Member[] {
  const group = findGroupByChatId(db, chatId);
  if (group === undefined) throw new Error(`no group for chat ${chatId}`);
  return listMembers(db, systemScope(group.id));
}

function names(db: Db, chatId: number): string[] {
  return members(db, chatId).map((member) => member.displayName);
}

describe('allowed chats', () => {
  it('sets up an allowed chat and continues to later handlers', async () => {
    const h = harness();
    let reached = 0;
    h.bot.on('message', () => {
      reached += 1;
    });
    await h.bot.handleUpdate(textUpdate(CHAT, SAM));
    expect(findGroupByChatId(h.db, CHAT)?.title).toBe('Japan 2026');
    expect(reached).toBe(1);
    expect(h.isAllowedChat(CHAT)).toBe(true);
    expect(h.isAllowedChat(OTHER_CHAT)).toBe(false);
  });

  it('stops in a chat that is not allowed: no group, no member, no later handler, no message', async () => {
    const h = harness();
    let reached = 0;
    h.bot.on('message', () => {
      reached += 1;
    });
    await h.bot.handleUpdate(textUpdate(OTHER_CHAT, SAM));
    expect(findGroupByChatId(h.db, OTHER_CHAT)).toBeUndefined();
    expect(reached).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('posts the refusal with the chat ID when the bot is added to a chat that is not allowed', async () => {
    const h = harness();
    await h.bot.handleUpdate(chatMemberUpdate('my_chat_member', OTHER_CHAT, ANA, BOT_INFO, 'left', 'member'));
    expect(h.texts()).toEqual([`This group isn't enabled. Chat ID: ${OTHER_CHAT}`]);
    expect(h.sent()[0]?.payload.chat_id).toBe(OTHER_CHAT);
    expect(findGroupByChatId(h.db, OTHER_CHAT)).toBeUndefined();
  });

  it('posts the refusal when mentioned, at most once per hour per chat', async () => {
    const h = harness();
    let clock = new Date('2026-09-27T02:00:00Z');
    setClockForTests(() => clock);

    await h.bot.handleUpdate(mentionUpdate(OTHER_CHAT, SAM));
    // The join arrives as a service message too.
    await h.bot.handleUpdate(messageUpdate(OTHER_CHAT, ANA, { new_chat_members: [BOT_INFO] }));
    await h.bot.handleUpdate(mentionUpdate(OTHER_CHAT, SAM));
    expect(h.texts()).toHaveLength(1);

    clock = new Date('2026-09-27T02:59:59Z');
    await h.bot.handleUpdate(mentionUpdate(OTHER_CHAT, SAM));
    expect(h.texts()).toHaveLength(1);

    // Another chat has its own limit.
    await h.bot.handleUpdate(mentionUpdate(-5003, SAM));
    expect(h.texts()).toHaveLength(2);

    clock = new Date('2026-09-27T03:00:00Z');
    await h.bot.handleUpdate(mentionUpdate(OTHER_CHAT, SAM));
    expect(h.texts()).toHaveLength(3);
    expect(h.texts()[2]).toBe(`This group isn't enabled. Chat ID: ${OTHER_CHAT}`);
  });

  it('sets up a chat enabled after the bot was added, on its next message', async () => {
    const db = openDatabase(':memory:');
    const before = harness({ db, allowed: [] });
    await before.bot.handleUpdate(chatMemberUpdate('my_chat_member', CHAT, ANA, BOT_INFO, 'left', 'member'));
    await before.bot.handleUpdate(textUpdate(CHAT, SAM));
    expect(findGroupByChatId(db, CHAT)).toBeUndefined();

    // The owner adds the ID and restarts.
    const after = harness({ db, allowed: [CHAT], administrators: [ANA] });
    await after.bot.handleUpdate(textUpdate(CHAT, SAM));
    const group = findGroupByChatId(db, CHAT);
    expect(group).toBeDefined();
    expect(group?.introMessageId).not.toBeNull();
    expect(names(db, CHAT)).toEqual(['Ana', 'Sam Tan']);
    expect(after.sent('getChatAdministrators')).toHaveLength(1);
  });
});

describe('first set-up', () => {
  it('posts the intro with URL buttons, pins it and saves its ID', async () => {
    const h = harness();
    await h.bot.handleUpdate(textUpdate(CHAT, SAM));
    const group = findGroupByChatId(h.db, CHAT)!;

    const intro = h.sent()[0]!;
    const text = String(intro.payload.text);
    expect(text).toContain('Hi, I track shared expenses for this group.');
    expect(text).toContain(`post the photo with @${BOT_USERNAME} in the caption, or reply to a photo with @${BOT_USERNAME}.`);
    expect(text).toContain("I don't store your messages");

    const [add, balances] = buttons(intro);
    expect(add?.text).toBe('Add expense');
    expect(balances?.text).toBe('Balances');
    expect(JSON.stringify(intro.payload.reply_markup)).not.toContain('web_app');
    const param = (url: string): string => new URL(url).searchParams.get('startapp') ?? '';
    expect(add?.url.startsWith(`https://t.me/${BOT_USERNAME}/${h.config.miniAppName}?startapp=`)).toBe(true);
    expect(decodeLaunch(param(add!.url), h.config.linkSecret)).toEqual({ groupId: group.id, linkVersion: group.linkVersion, view: 'add' });
    expect(decodeLaunch(param(balances!.url), h.config.linkSecret)).toMatchObject({ groupId: group.id, view: 'balances' });

    const pin = h.sent('pinChatMessage')[0]!;
    expect(pin.payload.chat_id).toBe(CHAT);
    expect(pin.payload.message_id).toBe(group.introMessageId);
    expect(group.introMessageId).toBeTypeOf('number');
  });

  it('posts one intro when set-up runs twice', async () => {
    const h = harness();
    await h.bot.handleUpdate(textUpdate(CHAT, SAM));
    await h.bot.handleUpdate(textUpdate(CHAT, ANA));
    // The bot removed and added again.
    await h.bot.handleUpdate(chatMemberUpdate('my_chat_member', CHAT, ANA, BOT_INFO, 'member', 'left'));
    await h.bot.handleUpdate(chatMemberUpdate('my_chat_member', CHAT, ANA, BOT_INFO, 'left', 'member'));
    expect(h.sent()).toHaveLength(1);
    expect(h.sent('getChatAdministrators')).toHaveLength(1);

    // A restart.
    const again = harness({ db: h.db });
    await again.bot.handleUpdate(textUpdate(CHAT, SAM));
    expect(again.calls).toEqual([]);
  });

  it('posts one intro when two updates arrive together', async () => {
    const h = harness();
    await Promise.all([h.bot.handleUpdate(textUpdate(CHAT, SAM)), h.bot.handleUpdate(textUpdate(CHAT, LEO))]);
    expect(h.sent()).toHaveLength(1);
    expect(names(h.db, CHAT)).toEqual(['Ana', 'Leo', 'Sam Tan']);
  });

  it('still saves the intro when the bot may not pin', async () => {
    const h = harness();
    h.failing.add('pinChatMessage');
    await h.bot.handleUpdate(textUpdate(CHAT, SAM));
    expect(findGroupByChatId(h.db, CHAT)?.introMessageId).not.toBeNull();
    expect(h.errors).toHaveLength(1);
    await h.bot.handleUpdate(textUpdate(CHAT, SAM));
    expect(h.sent()).toHaveLength(1);
  });
});

describe('learning members', () => {
  it('adds the sender, then updates name and username, and marks them active', async () => {
    const h = harness();
    await h.bot.handleUpdate(textUpdate(CHAT, SAM));
    expect(members(h.db, CHAT).map((m) => [m.telegramUserId, m.displayName, m.username, m.joinedVia, m.active])).toEqual([
      [ANA.id, 'Ana', 'ana', 'chat', true],
      [SAM.id, 'Sam Tan', null, 'chat', true],
    ]);

    await h.bot.handleUpdate(textUpdate(CHAT, { ...SAM, first_name: 'Samuel', username: 'samt' }));
    const sam = members(h.db, CHAT).find((m) => m.telegramUserId === SAM.id);
    expect(sam).toMatchObject({ displayName: 'Samuel Tan', username: 'samt' });
    expect(members(h.db, CHAT)).toHaveLength(2);
  });

  it('records the changes with the system actor', async () => {
    const h = harness();
    await h.bot.handleUpdate(textUpdate(CHAT, SAM));
    const group = findGroupByChatId(h.db, CHAT)!;
    const entries = listActivity(h.db, systemScope(group.id));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.actor.kind === 'system')).toBe(true);
    expect(entries.filter((entry) => entry.action === 'member.add')).toHaveLength(2);
  });

  it('never stores or logs the text of a message', async () => {
    const h = harness();
    h.failing.add('pinChatMessage');
    await h.bot.handleUpdate(textUpdate(CHAT, SAM, 'a very private sentence'));
    await h.bot.handleUpdate(messageUpdate(CHAT, LEO, { photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }], caption: 'a very private sentence' }));
    const tables = (h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
    const stored = tables.map((table) => JSON.stringify(h.db.prepare(`SELECT * FROM "${table}"`).all())).join('\n');
    expect(tables).toContain('activity');
    expect(stored).not.toContain('private sentence');
    expect(JSON.stringify(h.errors)).not.toContain('private sentence');
  });

  it('adds people who join and marks people who leave inactive', async () => {
    const h = harness();
    await h.bot.handleUpdate(messageUpdate(CHAT, ANA, { new_chat_members: [SAM, LEO] }));
    expect(names(h.db, CHAT)).toEqual(['Ana', 'Leo', 'Sam Tan']);

    // Sam leaves by himself: the sender of the service message is the person leaving.
    await h.bot.handleUpdate(messageUpdate(CHAT, SAM, { left_chat_member: SAM }));
    // Leo is removed by Ana.
    await h.bot.handleUpdate(messageUpdate(CHAT, ANA, { left_chat_member: LEO }));
    expect(members(h.db, CHAT).map((m) => [m.displayName, m.active])).toEqual([
      ['Ana', true],
      ['Leo', false],
      ['Sam Tan', false],
    ]);

    // Posting again makes a member active again.
    await h.bot.handleUpdate(textUpdate(CHAT, SAM));
    expect(members(h.db, CHAT).find((m) => m.telegramUserId === SAM.id)?.active).toBe(true);
  });

  it('follows chat_member updates', async () => {
    const h = harness();
    await h.bot.handleUpdate(chatMemberUpdate('chat_member', CHAT, ANA, LEO, 'left', 'member'));
    expect(names(h.db, CHAT)).toEqual(['Ana', 'Leo']);
    await h.bot.handleUpdate(chatMemberUpdate('chat_member', CHAT, ANA, LEO, 'member', 'kicked'));
    expect(members(h.db, CHAT).find((m) => m.telegramUserId === LEO.id)?.active).toBe(false);
  });

  it('does not add someone who leaves without ever being known', async () => {
    const h = harness();
    await h.bot.handleUpdate(messageUpdate(CHAT, LEO, { left_chat_member: LEO }));
    expect(names(h.db, CHAT)).toEqual(['Ana']);
  });

  it('keeps a member who joined by link as the same member when they post', async () => {
    const h = harness();
    await h.bot.handleUpdate(textUpdate(CHAT, ANA));
    const group = findGroupByChatId(h.db, CHAT)!;
    const joined = upsertTelegramMember(h.db, systemScope(group.id), { telegramUserId: LEO.id, displayName: 'Leo' }, { joinedVia: 'link' });

    await h.bot.handleUpdate(textUpdate(CHAT, { ...LEO, username: 'leo' }));
    const found = members(h.db, CHAT).filter((m) => m.telegramUserId === LEO.id);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: joined.member.id, joinedVia: 'link', username: 'leo' });
  });
});

describe('bots are never members', () => {
  it('skips a bot on every path', async () => {
    const h = harness({ administrators: [ANA, OTHER_BOT, BOT_INFO] });
    // The person who added the bot is learned, the bot is not.
    await h.bot.handleUpdate(chatMemberUpdate('my_chat_member', CHAT, SAM, BOT_INFO, 'left', 'administrator'));
    expect(names(h.db, CHAT)).toEqual(['Ana', 'Sam Tan']);

    await h.bot.handleUpdate(textUpdate(CHAT, OTHER_BOT));
    await h.bot.handleUpdate(messageUpdate(CHAT, OTHER_BOT, { new_chat_members: [OTHER_BOT, BOT_INFO] }));
    await h.bot.handleUpdate(chatMemberUpdate('chat_member', CHAT, OTHER_BOT, OTHER_BOT, 'left', 'member'));
    await h.bot.handleUpdate(chatMemberUpdate('chat_member', CHAT, OTHER_BOT, OTHER_BOT, 'member', 'left'));
    await h.bot.handleUpdate(messageUpdate(CHAT, OTHER_BOT, { left_chat_member: OTHER_BOT }));
    // The service message about the pinned intro comes from the bot itself.
    await h.bot.handleUpdate(messageUpdate(CHAT, BOT_INFO, { pinned_message: { message_id: 1, date: 0, chat: { id: CHAT, type: 'group', title: 'x' } } }));

    expect(names(h.db, CHAT)).toEqual(['Ana', 'Sam Tan']);
    expect(members(h.db, CHAT).some((m) => m.telegramUserId === OTHER_BOT.id || m.telegramUserId === BOT_ID)).toBe(false);
  });

  it('skips an administrator that is a bot at set-up', async () => {
    const h = harness({ administrators: [OTHER_BOT, ANA, BOT_INFO] });
    await h.bot.handleUpdate(textUpdate(CHAT, OTHER_BOT));
    expect(names(h.db, CHAT)).toEqual(['Ana']);
  });

  it('skips anonymous admin posts and posts made as a channel', async () => {
    const h = harness();
    const anonymous = { id: 1087968824, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' };
    await h.bot.handleUpdate(messageUpdate(CHAT, anonymous, { text: 'x', sender_chat: { id: CHAT, type: 'group', title: 'Japan 2026' } }));
    const telegram = { id: 777000, is_bot: false, first_name: 'Telegram' };
    await h.bot.handleUpdate(messageUpdate(CHAT, telegram, { text: 'x', sender_chat: { id: -1009, type: 'channel', title: 'News' } }));
    expect(names(h.db, CHAT)).toEqual(['Ana']);
  });

  it('sets nothing up when the bot is removed from a chat it never set up', async () => {
    const h = harness();
    await h.bot.handleUpdate(chatMemberUpdate('my_chat_member', CHAT, ANA, BOT_INFO, 'member', 'kicked'));
    await h.bot.handleUpdate(messageUpdate(CHAT, ANA, { left_chat_member: BOT_INFO }));
    expect(findGroupByChatId(h.db, CHAT)).toBeUndefined();
    expect(h.calls).toEqual([]);
  });
});

describe('upgrade to a supergroup', () => {
  it('migrates the group and posts the new ID', async () => {
    const h = harness();
    await h.bot.handleUpdate(textUpdate(CHAT, SAM));
    const before = findGroupByChatId(h.db, CHAT)!;
    h.calls.length = 0;

    await h.bot.handleUpdate(messageUpdate(CHAT, ANA, { migrate_to_chat_id: SUPER_CHAT }));
    const group = findGroupByChatId(h.db, SUPER_CHAT)!;
    expect(group.id).toBe(before.id);
    expect(group.chatId).toBe(SUPER_CHAT);
    expect(group.previousChatIds).toEqual([CHAT]);
    expect(h.sent()).toHaveLength(1);
    expect(h.sent()[0]?.payload.chat_id).toBe(SUPER_CHAT);
    expect(h.texts()[0]).toContain(String(SUPER_CHAT));
    expect(h.texts()[0]).toContain('ALLOWED_CHAT_IDS');

    // The matching message in the new chat changes nothing and posts nothing more.
    await h.bot.handleUpdate(messageUpdate(SUPER_CHAT, ANA, { migrate_from_chat_id: CHAT }));
    expect(h.sent()).toHaveLength(1);
    expect(listActivity(h.db, systemScope(group.id)).filter((entry) => entry.action === 'group.migrate')).toHaveLength(1);
  });

  it('migrates when the message in the new chat arrives first', async () => {
    const h = harness();
    await h.bot.handleUpdate(textUpdate(CHAT, SAM));
    h.calls.length = 0;
    await h.bot.handleUpdate(messageUpdate(SUPER_CHAT, ANA, { migrate_from_chat_id: CHAT }));
    expect(findGroupByChatId(h.db, SUPER_CHAT)?.chatId).toBe(SUPER_CHAT);
    await h.bot.handleUpdate(messageUpdate(CHAT, ANA, { migrate_to_chat_id: SUPER_CHAT }));
    expect(h.sent()).toHaveLength(1);
  });

  it('keeps the group allowed after a restart with only the old ID configured', async () => {
    const db = openDatabase(':memory:');
    const first = harness({ db, allowed: [CHAT] });
    await first.bot.handleUpdate(textUpdate(CHAT, SAM));
    await first.bot.handleUpdate(messageUpdate(CHAT, ANA, { migrate_to_chat_id: SUPER_CHAT }));

    const restarted = harness({ db, allowed: [CHAT] });
    expect(restarted.isAllowedChat(SUPER_CHAT)).toBe(true);
    expect(isAllowedChat(restarted.config, db, SUPER_CHAT)).toBe(true);
    expect(isAllowedChat(restarted.config, db, CHAT)).toBe(true);

    let reached = 0;
    restarted.bot.on('message', () => {
      reached += 1;
    });
    await restarted.bot.handleUpdate(textUpdate(SUPER_CHAT, LEO));
    expect(reached).toBe(1);
    expect(names(db, SUPER_CHAT)).toEqual(['Ana', 'Leo', 'Sam Tan']);
    expect(restarted.texts().some((text) => text.includes("isn't enabled"))).toBe(false);

    // And with only the new ID configured, the old one is matched too.
    const updated = harness({ db, allowed: [SUPER_CHAT] });
    expect(updated.isAllowedChat(SUPER_CHAT)).toBe(true);
    expect(updated.isAllowedChat(CHAT)).toBe(true);
  });
});

describe('handlers registered after createBot', () => {
  it('receive a tagged photo, after the group is set up and the sender is a member', async () => {
    const h = harness();
    const seen: Array<{ fileId: string | undefined; caption: string | undefined; member: boolean }> = [];
    h.bot.on('message:photo', (ctx) => {
      seen.push({
        fileId: ctx.message.photo.at(-1)?.file_id,
        caption: ctx.message.caption,
        member: members(h.db, ctx.chat.id).some((m) => m.telegramUserId === ctx.from.id),
      });
    });
    const caption = `@${BOT_USERNAME} dinner`;
    await h.bot.handleUpdate(
      messageUpdate(CHAT, LEO, {
        photo: [
          { file_id: 'small', file_unique_id: 's', width: 90, height: 90 },
          { file_id: 'large', file_unique_id: 'l', width: 900, height: 900 },
        ],
        caption,
        caption_entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }],
      }),
    );
    expect(seen).toEqual([{ fileId: 'large', caption, member: true }]);
  });
});
