import { describe, expect, it } from 'vitest';
import {
  NotFoundError,
  ValidationError,
  changeHomeCurrency,
  claimMember,
  completeSetup,
  confirmExpense,
  createExpense,
  createSettlement,
  deleteExpense,
  discardExpense,
  endTrip,
  findPossibleDuplicates,
  getExpense,
  getMember,
  getSettlement,
  getTrip,
  getTripBalances,
  listActivity,
  listExpenses,
  listSettlements,
  listTripRates,
  previewTripRate,
  renameTrip,
  reopenTrip,
  restoreExpense,
  restoreSettlement,
  saveExpense,
  setMemberActive,
  setTripRate,
  undoSettlement,
} from '../../src/db/index.js';
import { dinner, fingerprint, sameAs, seedTwo } from './helpers.js';

describe('a record from another group', () => {
  it('every operation throws NotFoundError and changes nothing', () => {
    const { db, a, b } = seedTwo();
    // Records of group B, in every state an operation could want.
    const confirmed = createExpense(db, b.asAna, dinner(b));
    const draft = createExpense(db, b.asAna, dinner(b, { status: 'draft' }));
    const deleted = deleteExpense(db, b.asAna, createExpense(db, b.asAna, dinner(b)).id, 1);
    const discarded = discardExpense(db, b.asAna, createExpense(db, b.asAna, dinner(b, { status: 'draft' })).id, 1);
    const settlement = createSettlement(db, b.asAna, { tripId: b.trip.id, fromMemberId: b.sam.id, toMemberId: b.ana.id, amount: 100 });
    const undone = undoSettlement(db, b.asAna, createSettlement(db, b.asAna, { tripId: b.trip.id, fromMemberId: b.sam.id, toMemberId: b.ana.id, amount: 100 }).id, 1);
    setTripRate(db, b.asAna, b.trip.id, 'JPY', '112.4', 'member');

    // Group A reaches for them. The IDs are real, the versions are right, only the group is wrong.
    const asA = a.asAna;
    const attempts: Array<[string, () => unknown]> = [
      ['getTrip', () => getTrip(db, asA, b.trip.id)],
      ['renameTrip', () => renameTrip(db, asA, b.trip.id, 'Hijacked')],
      ['changeHomeCurrency', () => changeHomeCurrency(db, asA, b.trip.id, 'USD')],
      ['completeSetup', () => completeSetup(db, asA, b.trip.id)],
      ['endTrip', () => endTrip(db, asA, b.trip.id)],
      ['reopenTrip', () => reopenTrip(db, asA, b.trip.id)],
      ['listTripRates', () => listTripRates(db, asA, b.trip.id)],
      ['setTripRate', () => setTripRate(db, asA, b.trip.id, 'JPY', '100', 'member')],
      ['previewTripRate', () => previewTripRate(db, asA, b.trip.id, 'JPY', '100')],
      ['createExpense', () => createExpense(db, asA, dinner(a, { tripId: b.trip.id }))],
      ['getExpense', () => getExpense(db, asA, confirmed.id)],
      ['listExpenses', () => listExpenses(db, asA, b.trip.id)],
      ['saveExpense', () => saveExpense(db, asA, confirmed.id, confirmed.version, sameAs(a, dinner(a)))],
      ['confirmExpense', () => confirmExpense(db, asA, draft.id, draft.version)],
      ['discardExpense', () => discardExpense(db, asA, draft.id, draft.version)],
      ['deleteExpense', () => deleteExpense(db, asA, confirmed.id, confirmed.version)],
      ['restoreExpense (deleted)', () => restoreExpense(db, asA, deleted.id, deleted.version)],
      ['restoreExpense (discarded)', () => restoreExpense(db, asA, discarded.id, discarded.version)],
      ['findPossibleDuplicates', () => findPossibleDuplicates(db, asA, b.trip.id, { merchant: 'Casa Pepe', total: 1000, currency: 'SGD', expenseDate: '2026-09-27' })],
      ['createSettlement', () => createSettlement(db, asA, { tripId: b.trip.id, fromMemberId: a.sam.id, toMemberId: a.ana.id, amount: 5 })],
      ['getSettlement', () => getSettlement(db, asA, settlement.id)],
      ['listSettlements', () => listSettlements(db, asA, b.trip.id)],
      ['undoSettlement', () => undoSettlement(db, asA, settlement.id, settlement.version)],
      ['restoreSettlement', () => restoreSettlement(db, asA, undone.id, undone.version)],
      ['getTripBalances', () => getTripBalances(db, asA, b.trip.id)],
      ['listActivity', () => listActivity(db, asA, { tripId: b.trip.id })],
      ['getMember', () => getMember(db, asA, b.sam.id)],
      ['setMemberActive', () => setMemberActive(db, asA, b.sam.id, false)],
      ['claimMember', () => claimMember(db, asA, b.leo.id)],
    ];

    const before = fingerprint(db);
    for (const [name, attempt] of attempts) {
      let error: unknown;
      try {
        attempt();
      } catch (e) {
        error = e;
      }
      expect(error, name).toBeInstanceOf(NotFoundError);
      expect(fingerprint(db), name).toBe(before);
    }
    // The same error as for a record that does not exist at all.
    expect(() => getExpense(db, asA, 999_999)).toThrow(NotFoundError);
    expect((() => { try { getExpense(db, asA, confirmed.id); } catch (e) { return (e as Error).message; } return ''; })()).toBe(
      (() => { try { getExpense(db, asA, 999_999); } catch (e) { return (e as Error).message; } return ''; })(),
    );
    // And group B still reaches its own records.
    expect(getExpense(db, b.asAna, confirmed.id)).toEqual(confirmed);
  });

  it('lists never show another group', () => {
    const { db, a, b } = seedTwo();
    createExpense(db, b.asAna, dinner(b));
    createSettlement(db, b.asAna, { tripId: b.trip.id, fromMemberId: b.sam.id, toMemberId: b.ana.id, amount: 100 });
    expect(listExpenses(db, a.asAna, a.trip.id)).toEqual([]);
    expect(listSettlements(db, a.asAna, a.trip.id)).toEqual([]);
    expect(getTripBalances(db, a.asAna, a.trip.id).balances).toEqual({});
    expect(listActivity(db, a.asAna).every((entry) => entry.groupId === a.group.id)).toBe(true);
    expect(findPossibleDuplicates(db, a.asAna, a.trip.id, { merchant: 'Casa Pepe', total: 1000, currency: 'SGD', expenseDate: '2026-09-27' })).toEqual([]);
  });
});

describe('a member from another group', () => {
  it('is refused as payer, share member, item member and settlement party', () => {
    const { db, a, b } = seedTwo();
    const own = createExpense(db, a.asAna, dinner(a));
    const draft = createExpense(db, a.asAna, dinner(a, { status: 'draft' }));
    const attempts: Array<[string, () => unknown]> = [
      ['payer on create', () => createExpense(db, a.asAna, dinner(a, { payerId: b.sam.id }))],
      ['payer on a draft', () => createExpense(db, a.asAna, dinner(a, { payerId: b.sam.id, status: 'draft' }))],
      ['share on create', () => createExpense(db, a.asAna, dinner(a, { shares: [{ memberId: a.ana.id }, { memberId: b.sam.id }] }))],
      ['share on a draft', () => createExpense(db, a.asAna, dinner(a, { status: 'draft', shares: [{ memberId: b.sam.id }] }))],
      [
        'item share on create',
        () => createExpense(db, a.asAna, dinner(a, { splitType: 'items', items: [{ label: 'A', amount: 1000, shares: [{ memberId: b.sam.id }] }] })),
      ],
      ['payer on save', () => saveExpense(db, a.asAna, own.id, 1, { ...sameAs(a, dinner(a)), payerId: b.sam.id })],
      ['share on save', () => saveExpense(db, a.asAna, draft.id, 1, { ...sameAs(a, dinner(a)), shares: [{ memberId: b.sam.id }] })],
      ['settlement from', () => createSettlement(db, a.asAna, { tripId: a.trip.id, fromMemberId: b.sam.id, toMemberId: a.ana.id, amount: 5 })],
      ['settlement to', () => createSettlement(db, a.asAna, { tripId: a.trip.id, fromMemberId: a.sam.id, toMemberId: b.ana.id, amount: 5 })],
      ['unknown member', () => createExpense(db, a.asAna, dinner(a, { payerId: 999_999 }))],
    ];
    const before = fingerprint(db);
    for (const [name, attempt] of attempts) {
      let error: unknown;
      try {
        attempt();
      } catch (e) {
        error = e;
      }
      expect(error, name).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code, name).toBe('member_not_in_group');
      expect(fingerprint(db), name).toBe(before);
    }
  });
});
