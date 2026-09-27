import { describe, expect, it } from 'vitest';
import {
  NotFoundError,
  PermissionError,
  StaleEditError,
  ValidationError,
  claimMember,
  createExpense,
  createSettlement,
  endTrip,
  getExpense,
  getMember,
  getOrCreateActiveTrip,
  getSettlement,
  getTripBalances,
  listMembers,
  listTripRates,
  memberScope,
  restoreSettlement,
  saveExpense,
  setTripRate,
  undoSettlement,
  upsertTelegramMember,
  type Member,
  type Scope,
} from '../../src/db/index.js';
import { dinner, fingerprint, logged, sameAs, seed, type Seed } from './helpers.js';

/** Leo was added by hand. Later the real Leo turns up with a Telegram account and becomes a second member. */
function withRealLeo(): Seed & { realLeo: Member; asRealLeo: Scope } {
  const s = seed();
  const realLeo = upsertTelegramMember(s.db, s.asSystem, { telegramUserId: 104, displayName: 'Leonardo' }, { joinedVia: 'link' }).member;
  return { ...s, realLeo, asRealLeo: memberScope(s.group.id, realLeo.id) };
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw');
}

describe('claimMember', () => {
  it('claim with no overlap: other members balances unchanged, survivor balance is the sum', () => {
    const t = withRealLeo();
    const { db, trip, ana, sam, leo, realLeo } = t;
    // Hand-added Leo is on three expenses, in different roles. The real Leo is on a fourth.
    const paidByLeo = createExpense(db, t.asAna, dinner(t, { payerId: leo.id, total: 4000, shares: [{ memberId: ana.id }, { memberId: sam.id }] }));
    const leoInSplit = createExpense(db, t.asAna, dinner(t, { payerId: leo.id, total: 3000, splitType: 'portions', shares: [{ memberId: ana.id, weight: 1 }, { memberId: leo.id, weight: 2 }] }));
    const byItem = createExpense(
      db,
      t.asSam,
      dinner(t, {
        payerId: sam.id,
        total: 3300,
        tip: 300,
        splitType: 'items',
        shares: [{ memberId: sam.id }, { memberId: leo.id }],
        items: [
          { label: 'Beer', amount: 1000, shares: [{ memberId: leo.id }] },
          { label: 'Pizza', amount: 2000, shares: [{ memberId: leo.id }, { memberId: sam.id, weight: 3 }] },
        ],
      }),
    );
    const realLeoOnly = createExpense(db, t.asRealLeo, dinner(t, { payerId: realLeo.id, total: 900, shares: [{ memberId: realLeo.id }, { memberId: ana.id }, { memberId: sam.id }] }));
    setTripRate(db, memberScope(t.group.id, leo.id), trip.id, 'JPY', '112.4', 'member');

    const before = getTripBalances(db, t.asAna, trip.id).balances;
    expect(before[leo.id]).not.toBe(0);
    expect(before[realLeo.id]).not.toBe(0);

    const result = claimMember(db, t.asRealLeo, leo.id);
    expect(result.survivor.id).toBe(realLeo.id);
    expect(result.absorbed).toMatchObject({ id: leo.id, active: false, mergedInto: realLeo.id });
    expect(result.expenses.map((e) => e.id)).toEqual([paidByLeo.id, leoInSplit.id, byItem.id]);

    const after = getTripBalances(db, t.asAna, trip.id).balances;
    expect(after[ana.id]).toBe(before[ana.id]);
    expect(after[sam.id]).toBe(before[sam.id]);
    expect(after[realLeo.id]).toBe(before[realLeo.id]! + before[leo.id]!);
    expect(after[leo.id]).toBeUndefined();
    expect(Object.values(after).reduce((a, b) => a + b, 0)).toBe(0);

    expect(getExpense(db, t.asAna, paidByLeo.id)).toMatchObject({ payerId: realLeo.id, createdBy: ana.id, version: 2 });
    expect(getExpense(db, t.asAna, leoInSplit.id).shares.map((s) => [s.memberId, s.weight])).toEqual([[ana.id, 1], [realLeo.id, 2]]);
    const items = getExpense(db, t.asAna, byItem.id);
    expect(items.version).toBe(2);
    expect(items.shares.map((s) => [s.memberId, s.weight, s.itemId === null])).toEqual([
      [sam.id, 1, true],
      [realLeo.id, 1, true],
      [realLeo.id, 1, false],
      [sam.id, 3, false],
      [realLeo.id, 1, false],
    ]);
    expect(getExpense(db, t.asAna, realLeoOnly.id)).toEqual(realLeoOnly);
    expect(listTripRates(db, t.asAna, trip.id)[0]!.setBy).toBe(realLeo.id);

    // The absorbed member no longer appears in member lists.
    expect(listMembers(db, t.asAna).map((m) => m.id)).not.toContain(leo.id);
    expect(listMembers(db, t.asAna, { includeMerged: true }).map((m) => m.id)).toContain(leo.id);
    expect(getMember(db, t.asAna, leo.id).mergedInto).toBe(realLeo.id);
  });

  it('logs every change and raises the version of each record touched', () => {
    const t = withRealLeo();
    const expense = createExpense(t.db, t.asAna, dinner(t, { payerId: t.leo.id, shares: [{ memberId: t.ana.id }, { memberId: t.leo.id }] }));
    const settlement = createSettlement(t.db, t.asAna, { tripId: t.trip.id, fromMemberId: t.leo.id, toMemberId: t.ana.id, amount: 700 });
    const rate = setTripRate(t.db, memberScope(t.group.id, t.leo.id), t.trip.id, 'JPY', '112.4', 'member').tripRate;

    const entries = logged(t.db, () => claimMember(t.db, t.asRealLeo, t.leo.id));
    expect(entries.map((e) => [e.action, e.entityType, e.entityId])).toEqual([
      ['member.claim', 'member', t.realLeo.id],
      ['expense.member_merged', 'expense', expense.id],
      ['settlement.member_merged', 'settlement', settlement.id],
      ['trip_rate.member_merged', 'trip_rate', rate.id],
    ]);
    expect(entries.every((e) => e.actorKind === 'member' && e.actorId === t.realLeo.id)).toBe(true);
    expect(entries[0]).toMatchObject({
      before: { absorbed: { id: t.leo.id, active: true, mergedInto: null } },
      after: { absorbed: { id: t.leo.id, active: false, mergedInto: t.realLeo.id }, expenseIds: [expense.id], settlementIds: [settlement.id] },
    });
    expect(entries[1]).toMatchObject({ before: { payerId: t.leo.id, version: 1 }, after: { payerId: t.realLeo.id, version: 2 }, tripId: t.trip.id });
    expect(entries[2]).toMatchObject({ before: { fromMemberId: t.leo.id, version: 1 }, after: { fromMemberId: t.realLeo.id, version: 2 } });

    // An open editor holding the old version is refused.
    expect(() => saveExpense(t.db, t.asAna, expense.id, 1, sameAs(t, dinner(t)))).toThrow(StaleEditError);
    expect(() => undoSettlement(t.db, t.asAna, settlement.id, 1)).toThrow(StaleEditError);
  });

  it('claim where both share an expense: refused, listing the expense', () => {
    const t = withRealLeo();
    const both = createExpense(t.db, t.asAna, dinner(t, { description: 'Both Leos', shares: [{ memberId: t.leo.id }, { memberId: t.realLeo.id }, { memberId: t.ana.id }] }));
    const draftWithBoth = createExpense(t.db, t.asAna, dinner(t, { status: 'draft', description: 'Draft', shares: [{ memberId: t.leo.id }, { memberId: t.realLeo.id }] }));
    createExpense(t.db, t.asAna, dinner(t, { description: 'Only one', shares: [{ memberId: t.leo.id }, { memberId: t.ana.id }] }));

    const before = fingerprint(t.db);
    const error = caught(() => claimMember(t.db, t.asRealLeo, t.leo.id)) as ValidationError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('claim_overlap');
    expect(error.message).toBe('Remove one of the two from these expenses first');
    expect(error.expenses).toEqual([
      expect.objectContaining({ id: both.id, description: 'Both Leos', tripId: t.trip.id, total: 1000, currency: 'SGD', status: 'confirmed' }),
      expect.objectContaining({ id: draftWithBoth.id, description: 'Draft', status: 'draft' }),
    ]);
    expect(fingerprint(t.db)).toBe(before);

    // After removing one of the two from each, the claim goes through.
    saveExpense(t.db, t.asAna, both.id, 1, { ...sameAs(t, dinner(t)), shares: [{ memberId: t.leo.id }, { memberId: t.ana.id }] });
    saveExpense(t.db, t.asAna, draftWithBoth.id, 1, { ...sameAs(t, dinner(t)), shares: [{ memberId: t.realLeo.id }] });
    expect(claimMember(t.db, t.asRealLeo, t.leo.id).absorbed.mergedInto).toBe(t.realLeo.id);
  });

  it('refuses when both are assigned to the same item, in a trip that has ended', () => {
    const t = withRealLeo();
    const lunch = createExpense(
      t.db,
      t.asAna,
      dinner(t, {
        splitType: 'items',
        shares: [{ memberId: t.ana.id }, { memberId: t.sam.id }],
        items: [{ label: 'Set', amount: 1000 }],
      }),
    );
    // Put both on one item directly, as older data might have it.
    const itemId = lunch.items[0]!.id;
    t.db.prepare('INSERT INTO share (member_id, weight, item_id) VALUES (?, 1, ?), (?, 1, ?)').run(t.leo.id, itemId, t.realLeo.id, itemId);
    endTrip(t.db, t.asAna, t.trip.id);
    getOrCreateActiveTrip(t.db, t.asAna);
    const error = caught(() => claimMember(t.db, t.asRealLeo, t.leo.id)) as ValidationError;
    expect(error.code).toBe('claim_overlap');
    expect(error.expenses.map((e) => e.id)).toEqual([lunch.id]);
  });

  it('claim where the absorbed member had paid a third member: the settlement moves to the survivor', () => {
    const t = withRealLeo();
    createExpense(t.db, t.asAna, dinner(t, { total: 2100, shares: [{ memberId: t.ana.id }, { memberId: t.sam.id }, { memberId: t.leo.id }] }));
    const paid = createSettlement(t.db, t.asAna, { tripId: t.trip.id, fromMemberId: t.leo.id, toMemberId: t.ana.id, amount: 700 });
    const received = createSettlement(t.db, memberScope(t.group.id, t.leo.id), { tripId: t.trip.id, fromMemberId: t.sam.id, toMemberId: t.leo.id, amount: 50 });
    const undone = undoSettlement(t.db, t.asAna, createSettlement(t.db, t.asAna, { tripId: t.trip.id, fromMemberId: t.leo.id, toMemberId: t.sam.id, amount: 5 }).id, 1);
    const before = getTripBalances(t.db, t.asAna, t.trip.id).balances;

    const result = claimMember(t.db, t.asRealLeo, t.leo.id);
    expect(result.settlements.map((s) => s.id)).toEqual([paid.id, received.id, undone.id]);
    expect(getSettlement(t.db, t.asAna, paid.id)).toMatchObject({ fromMemberId: t.realLeo.id, toMemberId: t.ana.id, status: 'active', amount: 700, version: 2 });
    expect(getSettlement(t.db, t.asAna, received.id)).toMatchObject({ fromMemberId: t.sam.id, toMemberId: t.realLeo.id, createdBy: t.realLeo.id, status: 'active', version: 2 });
    // Undone ones move too, and can be restored afterwards.
    expect(getSettlement(t.db, t.asAna, undone.id)).toMatchObject({ fromMemberId: t.realLeo.id, toMemberId: t.sam.id, status: 'undone', version: 3 });
    expect(restoreSettlement(t.db, t.asAna, undone.id, 3).status).toBe('active');
    undoSettlement(t.db, t.asAna, undone.id, 4);

    const after = getTripBalances(t.db, t.asAna, t.trip.id).balances;
    expect(after[t.ana.id]).toBe(before[t.ana.id]);
    expect(after[t.sam.id]).toBe(before[t.sam.id]);
    expect(after[t.realLeo.id]).toBe((before[t.realLeo.id] ?? 0) + before[t.leo.id]!);
  });

  it('claim with a settlement between the two: marked undone', () => {
    const t = withRealLeo();
    const between = createSettlement(t.db, t.asAna, { tripId: t.trip.id, fromMemberId: t.realLeo.id, toMemberId: t.leo.id, amount: 500 });
    const wasUndone = undoSettlement(t.db, t.asAna, createSettlement(t.db, t.asAna, { tripId: t.trip.id, fromMemberId: t.leo.id, toMemberId: t.realLeo.id, amount: 80 }).id, 1);
    const before = getTripBalances(t.db, t.asAna, t.trip.id).balances;
    expect(before).toEqual({ [t.leo.id]: -500, [t.realLeo.id]: 500 });

    claimMember(t.db, t.asRealLeo, t.leo.id);
    expect(getSettlement(t.db, t.asAna, between.id)).toMatchObject({ status: 'undone', fromMemberId: t.realLeo.id, toMemberId: t.realLeo.id, version: 2 });
    expect(getSettlement(t.db, t.asAna, wasUndone.id)).toMatchObject({ status: 'undone', fromMemberId: t.realLeo.id, toMemberId: t.realLeo.id, version: 3 });
    // Nobody owes themselves: the two balances cancel out.
    expect(getTripBalances(t.db, t.asAna, t.trip.id).balances).toEqual({});

    const error = caught(() => restoreSettlement(t.db, t.asAna, between.id, 2)) as ValidationError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('invalid_status');
  });

  it('works across all trips of the group', () => {
    const t = withRealLeo();
    const old = createExpense(t.db, t.asAna, dinner(t, { payerId: t.leo.id, shares: [{ memberId: t.ana.id }, { memberId: t.leo.id }] }));
    endTrip(t.db, t.asAna, t.trip.id);
    const next = getOrCreateActiveTrip(t.db, t.asAna).trip;
    const recent = createExpense(t.db, t.asAna, dinner(t, { tripId: next.id, shares: [{ memberId: t.leo.id }] }));
    const before = [t.trip.id, next.id].map((id) => getTripBalances(t.db, t.asAna, id).balances);

    claimMember(t.db, t.asRealLeo, t.leo.id);
    expect(getExpense(t.db, t.asAna, old.id)).toMatchObject({ payerId: t.realLeo.id, version: 2 });
    expect(getExpense(t.db, t.asAna, recent.id).shares.map((s) => s.memberId)).toEqual([t.realLeo.id]);
    [t.trip.id, next.id].forEach((id, i) => {
      const after = getTripBalances(t.db, t.asAna, id).balances;
      expect(after[t.ana.id]).toBe(before[i]![t.ana.id]);
      expect(after[t.realLeo.id]).toBe(before[i]![t.leo.id]);
    });
  });

  it('refuses rather than move a rounding difference onto someone else', () => {
    const t = withRealLeo();
    // 10.00 between Sam, Leo and nobody who paid: the leftover cent goes to the lowest ID, which is Sam.
    // After the claim Leo has a higher ID than before, but Sam is still the lowest, so nothing moves.
    const harmless = createExpense(t.db, t.asAna, dinner(t, { payerId: t.ana.id, total: 1000, shares: [{ memberId: t.sam.id }, { memberId: t.leo.id }, { memberId: t.ana.id }] }));
    expect(harmless.id).toBeGreaterThan(0);

    // Here hand-added Leo has the lowest ID in the split and gets the leftover cent. Under the survivor's
    // higher ID the cent would go to Mia instead.
    const mia = upsertTelegramMember(t.db, t.asSystem, { telegramUserId: 105, displayName: 'Mia' }).member;
    const zoe = upsertTelegramMember(t.db, t.asSystem, { telegramUserId: 106, displayName: 'Zoe' }).member;
    const late = upsertTelegramMember(t.db, t.asSystem, { telegramUserId: 107, displayName: 'Late Leo' }).member;
    expect(t.leo.id).toBeLessThan(mia.id);
    expect(late.id).toBeGreaterThan(zoe.id);
    const shifting = createExpense(t.db, t.asAna, dinner(t, { description: 'Cent', payerId: t.ana.id, total: 1000, shares: [{ memberId: t.leo.id }, { memberId: mia.id }, { memberId: zoe.id }] }));

    const before = fingerprint(t.db);
    const error = caught(() => claimMember(t.db, memberScope(t.group.id, late.id), t.leo.id)) as ValidationError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('claim_changes_amounts');
    expect(error.expenses.map((e) => e.id)).toEqual([shifting.id]);
    expect(fingerprint(t.db)).toBe(before);
  });

  it('refuses a target that is not a hand-added member of the group', () => {
    const t = withRealLeo();
    const code = (fn: () => unknown) => (caught(fn) as ValidationError).code;
    expect(code(() => claimMember(t.db, t.asRealLeo, t.sam.id))).toBe('invalid_status');
    expect(code(() => claimMember(t.db, t.asRealLeo, t.realLeo.id))).toBe('invalid_status');
    expect(code(() => claimMember(t.db, memberScope(t.group.id, t.leo.id), t.leo.id))).toBe('invalid_input');
    expect(() => claimMember(t.db, t.asSystem, t.leo.id)).toThrow(PermissionError);
    expect(() => claimMember(t.db, t.asRealLeo, 9999)).toThrow(NotFoundError);

    claimMember(t.db, t.asRealLeo, t.leo.id);
    expect(code(() => claimMember(t.db, t.asAna, t.leo.id))).toBe('invalid_status');
    // The absorbed member cannot be used or act any more.
    expect(code(() => createExpense(t.db, t.asAna, dinner(t, { payerId: t.leo.id })))).toBe('member_not_in_group');
    expect(code(() => createExpense(t.db, t.asAna, dinner(t, { shares: [{ memberId: t.leo.id }] })))).toBe('member_not_in_group');
    expect(code(() => createSettlement(t.db, t.asAna, { tripId: t.trip.id, fromMemberId: t.leo.id, toMemberId: t.ana.id, amount: 5 }))).toBe('member_not_in_group');
    expect(() => createExpense(t.db, memberScope(t.group.id, t.leo.id), dinner(t))).toThrow(PermissionError);
  });
});
