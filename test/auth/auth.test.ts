import { describe, expect, it } from 'vitest';
import { InitDataError, authenticate, displayNameOf, resolveAccess, verifyInitData, type TelegramUser } from '../../src/api/auth.js';
import { buildConfig } from '../../src/config.js';
import { decodeLaunch, encodeLaunch, type Launch } from '../../src/core/index.js';
import {
  claimMember,
  createExpense,
  getGroup,
  listActivity,
  listMembers,
  memberScope,
  resetLink,
  setMemberActive,
} from '../../src/db/index.js';
import { dinner, fingerprint, logged, seed, seedTwo } from '../db/helpers.js';
import { BOT_TOKEN, initDataFor, signInitData } from './helpers.js';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const ANA = { id: 101, first_name: 'Ana', last_name: 'Lim', username: 'ana', language_code: 'en' };
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InitDataError);
    return (error as InitDataError).reason;
  }
  throw new Error('Expected the call to throw');
};

describe('verifyInitData', () => {
  it('accepts a valid signature and returns the Telegram user', () => {
    expect(verifyInitData(initDataFor(ANA, minutesAgo(5)), BOT_TOKEN, NOW)).toEqual({
      id: 101,
      firstName: 'Ana',
      lastName: 'Lim',
      username: 'ana',
      languageCode: 'en',
    });
    expect(verifyInitData(initDataFor({ id: 7, first_name: 'Solo' }, minutesAgo(0)), BOT_TOKEN, NOW)).toEqual({ id: 7, firstName: 'Solo' });
    // Extra fields, as Telegram sends them, are part of the signature.
    const withExtras = initDataFor(ANA, minutesAgo(5), { start_param: 'v1_1_1_home_0_abc', chat_type: 'supergroup', chat_instance: '-42' });
    expect(verifyInitData(withExtras, BOT_TOKEN, NOW).id).toBe(101);
  });

  it('accepts data up to 24 hours old', () => {
    expect(verifyInitData(initDataFor(ANA, minutesAgo(24 * 60 - 1)), BOT_TOKEN, NOW).id).toBe(101);
  });

  it('rejects a wrong signature', () => {
    const good = initDataFor(ANA, minutesAgo(5));
    const params = new URLSearchParams(good);
    params.set('user', JSON.stringify({ ...ANA, id: 999 }));
    expect(reason(() => verifyInitData(params.toString(), BOT_TOKEN, NOW))).toBe('bad_signature');

    const flipped = new URLSearchParams(good);
    const hash = flipped.get('hash')!;
    flipped.set('hash', (hash.startsWith('0') ? '1' : '0') + hash.slice(1));
    expect(reason(() => verifyInitData(flipped.toString(), BOT_TOKEN, NOW))).toBe('bad_signature');

    expect(reason(() => verifyInitData(good, '999999:ANOTHER-TOKEN', NOW))).toBe('bad_signature');
    expect(reason(() => verifyInitData(initDataFor(ANA, minutesAgo(5), {}, '999999:ANOTHER-TOKEN'), BOT_TOKEN, NOW))).toBe('bad_signature');
    const shortHash = new URLSearchParams(good);
    shortHash.set('hash', 'abc');
    expect(reason(() => verifyInitData(shortHash.toString(), BOT_TOKEN, NOW))).toBe('bad_signature');
  });

  it('rejects an expired date', () => {
    expect(reason(() => verifyInitData(initDataFor(ANA, minutesAgo(24 * 60 + 1)), BOT_TOKEN, NOW))).toBe('expired');
    expect(reason(() => verifyInitData(initDataFor(ANA, new Date('2026-01-01T00:00:00Z')), BOT_TOKEN, NOW))).toBe('expired');
    // Dated well into the future.
    expect(reason(() => verifyInitData(initDataFor(ANA, minutesAgo(-60)), BOT_TOKEN, NOW))).toBe('expired');
  });

  it('rejects a bot user', () => {
    expect(reason(() => verifyInitData(initDataFor({ id: 555, first_name: 'Helper', is_bot: true }, minutesAgo(5)), BOT_TOKEN, NOW))).toBe('bot');
  });

  it('rejects data without a signature, a date or a user', () => {
    expect(reason(() => verifyInitData('', BOT_TOKEN, NOW))).toBe('malformed');
    expect(reason(() => verifyInitData('user=%7B%7D&auth_date=1', BOT_TOKEN, NOW))).toBe('malformed');
    expect(reason(() => verifyInitData(signInitData({ user: JSON.stringify(ANA) }), BOT_TOKEN, NOW))).toBe('malformed');
    expect(reason(() => verifyInitData(signInitData({ auth_date: String(Math.floor(NOW.getTime() / 1000)) }), BOT_TOKEN, NOW))).toBe('malformed');
    expect(reason(() => verifyInitData(initDataFor({ first_name: 'No ID' }, minutesAgo(5)), BOT_TOKEN, NOW))).toBe('malformed');
    expect(reason(() => verifyInitData(initDataFor(ANA, minutesAgo(5)), '', NOW))).toBe('malformed');
  });

  it('names a user', () => {
    expect(displayNameOf({ id: 1, firstName: 'Ana', lastName: 'Lim' })).toBe('Ana Lim');
    expect(displayNameOf({ id: 1, firstName: 'Ana' })).toBe('Ana');
    expect(displayNameOf({ id: 1, firstName: '', username: 'ana' })).toBe('ana');
    expect(displayNameOf({ id: 1, firstName: ' ' })).toBe('User 1');
  });
});

describe('authenticate', () => {
  const fake = { id: 9001, firstName: 'Dev' };

  it('checks initData like verifyInitData', () => {
    const config = buildConfig({ botToken: BOT_TOKEN });
    expect(authenticate(config, initDataFor(ANA, minutesAgo(5)), NOW).id).toBe(101);
    expect(reason(() => authenticate(config, null, NOW))).toBe('malformed');
    expect(reason(() => authenticate(config, 'junk', NOW))).toBe('malformed');
  });

  it('in development only, returns the fake user and skips the check', () => {
    const dev = buildConfig({ botToken: BOT_TOKEN, nodeEnv: 'development', devFakeUser: fake });
    expect(authenticate(dev, undefined, NOW)).toEqual(fake);
    expect(authenticate(dev, 'junk', NOW)).toEqual(fake);

    const test = buildConfig({ botToken: BOT_TOKEN, nodeEnv: 'test', devFakeUser: fake });
    expect(reason(() => authenticate(test, 'junk', NOW))).toBe('malformed');
    expect(authenticate(test, initDataFor(ANA, minutesAgo(5)), NOW).id).toBe(101);
    // A production config with a fake user cannot exist. Should one be put together by hand, it is ignored.
    const forced = { ...buildConfig({ botToken: BOT_TOKEN, nodeEnv: 'production' }), devFakeUser: fake };
    expect(reason(() => authenticate(forced, 'junk', NOW))).toBe('malformed');
  });
});

describe('resolveAccess', () => {
  const SECRET = 'a-secret-of-at-least-thirty-two-characters';
  const ana: TelegramUser = { id: 101, firstName: 'Ana' };
  const priya: TelegramUser = { id: 777, firstName: 'Priya', lastName: 'Nair', username: 'priya' };

  it('an existing member gets write, and nothing is changed', () => {
    const s = seed();
    const launch: Launch = { groupId: s.group.id, linkVersion: 1, view: 'home' };
    const before = fingerprint(s.db);
    const result = resolveAccess(s.db, ana, launch);
    expect(result).toEqual({ level: 'write', member: s.ana, group: s.group, joined: false });
    expect(fingerprint(s.db)).toBe(before);
  });

  it('an inactive member keeps full access', () => {
    const s = seed();
    setMemberActive(s.db, s.asSystem, s.sam.id, false);
    const result = resolveAccess(s.db, { id: 102, firstName: 'Sam' }, { groupId: s.group.id, linkVersion: 1, view: 'home' });
    expect(result).toMatchObject({ level: 'write', joined: false, member: { id: s.sam.id, active: false } });
    // And can act with it.
    expect(createExpense(s.db, memberScope(s.group.id, result.member!.id), dinner(s)).createdBy).toBe(s.sam.id);
  });

  it('a new person joining by link becomes a member with write, logged with the system actor', () => {
    const s = seed();
    const launch: Launch = { groupId: s.group.id, linkVersion: 1, view: 'expense', expenseId: 5 };
    let result: ReturnType<typeof resolveAccess> | undefined;
    const entries = logged(s.db, () => (result = resolveAccess(s.db, priya, launch)));
    expect(result).toMatchObject({
      level: 'write',
      joined: true,
      member: { groupId: s.group.id, telegramUserId: 777, displayName: 'Priya Nair', username: 'priya', active: true, joinedVia: 'link', mergedInto: null },
    });
    expect(entries).toEqual([
      expect.objectContaining({ action: 'member.add', actorKind: 'system', actorId: null, entityType: 'member', entityId: result!.member!.id, before: null }),
    ]);
    expect(listMembers(s.db, s.asAna).map((m) => m.displayName)).toContain('Priya Nair');

    // The second request finds the member and does not join again.
    const again = logged(s.db, () => expect(resolveAccess(s.db, priya, launch)).toMatchObject({ level: 'write', joined: false, member: { id: result!.member!.id } }));
    expect(again).toEqual([]);
    expect(listActivity(s.db, s.asAna).filter((a) => a.action === 'member.add' && a.entityId === result!.member!.id)).toHaveLength(1);

    // The new member can claim a hand-added person.
    expect(claimMember(s.db, memberScope(s.group.id, result!.member!.id), s.leo.id).survivor.id).toBe(result!.member!.id);
  });

  it('a link from before a reset is refused, for members and newcomers alike', () => {
    const s = seed();
    const oldLink = decodeLaunch(encodeLaunch({ groupId: s.group.id, linkVersion: s.group.linkVersion, view: 'home' }, SECRET), SECRET);
    expect(resolveAccess(s.db, ana, oldLink).level).toBe('write');

    const fresh = resetLink(s.db, s.asSam);
    const before = fingerprint(s.db);
    expect(resolveAccess(s.db, ana, oldLink)).toEqual({ level: 'none', joined: false });
    expect(resolveAccess(s.db, priya, oldLink)).toEqual({ level: 'none', joined: false });
    expect(fingerprint(s.db)).toBe(before);

    const newLink: Launch = { groupId: s.group.id, linkVersion: fresh.linkVersion, view: 'home' };
    expect(resolveAccess(s.db, ana, newLink)).toMatchObject({ level: 'write', member: { id: s.ana.id } });
    expect(resolveAccess(s.db, priya, newLink)).toMatchObject({ level: 'write', joined: true });
    // A version that was never issued is refused too.
    expect(resolveAccess(s.db, ana, { ...newLink, linkVersion: fresh.linkVersion + 1 }).level).toBe('none');
    expect(getGroup(s.db, s.asAna).linkVersion).toBe(2);
  });

  it('a link to a group that does not exist is refused', () => {
    const s = seed();
    const before = fingerprint(s.db);
    expect(resolveAccess(s.db, ana, { groupId: 999, linkVersion: 1, view: 'home' })).toEqual({ level: 'none', joined: false });
    expect(fingerprint(s.db)).toBe(before);
  });

  it('a link makes someone a member of that group only', () => {
    const { db, a, b } = seedTwo();
    const result = resolveAccess(db, priya, { groupId: a.group.id, linkVersion: 1, view: 'home' });
    expect(result.member!.groupId).toBe(a.group.id);
    expect(listMembers(db, b.asAna).map((m) => m.telegramUserId)).not.toContain(777);
    // Ana of group A is someone else in group B: a different member there.
    const inB = resolveAccess(db, ana, { groupId: b.group.id, linkVersion: 1, view: 'home' });
    expect(inB).toMatchObject({ level: 'write', joined: true });
    expect(inB.member!.id).not.toBe(a.ana.id);
  });
});
