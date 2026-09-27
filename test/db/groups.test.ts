import { afterEach, describe, expect, it } from 'vitest';
import {
  NotFoundError,
  PermissionError,
  ValidationError,
  addManualMember,
  countReceiptReads,
  ensureGroup,
  findGroupByChatId,
  findMemberByTelegramId,
  getActiveTrip,
  getGroup,
  getMember,
  listActivity,
  listMembers,
  listTrips,
  memberScope,
  migrateChat,
  openDatabase,
  renameGroup,
  resetLink,
  reserveReceiptRead,
  setClockForTests,
  setIntroMessage,
  setMemberActive,
  singaporeDate,
  systemScope,
  upsertTelegramMember,
} from '../../src/db/index.js';
import { countActivity, fingerprint, logged, seed } from './helpers.js';

afterEach(() => setClockForTests(null));

const humans = [
  { telegramUserId: 101, displayName: 'Ana', username: '@ana' },
  { telegramUserId: 102, displayName: 'Sam' },
];

describe('ensureGroup', () => {
  it('creates the group, its first members and its first trip, with the system actor', () => {
    const db = openDatabase(':memory:');
    let result: ReturnType<typeof ensureGroup> | undefined;
    const entries = logged(db, () => {
      result = ensureGroup(db, -100123, 'Japan 2026', [...humans, humans[0]!]);
    });
    expect(result!.created).toBe(true);
    expect(result!.group).toMatchObject({ chatId: -100123, title: 'Japan 2026', previousChatIds: [], introMessageId: null, linkVersion: 1 });
    expect(result!.members.map((m) => [m.telegramUserId, m.displayName, m.username, m.active, m.joinedVia])).toEqual([
      [101, 'Ana', 'ana', true, 'chat'],
      [102, 'Sam', null, true, 'chat'],
    ]);
    expect(result!.trip).toMatchObject({ name: 'Japan 2026', homeCurrency: 'SGD', homeCurrencyLocked: false, status: 'active', setupDone: false });
    expect(entries.map((e) => [e.action, e.actorKind, e.actorId])).toEqual([
      ['group.create', 'system', null],
      ['member.add', 'system', null],
      ['member.add', 'system', null],
      ['trip.create', 'system', null],
    ]);
  });

  it('called twice creates one group and one trip, and changes nothing the second time', () => {
    const db = openDatabase(':memory:');
    const first = ensureGroup(db, -100123, 'Japan 2026', humans);
    const before = fingerprint(db);
    const second = ensureGroup(db, -100123, 'Renamed since', [...humans, { telegramUserId: 103, displayName: 'Mia' }]);
    expect(second).toEqual({ group: first.group, created: false, members: [], trip: null });
    expect(fingerprint(db)).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_group').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM trip').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM member').get()).toEqual({ n: 2 });
  });

  it('does not start a new trip for a group whose trip has ended', () => {
    const s = seed();
    s.db.prepare(`UPDATE trip SET status = 'ended'`).run();
    expect(ensureGroup(s.db, s.group.chatId, 'x', []).created).toBe(false);
    expect(getActiveTrip(s.db, s.asAna)).toBeUndefined();
    expect(listTrips(s.db, s.asAna)).toHaveLength(1);
  });

  it('works without any humans, and refuses bad input', () => {
    const db = openDatabase(':memory:');
    expect(ensureGroup(db, -5, 'Empty', []).members).toEqual([]);
    expect(() => ensureGroup(db, 0, 'x', [])).toThrow(ValidationError);
    expect(() => ensureGroup(db, -6, ' ', [])).toThrow(ValidationError);
    expect(() => ensureGroup(db, -6, 'x', [{ telegramUserId: 0, displayName: 'Zero' }])).toThrow(ValidationError);
    expect(findGroupByChatId(db, -6)).toBeUndefined();
  });
});

describe('migrateChat', () => {
  it('called twice leaves one alias, and the group is found by old and new ID', () => {
    const s = seed();
    const oldId = s.group.chatId;
    const newId = -1002222222222;
    const entries = logged(s.db, () => {
      expect(migrateChat(s.db, oldId, newId)).toMatchObject({ id: s.group.id, chatId: newId, previousChatIds: [oldId] });
    });
    expect(entries.map((e) => [e.action, e.actorKind])).toEqual([['group.migrate', 'system']]);

    const before = fingerprint(s.db);
    expect(migrateChat(s.db, oldId, newId)).toMatchObject({ chatId: newId, previousChatIds: [oldId] });
    expect(fingerprint(s.db)).toBe(before);
    expect(s.db.prepare('SELECT chat_id FROM chat_alias').all()).toEqual([{ chat_id: oldId }]);

    expect(findGroupByChatId(s.db, oldId)?.id).toBe(s.group.id);
    expect(findGroupByChatId(s.db, newId)?.id).toBe(s.group.id);
    expect(findGroupByChatId(s.db, -42)).toBeUndefined();
    // A chat that still uses the old ID is not set up a second time.
    expect(ensureGroup(s.db, oldId, 'Again', []).created).toBe(false);
  });

  it('keeps every earlier ID over several upgrades', () => {
    const s = seed();
    migrateChat(s.db, s.group.chatId, -2);
    expect(migrateChat(s.db, -2, -3).previousChatIds).toEqual([s.group.chatId, -2]);
    expect(findGroupByChatId(s.db, s.group.chatId)?.chatId).toBe(-3);
  });

  it('refuses an unknown chat and an ID of another group', () => {
    const s = seed();
    const other = ensureGroup(s.db, -777, 'Other', []);
    expect(() => migrateChat(s.db, -999, -1000)).toThrow(NotFoundError);
    expect(() => migrateChat(s.db, s.group.chatId, other.group.chatId)).toThrow(ValidationError);
    expect(getGroup(s.db, s.asAna).chatId).toBe(s.group.chatId);
  });
});

describe('group details', () => {
  it('saves the intro message once', () => {
    const s = seed();
    expect(logged(s.db, () => setIntroMessage(s.db, s.asSystem, 5511)).map((e) => e.action)).toEqual(['group.intro_message']);
    expect(getGroup(s.db, s.asAna).introMessageId).toBe(5511);
    expect(logged(s.db, () => setIntroMessage(s.db, s.asSystem, 5511))).toEqual([]);
    expect(setIntroMessage(s.db, s.asSystem, null).introMessageId).toBeNull();
  });

  it('renames the group', () => {
    const s = seed();
    expect(logged(s.db, () => renameGroup(s.db, s.asSystem, 'Tokyo')).map((e) => e.action)).toEqual(['group.rename']);
    expect(logged(s.db, () => renameGroup(s.db, s.asSystem, 'Tokyo'))).toEqual([]);
  });

  it('throws NotFoundError for a group that does not exist', () => {
    const s = seed();
    expect(() => getGroup(s.db, systemScope(999))).toThrow(NotFoundError);
    expect(() => listMembers(s.db, systemScope(999))).toThrow(NotFoundError);
    expect(() => addManualMember(s.db, systemScope(999), 'X')).toThrow(NotFoundError);
  });
});

describe('members', () => {
  it('adds, renames and reactivates a Telegram member, and logs only real changes', () => {
    const s = seed();
    let mia = upsertTelegramMember(s.db, s.asSystem, { telegramUserId: 103, displayName: 'Mia' });
    expect(mia).toMatchObject({ created: true, changed: true, member: { displayName: 'Mia', active: true, joinedVia: 'chat' } });

    const before = fingerprint(s.db);
    expect(logged(s.db, () => (mia = upsertTelegramMember(s.db, s.asSystem, { telegramUserId: 103, displayName: 'Mia' })))).toEqual([]);
    expect(mia).toMatchObject({ created: false, changed: false });
    expect(fingerprint(s.db)).toBe(before);

    expect(logged(s.db, () => upsertTelegramMember(s.db, s.asSystem, { telegramUserId: 103, displayName: 'Mia B', username: 'mia' })).map((e) => e.action)).toEqual(['member.update']);
    expect(logged(s.db, () => setMemberActive(s.db, s.asSystem, mia.member.id, false)).map((e) => [e.action, e.actorKind])).toEqual([['member.deactivate', 'system']]);
    expect(logged(s.db, () => setMemberActive(s.db, s.asSystem, mia.member.id, false))).toEqual([]);
    expect(logged(s.db, () => upsertTelegramMember(s.db, s.asSystem, { telegramUserId: 103, displayName: 'Mia B', username: 'mia' })).map((e) => e.action)).toEqual(['member.activate']);
    expect(findMemberByTelegramId(s.db, s.asAna, 103)).toMatchObject({ displayName: 'Mia B', username: 'mia', active: true });
    expect(findMemberByTelegramId(s.db, s.asAna, 999)).toBeUndefined();
  });

  it('a member who joined by link and later posts in the chat is the same member', () => {
    const s = seed();
    const joined = upsertTelegramMember(s.db, s.asSystem, { telegramUserId: 150, displayName: 'Priya' }, { joinedVia: 'link' });
    expect(joined.member.joinedVia).toBe('link');
    const posted = upsertTelegramMember(s.db, s.asSystem, { telegramUserId: 150, displayName: 'Priya' });
    expect(posted).toMatchObject({ created: false, changed: false, member: { id: joined.member.id, joinedVia: 'link' } });
    expect(() => upsertTelegramMember(s.db, s.asSystem, { telegramUserId: 151, displayName: 'X' }, { joinedVia: 'manual' as never })).toThrow(ValidationError);
  });

  it('adds a person by hand and lists members by name', () => {
    const s = seed();
    expect(logged(s.db, () => addManualMember(s.db, s.asSam, 'Kai')).map((e) => [e.action, e.actorKind, e.actorId])).toEqual([['member.add', 'member', s.sam.id]]);
    expect(listMembers(s.db, s.asAna).map((m) => m.displayName)).toEqual(['Ana', 'Kai', 'Leo', 'Sam']);
    expect(s.leo).toMatchObject({ telegramUserId: null, active: true, mergedInto: null, joinedVia: 'manual' });
    setMemberActive(s.db, s.asSystem, s.sam.id, false);
    expect(listMembers(s.db, s.asAna, { activeOnly: true }).map((m) => m.displayName)).toEqual(['Ana', 'Kai', 'Leo']);
  });

  it('an inactive member keeps full access', () => {
    const s = seed();
    setMemberActive(s.db, s.asSystem, s.sam.id, false);
    expect(listMembers(s.db, s.asSam)).toHaveLength(3);
    expect(addManualMember(s.db, s.asSam, 'Kai').displayName).toBe('Kai');
    expect(renameGroup(s.db, s.asSam, 'Tokyo').title).toBe('Tokyo');
  });

  it('refuses an actor who is not a member of the group', () => {
    const s = seed();
    const other = ensureGroup(s.db, -777, 'Other', [{ telegramUserId: 900, displayName: 'Zed' }]);
    const stranger = memberScope(s.group.id, other.members[0]!.id);
    expect(() => listMembers(s.db, stranger)).toThrow(PermissionError);
    expect(() => addManualMember(s.db, stranger, 'X')).toThrow(PermissionError);
    expect(() => addManualMember(s.db, memberScope(s.group.id, 9999), 'X')).toThrow(PermissionError);
  });
});

describe('resetLink', () => {
  it('raises the version and logs it', () => {
    const s = seed();
    expect(s.group.linkVersion).toBe(1);
    let after: ReturnType<typeof resetLink> | undefined;
    const entries = logged(s.db, () => (after = resetLink(s.db, s.asSam)));
    expect(after!.linkVersion).toBe(2);
    expect(entries).toEqual([
      expect.objectContaining({
        action: 'group.link_reset',
        entityType: 'group',
        entityId: s.group.id,
        actorKind: 'member',
        actorId: s.sam.id,
        before: expect.objectContaining({ linkVersion: 1 }),
        after: expect.objectContaining({ linkVersion: 2 }),
      }),
    ]);
    expect(resetLink(s.db, s.asAna).linkVersion).toBe(3);
    expect(getGroup(s.db, s.asAna).linkVersion).toBe(3);
    // People who already joined stay members.
    expect(listMembers(s.db, s.asAna)).toHaveLength(3);
  });

  it('touches only its own group', () => {
    const s = seed();
    const other = ensureGroup(s.db, -777, 'Other', []);
    resetLink(s.db, s.asAna);
    expect(findGroupByChatId(s.db, -777)!.linkVersion).toBe(other.group.linkVersion);
  });
});

describe('activity list', () => {
  it('is newest first and pages with before', () => {
    const s = seed();
    const start = countActivity(s.db, s.group.id);
    for (let i = 0; i < 60; i++) addManualMember(s.db, s.asAna, `Guest ${i}`);
    const first = listActivity(s.db, s.asAna);
    expect(first).toHaveLength(50);
    expect(first[0]!.id).toBeGreaterThan(first[49]!.id);
    expect(first[0]).toMatchObject({ action: 'member.add', actor: { kind: 'member', memberId: s.ana.id }, entityType: 'member', before: null });
    const second = listActivity(s.db, s.asAna, { before: first[49]!.id });
    expect(second).toHaveLength(10 + start);
    expect(second[0]!.id).toBe(first[49]!.id - 1);
    expect(second.at(-1)).toMatchObject({ action: 'group.create', actor: { kind: 'system' } });
    expect(listActivity(s.db, s.asAna, { limit: 3 })).toHaveLength(3);
    expect(listActivity(s.db, s.asAna, { tripId: s.trip.id }).map((a) => a.action)).toEqual(['trip.create']);
  });

  it('shows only the entries of the group', () => {
    const s = seed();
    ensureGroup(s.db, -777, 'Other', [{ telegramUserId: 900, displayName: 'Zed' }]);
    expect(listActivity(s.db, s.asAna).every((a) => a.groupId === s.group.id)).toBe(true);
    expect(listActivity(s.db, s.asAna)).toHaveLength(countActivity(s.db, s.group.id));
  });
});

describe('reserveReceiptRead', () => {
  it('at the cap is refused', () => {
    const s = seed();
    const now = new Date('2026-09-27T04:00:00.000Z');
    expect(reserveReceiptRead(s.db, s.group.id, 3, now)).toBe(true);
    expect(reserveReceiptRead(s.db, s.group.id, 3, now)).toBe(true);
    expect(reserveReceiptRead(s.db, s.group.id, 3, now)).toBe(true);
    expect(reserveReceiptRead(s.db, s.group.id, 3, now)).toBe(false);
    expect(reserveReceiptRead(s.db, s.group.id, 3, new Date('2026-09-27T09:00:00.000Z'))).toBe(false);
    expect(countReceiptReads(s.db, s.group.id, now)).toBe(3);
    expect(reserveReceiptRead(s.db, s.group.id, 0, new Date('2026-10-01T00:00:00.000Z'))).toBe(false);
  });

  it('the day changes at midnight Singapore time', () => {
    const s = seed();
    // 15:59:59 UTC is 23:59:59 in Singapore. One second later it is the next day there.
    const beforeMidnight = new Date('2026-09-27T15:59:59.000Z');
    const afterMidnight = new Date('2026-09-27T16:00:00.000Z');
    expect(singaporeDate(beforeMidnight)).toBe('2026-09-27');
    expect(singaporeDate(afterMidnight)).toBe('2026-09-28');
    expect(singaporeDate(new Date('2026-09-26T16:00:00.000Z'))).toBe('2026-09-27');

    expect(reserveReceiptRead(s.db, s.group.id, 1, beforeMidnight)).toBe(true);
    expect(reserveReceiptRead(s.db, s.group.id, 1, beforeMidnight)).toBe(false);
    // Midnight UTC of the same Singapore day does not reset the count.
    expect(reserveReceiptRead(s.db, s.group.id, 1, new Date('2026-09-27T00:00:01.000Z'))).toBe(false);
    expect(reserveReceiptRead(s.db, s.group.id, 1, afterMidnight)).toBe(true);
    expect(reserveReceiptRead(s.db, s.group.id, 1, afterMidnight)).toBe(false);
    expect(s.db.prepare('SELECT day FROM receipt_read ORDER BY id').all()).toEqual([{ day: '2026-09-27' }, { day: '2026-09-28' }]);
  });

  it('counts each group by itself and writes no activity', () => {
    const s = seed();
    const other = ensureGroup(s.db, -777, 'Other', []);
    const now = new Date('2026-09-27T04:00:00.000Z');
    expect(logged(s.db, () => reserveReceiptRead(s.db, s.group.id, 1, now))).toEqual([]);
    expect(reserveReceiptRead(s.db, other.group.id, 1, now)).toBe(true);
    expect(reserveReceiptRead(s.db, s.group.id, 1, now)).toBe(false);
    expect(() => reserveReceiptRead(s.db, 999, 1, now)).toThrow(NotFoundError);
  });
});
