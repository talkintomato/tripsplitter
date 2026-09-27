import { describe, expect, it } from 'vitest';
import {
  addManualMember,
  changeHomeCurrency,
  claimMember,
  completeSetup,
  confirmExpense,
  createExpense,
  createSettlement,
  deleteExpense,
  discardExpense,
  endTrip,
  ensureGroup,
  getOrCreateActiveTrip,
  listActivity,
  memberScope,
  migrateChat,
  openDatabase,
  previewTripRate,
  renameGroup,
  renameTrip,
  reopenTrip,
  reserveReceiptRead,
  resetLink,
  restoreExpense,
  restoreSettlement,
  saveExpense,
  setIntroMessage,
  setMemberActive,
  setTripRate,
  undoSettlement,
  upsertTelegramMember,
} from '../../src/db/index.js';
import { dinner, logged, ramen, sameAs, seed } from './helpers.js';

/**
 * The activity entries of docs/foundation-api.md, operation by operation.
 * Each line is [entries written, in order]. Keep the two in step.
 */
describe('each operation writes the activity entries documented for it', () => {
  it('group operations', () => {
    const db = openDatabase(':memory:');
    const humans = [{ telegramUserId: 1, displayName: 'Ana' }, { telegramUserId: 2, displayName: 'Sam' }];
    expect(logged(db, () => ensureGroup(db, -1, 'Trip', humans)).map((e) => e.action)).toEqual(['group.create', 'member.add', 'member.add', 'trip.create']);
    expect(logged(db, () => ensureGroup(db, -1, 'Trip', humans))).toEqual([]);
    expect(logged(db, () => migrateChat(db, -1, -2)).map((e) => e.action)).toEqual(['group.migrate']);
    expect(logged(db, () => migrateChat(db, -1, -2))).toEqual([]);

    const s = seed();
    expect(logged(s.db, () => setIntroMessage(s.db, s.asSystem, 77)).map((e) => e.action)).toEqual(['group.intro_message']);
    expect(logged(s.db, () => renameGroup(s.db, s.asSystem, 'New title')).map((e) => e.action)).toEqual(['group.rename']);
    expect(logged(s.db, () => resetLink(s.db, s.asAna)).map((e) => e.action)).toEqual(['group.link_reset']);
    expect(logged(s.db, () => reserveReceiptRead(s.db, s.group.id, 5, new Date()))).toEqual([]);
  });

  it('member operations', () => {
    const s = seed();
    const profile = { telegramUserId: 103, displayName: 'Mia' };
    expect(logged(s.db, () => upsertTelegramMember(s.db, s.asSystem, profile)).map((e) => e.action)).toEqual(['member.add']);
    expect(logged(s.db, () => upsertTelegramMember(s.db, s.asSystem, profile))).toEqual([]);
    expect(logged(s.db, () => upsertTelegramMember(s.db, s.asSystem, { ...profile, displayName: 'Mia B' })).map((e) => e.action)).toEqual(['member.update']);
    expect(logged(s.db, () => setMemberActive(s.db, s.asSystem, s.sam.id, false)).map((e) => e.action)).toEqual(['member.deactivate']);
    expect(logged(s.db, () => setMemberActive(s.db, s.asSystem, s.sam.id, true)).map((e) => e.action)).toEqual(['member.activate']);
    expect(logged(s.db, () => setMemberActive(s.db, s.asSystem, s.sam.id, true))).toEqual([]);
    expect(logged(s.db, () => addManualMember(s.db, s.asAna, 'Kai')).map((e) => e.action)).toEqual(['member.add']);

    createExpense(s.db, s.asAna, dinner(s, { payerId: s.leo.id, shares: [{ memberId: s.leo.id }] }));
    createSettlement(s.db, s.asAna, { tripId: s.trip.id, fromMemberId: s.leo.id, toMemberId: s.ana.id, amount: 5 });
    setTripRate(s.db, memberScope(s.group.id, s.leo.id), s.trip.id, 'JPY', '112.4', 'member');
    expect(logged(s.db, () => claimMember(s.db, s.asSam, s.leo.id)).map((e) => e.action)).toEqual([
      'member.claim',
      'expense.member_merged',
      'settlement.member_merged',
      'trip_rate.member_merged',
    ]);
  });

  it('trip and rate operations', () => {
    const s = seed();
    expect(logged(s.db, () => getOrCreateActiveTrip(s.db, s.asAna))).toEqual([]);
    expect(logged(s.db, () => renameTrip(s.db, s.asAna, s.trip.id, 'Tokyo')).map((e) => e.action)).toEqual(['trip.rename']);
    expect(logged(s.db, () => completeSetup(s.db, s.asAna, s.trip.id)).map((e) => e.action)).toEqual(['trip.setup_done']);

    createExpense(s.db, s.asAna, ramen(s, { status: 'draft' }));
    createExpense(s.db, s.asAna, ramen(s, { status: 'draft' }));
    expect(logged(s.db, () => previewTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.4'))).toEqual([]);
    expect(logged(s.db, () => setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.4', 'suggested')).map((e) => e.action)).toEqual([
      'trip_rate.set',
      'expense.rate_change',
      'expense.rate_change',
    ]);
    expect(logged(s.db, () => setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '110', 'member')).map((e) => e.action)).toEqual([
      'trip_rate.change',
      'expense.rate_change',
      'expense.rate_change',
    ]);
    expect(logged(s.db, () => setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '110', 'member'))).toEqual([]);
    expect(logged(s.db, () => changeHomeCurrency(s.db, s.asAna, s.trip.id, 'USD')).map((e) => e.action)).toEqual([
      'trip.home_currency',
      'trip_rate.remove',
      'expense.rate_change',
      'expense.rate_change',
    ]);
    expect(logged(s.db, () => endTrip(s.db, s.asAna, s.trip.id)).map((e) => e.action)).toEqual(['trip.end']);
    expect(logged(s.db, () => reopenTrip(s.db, s.asAna, s.trip.id)).map((e) => e.action)).toEqual(['trip.reopen']);
    endTrip(s.db, s.asAna, s.trip.id);
    expect(logged(s.db, () => getOrCreateActiveTrip(s.db, s.asAna)).map((e) => e.action)).toEqual(['trip.create']);
  });

  it('expense and settlement operations', () => {
    const s = seed();
    let expense = createExpense(s.db, s.asAna, dinner(s, { status: 'draft' }));
    expect(logged(s.db, () => createExpense(s.db, s.asAna, dinner(s))).map((e) => e.action)).toEqual(['expense.create']);
    expect(logged(s.db, () => (expense = saveExpense(s.db, s.asSam, expense.id, expense.version, { ...sameAs(s, dinner(s)), total: 1200 }))).map((e) => e.action)).toEqual(['expense.save']);
    expect(logged(s.db, () => (expense = confirmExpense(s.db, s.asAna, expense.id, expense.version))).map((e) => e.action)).toEqual(['expense.confirm']);
    expect(logged(s.db, () => (expense = deleteExpense(s.db, s.asAna, expense.id, expense.version))).map((e) => e.action)).toEqual(['expense.delete']);
    expect(logged(s.db, () => (expense = restoreExpense(s.db, s.asAna, expense.id, expense.version))).map((e) => e.action)).toEqual(['expense.restore']);
    let draft = createExpense(s.db, s.asAna, dinner(s, { status: 'draft' }));
    expect(logged(s.db, () => (draft = discardExpense(s.db, s.asAna, draft.id, draft.version))).map((e) => e.action)).toEqual(['expense.discard']);
    expect(logged(s.db, () => restoreExpense(s.db, s.asAna, draft.id, draft.version)).map((e) => e.action)).toEqual(['expense.restore']);

    let settlement = createSettlement(s.db, s.asAna, { tripId: s.trip.id, fromMemberId: s.sam.id, toMemberId: s.ana.id, amount: 5 });
    expect(logged(s.db, () => createSettlement(s.db, s.asAna, { tripId: s.trip.id, fromMemberId: s.sam.id, toMemberId: s.ana.id, amount: 5 })).map((e) => e.action)).toEqual(['settlement.create']);
    expect(logged(s.db, () => (settlement = undoSettlement(s.db, s.asAna, settlement.id, settlement.version))).map((e) => e.action)).toEqual(['settlement.undo']);
    expect(logged(s.db, () => restoreSettlement(s.db, s.asAna, settlement.id, settlement.version)).map((e) => e.action)).toEqual(['settlement.restore']);
  });

  it('records who, what, and the whole record before and after', () => {
    const s = seed();
    const created = createExpense(s.db, s.asAna, dinner(s));
    const saved = saveExpense(s.db, s.asSam, created.id, 1, { ...sameAs(s, dinner(s)), total: 1500, description: 'Late dinner' });
    const [entry, first] = listActivity(s.db, s.asAna, { limit: 2 });
    expect(entry).toMatchObject({
      groupId: s.group.id,
      tripId: s.trip.id,
      actor: { kind: 'member', memberId: s.sam.id },
      action: 'expense.save',
      entityType: 'expense',
      entityId: created.id,
    });
    expect(entry!.before).toEqual(JSON.parse(JSON.stringify(created)));
    expect(entry!.after).toEqual(JSON.parse(JSON.stringify(saved)));
    expect(first).toMatchObject({ action: 'expense.create', before: null, actor: { kind: 'member', memberId: s.ana.id } });
    expect(first!.after).toEqual(JSON.parse(JSON.stringify(created)));
    expect(new Date(entry!.createdAt).toISOString()).toBe(entry!.createdAt);
  });

  it('a refused change writes nothing', () => {
    const s = seed();
    const expense = createExpense(s.db, s.asAna, dinner(s));
    const entries = logged(s.db, () => {
      expect(() => saveExpense(s.db, s.asAna, expense.id, 1, { ...sameAs(s, dinner(s)), shares: [] })).toThrow();
      expect(() => saveExpense(s.db, s.asAna, expense.id, 7, sameAs(s, dinner(s)))).toThrow();
      expect(() => confirmExpense(s.db, s.asAna, expense.id, 1)).toThrow();
      expect(() => createExpense(s.db, s.asAna, dinner(s, { currency: 'CHF' }))).toThrow();
      expect(() => createSettlement(s.db, s.asAna, { tripId: s.trip.id, fromMemberId: s.ana.id, toMemberId: s.ana.id, amount: 5 })).toThrow();
      expect(() => setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '0', 'member')).toThrow();
    });
    expect(entries).toEqual([]);
  });
});
