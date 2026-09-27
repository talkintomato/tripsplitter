import { DEFAULT_HOME_CURRENCY } from '../core/index.js';
import { nowIso } from './clock.js';
import { NotFoundError, ValidationError } from './errors.js';
import { cleanText, isId, mapMember, mapTrip, openForRead, openForWrite, readGroup, writeActivity } from './internal.js';
import { systemScope } from './scope.js';
import type { Db, Group, Member, Scope, TelegramProfile, Trip } from './types.js';

function assertChatId(chatId: unknown): number {
  if (typeof chatId !== 'number' || !Number.isSafeInteger(chatId) || chatId === 0) {
    throw new ValidationError('invalid_input', 'The chat ID must be a whole number.');
  }
  return chatId;
}

export function cleanProfile(profile: TelegramProfile): { telegramUserId: number; displayName: string; username: string | null } {
  if (!isId(profile?.telegramUserId)) {
    throw new ValidationError('invalid_input', 'The Telegram user ID must be a whole number above zero.');
  }
  const username = typeof profile.username === 'string' ? profile.username.trim().replace(/^@/, '').slice(0, 64) : '';
  return {
    telegramUserId: profile.telegramUserId,
    displayName: cleanText(profile.displayName, 'name', { max: 128 }),
    username: username === '' ? null : username,
  };
}

/** The group of a Telegram chat, matched by its current chat ID or by an earlier one. Undefined when there is none. */
export function findGroupByChatId(db: Db, chatId: number): Group | undefined {
  if (typeof chatId !== 'number' || !Number.isSafeInteger(chatId)) return undefined;
  const row = db
    .prepare(
      `SELECT id FROM chat_group WHERE chat_id = ?
       UNION SELECT group_id AS id FROM chat_alias WHERE chat_id = ?`,
    )
    .get(chatId, chatId) as { id: number } | undefined;
  return row ? readGroup(db, row.id) : undefined;
}

export interface EnsureGroupResult {
  group: Group;
  /** False when the group existed already. Nothing was changed then. */
  created: boolean;
  /** The members created, when `created`. */
  members: Member[];
  /** The trip created, when `created`. */
  trip: Trip | null;
}

/**
 * Sets a chat up. When no group exists for the chat ID (current or earlier), creates the group with link
 * version 1, a member for each of `humans` (joined via `chat`), and a first active trip named after the title with home currency SGD, all with the
 * system actor. When the group exists it is returned unchanged: no title update, no members, no trip.
 * `humans` must not contain bots; the caller filters them. Someone listed twice is added once.
 * Activity when created: `group.create`, one `member.add` per human, `trip.create`. None otherwise.
 */
export function ensureGroup(db: Db, chatId: number, title: string, humans: TelegramProfile[]): EnsureGroupResult {
  const id = assertChatId(chatId);
  const name = cleanText(title, 'group title');
  const profiles = (humans ?? []).map(cleanProfile);
  return db.transaction((): EnsureGroupResult => {
    const existing = findGroupByChatId(db, id);
    if (existing) return { group: existing, created: false, members: [], trip: null };

    const stamp = nowIso();
    const groupId = Number(db.prepare('INSERT INTO chat_group (chat_id, title, created_at) VALUES (?, ?, ?)').run(id, name, stamp).lastInsertRowid);
    const scope = systemScope(groupId);
    const group = readGroup(db, groupId)!;
    writeActivity(db, scope, { action: 'group.create', entityType: 'group', entityId: groupId, before: null, after: group });

    const members: Member[] = [];
    const seen = new Set<number>();
    for (const profile of profiles) {
      if (seen.has(profile.telegramUserId)) continue;
      seen.add(profile.telegramUserId);
      const memberId = Number(
        db
          .prepare(
            `INSERT INTO member (group_id, telegram_user_id, display_name, username, active, joined_via, created_at)
             VALUES (?, ?, ?, ?, 1, 'chat', ?)`,
          )
          .run(groupId, profile.telegramUserId, profile.displayName, profile.username, stamp).lastInsertRowid,
      );
      const member = mapMember(db.prepare('SELECT * FROM member WHERE id = ?').get(memberId));
      writeActivity(db, scope, { action: 'member.add', entityType: 'member', entityId: memberId, before: null, after: member });
      members.push(member);
    }

    const tripId = Number(
      db
        .prepare(`INSERT INTO trip (group_id, name, home_currency, status, created_at) VALUES (?, ?, ?, 'active', ?)`)
        .run(groupId, name, DEFAULT_HOME_CURRENCY, stamp).lastInsertRowid,
    );
    const trip = mapTrip(db.prepare('SELECT * FROM trip WHERE id = ?').get(tripId));
    writeActivity(db, scope, { tripId, action: 'trip.create', entityType: 'trip', entityId: tripId, before: null, after: trip });
    return { group, created: true, members, trip };
  })();
}

/**
 * Records that Telegram upgraded a chat and gave it a new ID: the group's `chatId` becomes `newChatId` and
 * the old ID is kept as an earlier ID, so `findGroupByChatId` finds the group by both. Safe to call twice:
 * the second call changes nothing. System actor.
 * Throws `NotFoundError` when no group has either ID and `ValidationError` when the new ID belongs to
 * another group. Activity: `group.migrate`, none when nothing changed.
 */
export function migrateChat(db: Db, oldChatId: number, newChatId: number): Group {
  const from = assertChatId(oldChatId);
  const to = assertChatId(newChatId);
  return db.transaction(() => {
    const group = findGroupByChatId(db, from);
    const holder = findGroupByChatId(db, to);
    if (!group) {
      if (holder) return holder;
      throw new NotFoundError('group', `chat ${from}`);
    }
    if (holder && holder.id !== group.id) {
      throw new ValidationError('invalid_input', 'Another group already has this chat ID.');
    }
    if (group.chatId === to) return group;
    // `to` may be an earlier ID of this same group. It becomes the current one again.
    db.prepare('DELETE FROM chat_alias WHERE group_id = ? AND chat_id = ?').run(group.id, to);
    db.prepare('UPDATE chat_group SET chat_id = ? WHERE id = ?').run(to, group.id);
    db.prepare('INSERT INTO chat_alias (group_id, chat_id) VALUES (?, ?) ON CONFLICT (chat_id) DO NOTHING').run(group.id, group.chatId);
    const after = readGroup(db, group.id)!;
    writeActivity(db, systemScope(group.id), { action: 'group.migrate', entityType: 'group', entityId: group.id, before: group, after });
    return after;
  })();
}

/** The scope's group. Throws `NotFoundError` when it does not exist. */
export function getGroup(db: Db, scope: Scope): Group {
  return openForRead(db, scope);
}

/**
 * Saves the Telegram message ID of the intro message, or null to forget it.
 * Activity: `group.intro_message`, none when the ID is the same.
 */
export function setIntroMessage(db: Db, scope: Scope, messageId: number | null): Group {
  if (messageId !== null && !isId(messageId)) throw new ValidationError('invalid_input', 'The message ID must be a whole number above zero.');
  return db.transaction(() => {
    const before = openForWrite(db, scope);
    if (before.introMessageId === messageId) return before;
    db.prepare('UPDATE chat_group SET intro_message_id = ? WHERE id = ?').run(messageId, before.id);
    const after = readGroup(db, before.id)!;
    writeActivity(db, scope, { action: 'group.intro_message', entityType: 'group', entityId: before.id, before, after });
    return after;
  })();
}

/** Changes the group's title, for when the chat is renamed. Activity: `group.rename`, none when the title is the same. */
export function renameGroup(db: Db, scope: Scope, title: string): Group {
  const name = cleanText(title, 'group title');
  return db.transaction(() => {
    const before = openForWrite(db, scope);
    if (before.title === name) return before;
    db.prepare('UPDATE chat_group SET title = ? WHERE id = ?').run(name, before.id);
    const after = readGroup(db, before.id)!;
    writeActivity(db, scope, { action: 'group.rename', entityType: 'group', entityId: before.id, before, after });
    return after;
  })();
}

/**
 * Resets the group's link: adds 1 to the link version, so that every link issued before stops working.
 * People who already joined stay members. Build new links from the `linkVersion` of the group returned.
 * Activity: `group.link_reset`.
 */
export function resetLink(db: Db, scope: Scope): Group {
  return db.transaction(() => {
    const before = openForWrite(db, scope);
    db.prepare('UPDATE chat_group SET link_version = link_version + 1 WHERE id = ?').run(before.id);
    const after = readGroup(db, before.id)!;
    writeActivity(db, scope, { action: 'group.link_reset', entityType: 'group', entityId: before.id, before, after });
    return after;
  })();
}

/** Existing memberships only, active or inactive, newest group activity first. Writes nothing. */
export function listGroupsForTelegramUser(db: Db, telegramUserId: number): Array<{ group: Group; member: Member }> {
  if (!isId(telegramUserId)) return [];
  const rows = db.prepare(`
    SELECT m.* FROM member m JOIN chat_group g ON g.id = m.group_id
    WHERE m.telegram_user_id = ? AND m.merged_into IS NULL
    ORDER BY COALESCE((SELECT MAX(a.created_at) FROM activity a WHERE a.group_id = g.id), g.created_at) DESC,
      (SELECT MAX(a.id) FROM activity a WHERE a.group_id = g.id) DESC, g.id DESC
  `).all(telegramUserId);
  return rows.map((row) => {
    const member = mapMember(row);
    return { group: readGroup(db, member.groupId)!, member };
  });
}
