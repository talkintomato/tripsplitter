import { afterEach, expect, it } from 'vitest';
import { GROUP_NOTICE_TYPES, PERSONAL_NOTICE_TYPES, getGroupNotificationSettings, getMyNotificationSettings, setGroupNotification, setMyNotification, personalRecipients, memberScope, inTransaction, type Db } from '../../src/db/index.js';
import { seedTwo, logged, fingerprint } from './helpers.js';
const databases: Db[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function setup() { const s = seedTwo(); databases.push(s.db); return s; }

it('returns every effective default and stores only departures, with one row per setting', () => {
  const { db, a } = setup();
  expect(getGroupNotificationSettings(db, a.asAna)).toEqual(Object.fromEntries(GROUP_NOTICE_TYPES.map(t => [t, true])));
  expect(getMyNotificationSettings(db, a.asAna)).toEqual(Object.fromEntries(PERSONAL_NOTICE_TYPES.map(t => [t, false])));
  for (const type of GROUP_NOTICE_TYPES) {
    setGroupNotification(db, a.asAna, type, true);
    setGroupNotification(db, a.asAna, type, false);
    setGroupNotification(db, a.asAna, type, false);
  }
  for (const type of PERSONAL_NOTICE_TYPES) {
    setMyNotification(db, a.asAna, type, false);
    setMyNotification(db, a.asAna, type, true);
    setMyNotification(db, a.asAna, type, true);
  }
  expect(db.prepare('SELECT COUNT(*) AS n FROM notification_setting').get()).toEqual({ n: 12 });
  expect(Object.values(getGroupNotificationSettings(db, a.asSam))).toEqual(Array(7).fill(false));
  expect(Object.values(getMyNotificationSettings(db, a.asAna))).toEqual(Array(5).fill(true));
  for (const type of GROUP_NOTICE_TYPES) setGroupNotification(db, a.asSam, type, true);
  for (const type of PERSONAL_NOTICE_TYPES) setMyNotification(db, a.asAna, type, false);
  expect(db.prepare('SELECT COUNT(*) AS n FROM notification_setting').get()).toEqual({ n: 0 });
});
it('logs group changes with before and after in the same transaction, but never personal settings or no-ops', () => {
  const { db, a } = setup();
  expect(logged(db, () => setGroupNotification(db, a.asSam, 'payment', false))).toEqual([expect.objectContaining({ action: 'group.notification', actorId: a.sam.id, before: { type: 'payment', enabled: true }, after: { type: 'payment', enabled: false } })]);
  expect(logged(db, () => setGroupNotification(db, a.asSam, 'payment', false))).toEqual([]);
  expect(logged(db, () => setMyNotification(db, a.asSam, 'payments_me', true))).toEqual([]);
  const before = fingerprint(db);
  expect(() => inTransaction(db, () => { setGroupNotification(db, a.asAna, 'trip', false); throw Error('rollback'); })).toThrow('rollback');
  expect(fingerprint(db)).toBe(before);
});
it('isolates groups and people and refuses unknown types, invalid values and foreign actors', () => {
  const { db, a, b } = setup();
  setGroupNotification(db, a.asAna, 'trip', false);
  setMyNotification(db, a.asAna, 'added_me', true);
  expect(getGroupNotificationSettings(db, b.asAna).trip).toBe(true);
  expect(getMyNotificationSettings(db, a.asSam).added_me).toBe(false);
  const before = fingerprint(db);
  for (const op of [setGroupNotification, setMyNotification]) {
    expect(() => op(db, a.asAna, 'unknown', true)).toThrow('Unknown notification');
    expect(() => op(db, memberScope(b.group.id, a.ana.id), 'exchange_rate', true)).toThrow();
    expect(() => op(db, a.asSystem, 'exchange_rate', false)).toThrow();
    expect(() => op(db, a.asAna, 'exchange_rate', 'false' as unknown as boolean)).toThrow();
  }
  expect(fingerprint(db)).toBe(before);
});
it.each(PERSONAL_NOTICE_TYPES)('%s recipients must opt in, be concerned, active, unmerged, linked to Telegram and in this group', type => {
  const { db, a, b } = setup();
  const ids = [a.ana.id, a.sam.id, a.leo.id, b.ana.id];
  expect(personalRecipients(db, a.group.id, type, ids)).toEqual([]);
  for (const scope of [a.asAna, a.asSam, memberScope(a.group.id, a.leo.id), b.asAna]) setMyNotification(db, scope, type, true);
  expect(personalRecipients(db, a.group.id, type, ids).map(m => m.id)).toEqual([a.ana.id, a.sam.id]);
  expect(personalRecipients(db, a.group.id, type, [a.sam.id]).map(m => m.id)).toEqual([a.sam.id]);
  db.prepare('UPDATE member SET active = 0 WHERE id = ?').run(a.sam.id);
  expect(personalRecipients(db, a.group.id, type, ids).map(m => m.id)).toEqual([a.ana.id]);
  db.prepare('UPDATE member SET active = 0, merged_into = ? WHERE id = ?').run(a.sam.id, a.ana.id);
  expect(personalRecipients(db, a.group.id, type, ids)).toEqual([]);
});
