import { afterEach, expect, it } from 'vitest';
import { listGroupsForTelegramUser, renameGroup, setMemberActive, setClockForTests } from '../../src/db/index.js';
import { fingerprint, seedGroup, seedTwo } from './helpers.js';

afterEach(() => setClockForTests(null));

it('lists only existing unmerged memberships, including inactive ones, without any writes', () => {
  const { db, a, b } = seedTwo();
  try {
    const c = seedGroup(db, -300, 'Third', 101);
    setMemberActive(db, c.asSystem, c.ana.id, false);
    const before = fingerprint(db);
    expect(listGroupsForTelegramUser(db, 101).map((r) => r.group.id)).toEqual([c.group.id, a.group.id]);
    expect(listGroupsForTelegramUser(db, 999)).toEqual([]);
    expect(listGroupsForTelegramUser(db, NaN)).toEqual([]);
    expect(fingerprint(db)).toBe(before);
    // Telegram identities cannot currently be claimed through the public operation; model a legacy merge.
    db.prepare('UPDATE member SET merged_into = ? WHERE id = ?').run(c.sam.id, c.ana.id);
    expect(listGroupsForTelegramUser(db, 101).map((r) => r.group.id)).toEqual([a.group.id]);
    expect(listGroupsForTelegramUser(db, 201)[0]?.group.id).toBe(b.group.id);
  } finally { db.close(); }
});

it('orders by latest activity, with deterministic ordering for equal timestamps', () => {
  setClockForTests(() => new Date('2026-09-20T00:00:00Z'));
  const { db, a } = seedTwo();
  try {
    const c = seedGroup(db, -300, 'Third', 101);
    expect(listGroupsForTelegramUser(db, 101).map((r) => r.group.id)).toEqual([c.group.id, a.group.id]);
    setClockForTests(() => new Date('2026-09-21T00:00:00Z'));
    renameGroup(db, a.asAna, 'Updated');
    expect(listGroupsForTelegramUser(db, 101).map((r) => r.group.id)).toEqual([a.group.id, c.group.id]);
  } finally { db.close(); }
});
