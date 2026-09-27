import { describe, expect, it } from 'vitest';
import { amountsToRecord, computeShares } from '../../src/core/index.js';
import {
  NotFoundError,
  PermissionError,
  StaleEditError,
  ValidationError,
  completeSetup,
  confirmExpense,
  createExpense,
  createSettlement,
  deleteExpense,
  discardExpense,
  endTrip,
  findPossibleDuplicates,
  getActiveTrip,
  getExpense,
  getOrCreateActiveTrip,
  getTrip,
  getTripBalances,
  listExpenses,
  listSettlements,
  listTrips,
  renameTrip,
  reopenTrip,
  restoreExpense,
  restoreSettlement,
  saveExpense,
  setMemberActive,
  setTripRate,
  changeHomeCurrency,
  undoSettlement,
  type CreateExpenseInput,
  type ExpenseDetail,
} from '../../src/db/index.js';
import { dinner, fingerprint, logged, ramen, sameAs, seed, type Seed } from './helpers.js';

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw');
}
const code = (fn: () => unknown) => {
  const error = caught(fn);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).code;
};

describe('createExpense and getExpense', () => {
  it('stores the whole expense with items and shares and reads it back in order', () => {
    const s = seed();
    const created = createExpense(
      s.db,
      s.asAna,
      dinner(s, {
        total: 1600,
        tax: 100,
        splitType: 'items',
        receiptFileId: 'AgACAgQAAx',
        items: [
          { label: 'Paella', quantity: 2, amount: 1000, shares: [{ memberId: s.ana.id }, { memberId: s.sam.id, weight: 2 }] },
          { label: 'Bread', amount: 500 },
        ],
      }),
    );
    expect(created).toMatchObject({
      status: 'confirmed',
      statusBeforeRemoval: null,
      version: 1,
      createdBy: s.ana.id,
      currency: 'SGD',
      currencyNeedsReview: false,
      taxIncluded: false,
      fxRate: '1',
      fxRateSource: 'home',
    });
    expect(created.items.map((i) => [i.label, i.quantity, i.amount, i.position])).toEqual([
      ['Paella', 2, 1000, 0],
      ['Bread', 1, 500, 1],
    ]);
    const paella = created.items[0]!.id;
    expect(created.shares.map((sh) => [sh.memberId, sh.weight, sh.expenseId, sh.itemId])).toEqual([
      [s.ana.id, 1, created.id, null],
      [s.sam.id, 1, created.id, null],
      [s.leo.id, 1, created.id, null],
      [s.ana.id, 1, null, paella],
      [s.sam.id, 2, null, paella],
    ]);
    expect(getExpense(s.db, s.asSam, created.id)).toEqual(created);
  });

  it('item with quantity 2 keeps its line total', () => {
    const s = seed();
    const e = createExpense(s.db, s.asAna, dinner(s, { total: 1600, splitType: 'items', items: [{ label: 'Beer', quantity: 2, amount: 1600 }], shares: [{ memberId: s.ana.id }, { memberId: s.sam.id }] }));
    expect(e.items[0]).toMatchObject({ quantity: 2, amount: 1600 });
    expect(amountsToRecord(computeShares(e, e.items, e.shares))).toEqual({ [s.ana.id]: 800, [s.sam.id]: 800 });
  });

  it('works out the rate itself and ignores rate fields it is not meant to read', () => {
    const s = seed();
    const sneaky = { ...dinner(s), fxRate: '5', fxRateSource: 'expense', version: 9, createdBy: s.sam.id } as CreateExpenseInput;
    expect(createExpense(s.db, s.asAna, sneaky)).toMatchObject({ fxRate: '1', fxRateSource: 'home', version: 1, createdBy: s.ana.id });
    // A rate given for the home currency is ignored.
    expect(createExpense(s.db, s.asAna, dinner(s, { rateOverride: '3' }))).toMatchObject({ fxRate: '1', fxRateSource: 'home' });
  });

  it('refuses a confirmed expense that does not add up, names the difference, and stores nothing', () => {
    const s = seed();
    const input = dinner(s, { total: 2000, tax: 100, splitType: 'items', items: [{ label: 'A', amount: 1500 }] });
    const before = fingerprint(s.db);
    const error = caught(() => createExpense(s.db, s.asAna, input)) as ValidationError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('invalid_expense');
    expect(error.problems).toEqual([expect.objectContaining({ field: 'total', code: 'total_mismatch', difference: 400 })]);
    expect(fingerprint(s.db)).toBe(before);

    const draft = createExpense(s.db, s.asAna, { ...input, status: 'draft' });
    expect(code(() => confirmExpense(s.db, s.asAna, draft.id, draft.version))).toBe('invalid_expense');
    const fixed = saveExpense(s.db, s.asAna, draft.id, draft.version, { ...sameAs(s, input), total: 1600 });
    expect(confirmExpense(s.db, s.asAna, fixed.id, fixed.version).status).toBe('confirmed');
  });

  it('lets a draft be incomplete, but not wrong', () => {
    const s = seed();
    const draft = createExpense(s.db, s.asAna, dinner(s, { status: 'draft', total: 0, shares: [] }));
    expect(draft).toMatchObject({ status: 'draft', total: 0, shares: [] });
    const bad = (over: Partial<CreateExpenseInput>) => code(() => createExpense(s.db, s.asAna, dinner(s, { status: 'draft', ...over })));
    expect(bad({ total: 10.5 })).toBe('invalid_input');
    expect(bad({ total: -1 })).toBe('invalid_input');
    expect(bad({ expenseDate: '27/09/2026' })).toBe('invalid_input');
    expect(bad({ expenseDate: '2026-02-30' })).toBe('invalid_input');
    expect(bad({ shares: [{ memberId: s.ana.id }, { memberId: s.ana.id }] })).toBe('invalid_input');
    expect(bad({ shares: [{ memberId: s.ana.id, weight: 0 }] })).toBe('invalid_input');
    expect(bad({ shares: [{ memberId: s.ana.id, weight: 1.5 }] })).toBe('invalid_input');
    expect(bad({ splitType: 'half' as never })).toBe('invalid_input');
    expect(bad({ currency: 'EUR' })).toBe('unsupported_currency');
    expect(bad({ items: [{ label: 'A', amount: -5 }] })).toBe('invalid_input');
    expect(bad({ rateOverride: '0', currency: 'JPY' })).toBe('invalid_input');
  });

  it('a member assigned to an item must be included in the expense', () => {
    const s = seed();
    const input = dinner(s, {
      splitType: 'items',
      shares: [{ memberId: s.ana.id }],
      items: [{ label: 'A', amount: 1000, shares: [{ memberId: s.sam.id }] }],
    });
    const before = fingerprint(s.db);
    expect(() => createExpense(s.db, s.asAna, input)).toThrow(/must be included/);
    expect(() => createExpense(s.db, s.asAna, { ...input, status: 'draft' })).toThrow(/must be included/);
    expect(fingerprint(s.db)).toBe(before);
  });

  it('needs a member as actor, active or not', () => {
    const s = seed();
    expect(() => createExpense(s.db, s.asSystem, dinner(s))).toThrow(PermissionError);
    setMemberActive(s.db, s.asSystem, s.sam.id, false);
    expect(createExpense(s.db, s.asSam, dinner(s)).createdBy).toBe(s.sam.id);
    expect(createExpense(s.db, s.asAna, dinner(s, { payerId: s.sam.id })).payerId).toBe(s.sam.id);
  });
});

describe('saveExpense', () => {
  it('replaces fields, items and shares in one go and raises the version', () => {
    const s = seed();
    const created = createExpense(s.db, s.asAna, dinner(s, { tip: 50, total: 1050, splitType: 'items', items: [{ label: 'Set menu', amount: 1000 }] }));
    const saved = saveExpense(s.db, s.asSam, created.id, 1, {
      payerId: s.sam.id,
      expenseDate: '2026-09-28',
      total: 900,
      splitType: 'portions',
      shares: [{ memberId: s.ana.id, weight: 2 }, { memberId: s.sam.id, weight: 1 }],
    });
    expect(saved).toMatchObject({
      id: created.id,
      version: 2,
      payerId: s.sam.id,
      createdBy: s.ana.id,
      description: '',
      merchant: null,
      tip: 0,
      total: 900,
      splitType: 'portions',
      items: [],
      status: 'confirmed',
    });
    expect(saved.shares.map((sh) => [sh.memberId, sh.weight])).toEqual([[s.ana.id, 2], [s.sam.id, 1]]);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM expense_item').get()).toEqual({ n: 0 });
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM share').get()).toEqual({ n: 2 });
  });

  it('refuses a confirmed expense that would no longer be valid, and changes nothing', () => {
    const s = seed();
    const created = createExpense(s.db, s.asAna, dinner(s));
    const before = fingerprint(s.db);
    expect(code(() => saveExpense(s.db, s.asAna, created.id, 1, { ...sameAs(s, dinner(s)), shares: [] }))).toBe('invalid_expense');
    expect(code(() => saveExpense(s.db, s.asAna, created.id, 1, { ...sameAs(s, dinner(s)), total: 0 }))).toBe('invalid_expense');
    expect(fingerprint(s.db)).toBe(before);
  });

  it('keeps the receipt reference unless told otherwise', () => {
    const s = seed();
    const draft = createExpense(s.db, s.asAna, dinner(s, { status: 'draft', receiptFileId: 'file-1' }));
    const saved = saveExpense(s.db, s.asAna, draft.id, 1, sameAs(s, dinner(s)));
    expect(saved.receiptFileId).toBe('file-1');
    expect(saveExpense(s.db, s.asAna, draft.id, 2, { ...sameAs(s, dinner(s)), receiptFileId: null }).receiptFileId).toBeNull();
  });

  it('clears the currency review flag when saved with the currency chosen', () => {
    const s = seed();
    const draft = createExpense(s.db, s.asAna, dinner(s, { status: 'draft', currencyNeedsReview: true }));
    expect(draft.currencyNeedsReview).toBe(true);
    expect(code(() => confirmExpense(s.db, s.asAna, draft.id, 1))).toBe('currency_needs_review');
    expect(code(() => createExpense(s.db, s.asAna, dinner(s, { currencyNeedsReview: true })))).toBe('currency_needs_review');

    const untouched = saveExpense(s.db, s.asAna, draft.id, 1, sameAs(s, dinner(s)));
    expect(untouched.currencyNeedsReview).toBe(true);
    const chosen = saveExpense(s.db, s.asAna, draft.id, 2, { ...sameAs(s, dinner(s)), currency: 'SGD' });
    expect(chosen.currencyNeedsReview).toBe(false);
    expect(confirmExpense(s.db, s.asAna, draft.id, 3).status).toBe('confirmed');
  });
});

describe('status changes', () => {
  it('follows the table of allowed changes', () => {
    const s = seed();
    let confirmed = createExpense(s.db, s.asAna, dinner(s));
    let draft = createExpense(s.db, s.asSam, dinner(s, { status: 'draft', receiptFileId: 'file-1' }));

    confirmed = deleteExpense(s.db, s.asSam, confirmed.id, 1);
    expect(confirmed).toMatchObject({ status: 'deleted', statusBeforeRemoval: 'confirmed', version: 2 });
    draft = discardExpense(s.db, s.asAna, draft.id, 1);
    expect(draft).toMatchObject({ status: 'discarded', statusBeforeRemoval: 'draft', version: 2, receiptFileId: 'file-1' });

    expect(listExpenses(s.db, s.asAna, s.trip.id)).toEqual([]);
    expect(listExpenses(s.db, s.asAna, s.trip.id, { status: ['deleted', 'discarded'] }).map((e) => e.id).sort()).toEqual([confirmed.id, draft.id].sort());
    expect(listExpenses(s.db, s.asAna, s.trip.id, { status: 'deleted' }).map((e) => e.id)).toEqual([confirmed.id]);

    expect(restoreExpense(s.db, s.asAna, confirmed.id, 2)).toMatchObject({ status: 'confirmed', statusBeforeRemoval: null, version: 3 });
    expect(restoreExpense(s.db, s.asAna, draft.id, 2)).toMatchObject({ status: 'draft', statusBeforeRemoval: null, version: 3 });
    expect(confirmExpense(s.db, s.asAna, draft.id, 3)).toMatchObject({ status: 'confirmed', version: 4 });
  });

  it('refuses any other change of status with ValidationError, and changes nothing', () => {
    const s = seed();
    const confirmed = createExpense(s.db, s.asAna, dinner(s));
    const draft = createExpense(s.db, s.asAna, dinner(s, { status: 'draft' }));
    const deleted = deleteExpense(s.db, s.asAna, createExpense(s.db, s.asAna, dinner(s)).id, 1);
    const discarded = discardExpense(s.db, s.asAna, createExpense(s.db, s.asAna, dinner(s, { status: 'draft' })).id, 1);
    const before = fingerprint(s.db);
    const refused: Array<[string, () => unknown]> = [
      ['confirm confirmed', () => confirmExpense(s.db, s.asAna, confirmed.id, 1)],
      ['confirm deleted', () => confirmExpense(s.db, s.asAna, deleted.id, 2)],
      ['confirm discarded', () => confirmExpense(s.db, s.asAna, discarded.id, 2)],
      ['discard confirmed', () => discardExpense(s.db, s.asAna, confirmed.id, 1)],
      ['discard discarded', () => discardExpense(s.db, s.asAna, discarded.id, 2)],
      ['delete draft', () => deleteExpense(s.db, s.asAna, draft.id, 1)],
      ['delete deleted', () => deleteExpense(s.db, s.asAna, deleted.id, 2)],
      ['restore draft', () => restoreExpense(s.db, s.asAna, draft.id, 1)],
      ['restore confirmed', () => restoreExpense(s.db, s.asAna, confirmed.id, 1)],
      ['save deleted', () => saveExpense(s.db, s.asAna, deleted.id, 2, sameAs(s, dinner(s)))],
      ['save discarded', () => saveExpense(s.db, s.asAna, discarded.id, 2, sameAs(s, dinner(s)))],
    ];
    for (const [name, fn] of refused) expect(code(fn), name).toBe('invalid_status');
    expect(fingerprint(s.db)).toBe(before);

    const settlement = createSettlement(s.db, s.asAna, { tripId: s.trip.id, fromMemberId: s.sam.id, toMemberId: s.ana.id, amount: 5 });
    expect(code(() => restoreSettlement(s.db, s.asAna, settlement.id, 1))).toBe('invalid_status');
    undoSettlement(s.db, s.asAna, settlement.id, 1);
    expect(code(() => undoSettlement(s.db, s.asAna, settlement.id, 2))).toBe('invalid_status');
  });

  it('a version is always needed', () => {
    const s = seed();
    const e = createExpense(s.db, s.asAna, dinner(s));
    expect(code(() => deleteExpense(s.db, s.asAna, e.id, undefined as unknown as number))).toBe('invalid_input');
    expect(code(() => saveExpense(s.db, s.asAna, e.id, '1' as unknown as number, sameAs(s, dinner(s))))).toBe('invalid_input');
  });
});

describe('stale versions', () => {
  function stale(fn: () => unknown, current: unknown, s: Seed) {
    const before = fingerprint(s.db);
    const error = caught(fn);
    expect(error).toBeInstanceOf(StaleEditError);
    expect((error as StaleEditError).current).toEqual(current);
    expect((error as StaleEditError).message).toMatch(/changed by someone else/i);
    expect(fingerprint(s.db)).toBe(before);
  }

  it('refused on save, confirm, discard, delete and restore, carrying the current expense', () => {
    const s = seed();
    // Each expense is at version 2 while the caller still holds version 1.
    const bump = (e: ExpenseDetail) => saveExpense(s.db, s.asSam, e.id, e.version, { ...sameAs(s, dinner(s)), total: 1100 });
    const confirmed = bump(createExpense(s.db, s.asAna, dinner(s)));
    const draft = bump(createExpense(s.db, s.asAna, dinner(s, { status: 'draft' })));
    const deleted = deleteExpense(s.db, s.asAna, createExpense(s.db, s.asAna, dinner(s)).id, 1);
    const discarded = discardExpense(s.db, s.asAna, createExpense(s.db, s.asAna, dinner(s, { status: 'draft' })).id, 1);

    stale(() => saveExpense(s.db, s.asAna, confirmed.id, 1, { ...sameAs(s, dinner(s)), total: 9999 }), confirmed, s);
    stale(() => confirmExpense(s.db, s.asAna, draft.id, 1), draft, s);
    stale(() => discardExpense(s.db, s.asAna, draft.id, 1), draft, s);
    stale(() => deleteExpense(s.db, s.asAna, confirmed.id, 1), confirmed, s);
    stale(() => restoreExpense(s.db, s.asAna, deleted.id, 1), deleted, s);
    stale(() => restoreExpense(s.db, s.asAna, discarded.id, 1), discarded, s);
    stale(() => deleteExpense(s.db, s.asAna, confirmed.id, 3), confirmed, s);

    expect(getExpense(s.db, s.asAna, confirmed.id).total).toBe(1100);
    expect(saveExpense(s.db, s.asAna, confirmed.id, 2, { ...sameAs(s, dinner(s)), total: 1300 }).version).toBe(3);
  });

  it('refused on undo and restore of a settlement, carrying the current settlement', () => {
    const s = seed();
    const created = createSettlement(s.db, s.asSam, { tripId: s.trip.id, fromMemberId: s.sam.id, toMemberId: s.ana.id, amount: 300 });
    expect(created).toMatchObject({ version: 1, status: 'active', createdBy: s.sam.id });
    stale(() => undoSettlement(s.db, s.asAna, created.id, 2), created, s);
    const undone = undoSettlement(s.db, s.asAna, created.id, 1);
    expect(undone).toMatchObject({ status: 'undone', version: 2 });
    stale(() => restoreSettlement(s.db, s.asAna, created.id, 1), undone, s);
    expect(restoreSettlement(s.db, s.asAna, created.id, 2)).toMatchObject({ status: 'active', version: 3 });
  });

  it('a save with an old version after someone else changed shares is refused', () => {
    const s = seed();
    const opened = createExpense(s.db, s.asAna, dinner(s));
    // Sam takes Leo out of the split while Ana still has the form open.
    const bySam = saveExpense(s.db, s.asSam, opened.id, opened.version, { ...sameAs(s, dinner(s)), shares: [{ memberId: s.ana.id }, { memberId: s.sam.id }] });
    expect(bySam.version).toBe(2);
    stale(() => saveExpense(s.db, s.asAna, opened.id, opened.version, { ...sameAs(s, dinner(s)), description: 'Late dinner' }), bySam, s);
    expect(getExpense(s.db, s.asAna, opened.id).shares.map((sh) => sh.memberId)).toEqual([s.ana.id, s.sam.id]);
  });
});

describe('trips', () => {
  it('renames, finishes setup and logs each', () => {
    const s = seed();
    expect(logged(s.db, () => renameTrip(s.db, s.asAna, s.trip.id, 'Tokyo')).map((e) => e.action)).toEqual(['trip.rename']);
    expect(logged(s.db, () => renameTrip(s.db, s.asAna, s.trip.id, 'Tokyo'))).toEqual([]);
    expect(logged(s.db, () => completeSetup(s.db, s.asAna, s.trip.id)).map((e) => e.action)).toEqual(['trip.setup_done']);
    expect(logged(s.db, () => completeSetup(s.db, s.asAna, s.trip.id))).toEqual([]);
    expect(getTrip(s.db, s.asAna, s.trip.id)).toMatchObject({ name: 'Tokyo', setupDone: true });
  });

  it('creates the next trip named after the group with the home currency of the most recent trip', () => {
    const s = seed();
    changeHomeCurrency(s.db, s.asAna, s.trip.id, 'MYR');
    expect(getOrCreateActiveTrip(s.db, s.asAna)).toMatchObject({ created: false, trip: { id: s.trip.id } });
    endTrip(s.db, s.asAna, s.trip.id);
    expect(getActiveTrip(s.db, s.asAna)).toBeUndefined();

    let result: ReturnType<typeof getOrCreateActiveTrip> | undefined;
    expect(logged(s.db, () => (result = getOrCreateActiveTrip(s.db, s.asSam))).map((e) => e.action)).toEqual(['trip.create']);
    expect(result).toMatchObject({ created: true, trip: { name: 'Japan 2026', homeCurrency: 'MYR', status: 'active', homeCurrencyLocked: false, setupDone: false } });
    expect(logged(s.db, () => getOrCreateActiveTrip(s.db, s.asSam))).toEqual([]);
    expect(listTrips(s.db, s.asAna).map((t) => t.status)).toEqual(['active', 'ended']);
    expect(listTrips(s.db, s.asAna, { status: 'ended' }).map((t) => t.id)).toEqual([s.trip.id]);
  });

  it('reopens a trip only when the group has no active trip', () => {
    const s = seed();
    expect(code(() => reopenTrip(s.db, s.asAna, s.trip.id))).toBe('invalid_status');
    endTrip(s.db, s.asAna, s.trip.id);
    expect(code(() => endTrip(s.db, s.asAna, s.trip.id))).toBe('invalid_status');
    const next = getOrCreateActiveTrip(s.db, s.asAna).trip;
    expect(code(() => reopenTrip(s.db, s.asAna, s.trip.id))).toBe('active_trip_exists');
    endTrip(s.db, s.asAna, next.id);
    expect(reopenTrip(s.db, s.asAna, s.trip.id)).toMatchObject({ status: 'active', endedAt: null });
  });

  it('only settlements can be changed on an ended trip', () => {
    const s = seed();
    const expense = createExpense(s.db, s.asAna, dinner(s));
    const draft = createExpense(s.db, s.asAna, dinner(s, { status: 'draft' }));
    const deleted = deleteExpense(s.db, s.asAna, createExpense(s.db, s.asAna, dinner(s)).id, 1);
    setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.4', 'member');
    endTrip(s.db, s.asAna, s.trip.id);

    const before = fingerprint(s.db);
    const refused: Array<[string, () => unknown]> = [
      ['createExpense', () => createExpense(s.db, s.asAna, dinner(s))],
      ['createExpense draft', () => createExpense(s.db, s.asAna, dinner(s, { status: 'draft' }))],
      ['saveExpense', () => saveExpense(s.db, s.asAna, expense.id, 1, sameAs(s, dinner(s)))],
      ['deleteExpense', () => deleteExpense(s.db, s.asAna, expense.id, 1)],
      ['confirmExpense', () => confirmExpense(s.db, s.asAna, draft.id, 1)],
      ['discardExpense', () => discardExpense(s.db, s.asAna, draft.id, 1)],
      ['restoreExpense', () => restoreExpense(s.db, s.asAna, deleted.id, 2)],
      ['renameTrip', () => renameTrip(s.db, s.asAna, s.trip.id, 'x')],
      ['changeHomeCurrency', () => changeHomeCurrency(s.db, s.asAna, s.trip.id, 'USD')],
      ['completeSetup', () => completeSetup(s.db, s.asAna, s.trip.id)],
      ['setTripRate', () => setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '110', 'member')],
    ];
    for (const [name, fn] of refused) expect(code(fn), name).toBe('trip_ended');
    expect(fingerprint(s.db)).toBe(before);

    const settlement = createSettlement(s.db, s.asSam, { tripId: s.trip.id, fromMemberId: s.sam.id, toMemberId: s.ana.id, amount: 333 });
    expect(undoSettlement(s.db, s.asAna, settlement.id, 1).status).toBe('undone');
    expect(restoreSettlement(s.db, s.asAna, settlement.id, 2).status).toBe('active');
    expect(getTripBalances(s.db, s.asAna, s.trip.id).balances[s.sam.id]).toBe(-333 + 333);
    expect(reopenTrip(s.db, s.asAna, s.trip.id).status).toBe('active');
    expect(deleteExpense(s.db, s.asAna, expense.id, 1).status).toBe('deleted');
  });

  it('settling an ended trip while a newer trip is active records against the ended trip', () => {
    const s = seed();
    endTrip(s.db, s.asAna, s.trip.id);
    const next = getOrCreateActiveTrip(s.db, s.asAna).trip;
    const settlement = createSettlement(s.db, s.asSam, { tripId: s.trip.id, fromMemberId: s.sam.id, toMemberId: s.ana.id, amount: 333 });
    expect(settlement.tripId).toBe(s.trip.id);
    expect(listSettlements(s.db, s.asAna, next.id)).toEqual([]);
    expect(listSettlements(s.db, s.asAna, s.trip.id).map((x) => x.id)).toEqual([settlement.id]);
  });
});

describe('settlements and balances', () => {
  it('recomputes balances from confirmed expenses and active settlements', () => {
    const s = seed();
    createExpense(s.db, s.asAna, dinner(s, { total: 3000 }));
    createExpense(s.db, s.asAna, dinner(s, { total: 99999, status: 'draft' }));
    const settlement = createSettlement(s.db, s.asSam, { tripId: s.trip.id, fromMemberId: s.sam.id, toMemberId: s.ana.id, amount: 1000 });
    let result = getTripBalances(s.db, s.asAna, s.trip.id);
    expect(result.balances).toEqual({ [s.ana.id]: 1000, [s.sam.id]: 0, [s.leo.id]: -1000 });
    expect(result.payments).toEqual([{ fromMemberId: s.leo.id, toMemberId: s.ana.id, amount: 1000 }]);
    expect(JSON.parse(JSON.stringify(result)).balances).toEqual(result.balances);

    undoSettlement(s.db, s.asAna, settlement.id, 1);
    expect(listSettlements(s.db, s.asAna, s.trip.id, { status: 'active' })).toEqual([]);
    expect(listSettlements(s.db, s.asAna, s.trip.id)).toHaveLength(1);
    result = getTripBalances(s.db, s.asAna, s.trip.id);
    expect(result.balances).toEqual({ [s.ana.id]: 2000, [s.sam.id]: -1000, [s.leo.id]: -1000 });
  });

  it('refuses a payment to oneself, a zero amount and the system as creator', () => {
    const s = seed();
    const pay = (over: object) => () => createSettlement(s.db, s.asAna, { tripId: s.trip.id, fromMemberId: s.sam.id, toMemberId: s.ana.id, amount: 5, ...over });
    expect(code(pay({ toMemberId: s.sam.id }))).toBe('invalid_input');
    expect(code(pay({ amount: 0 }))).toBe('invalid_input');
    expect(code(pay({ amount: 1.5 }))).toBe('invalid_input');
    expect(() => createSettlement(s.db, s.asSystem, { tripId: s.trip.id, fromMemberId: s.sam.id, toMemberId: s.ana.id, amount: 5 })).toThrow(PermissionError);
    expect(() => createSettlement(s.db, s.asAna, { tripId: 999, fromMemberId: s.sam.id, toMemberId: s.ana.id, amount: 5 })).toThrow(NotFoundError);
  });
});

describe('findPossibleDuplicates', () => {
  it('matches total, currency, date and merchant ignoring case and spacing', () => {
    const s = seed();
    setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.4', 'member');
    const first = createExpense(s.db, s.asAna, dinner(s, { merchant: 'Casa Pepe' }));
    const draft = createExpense(s.db, s.asAna, dinner(s, { merchant: 'CASA PEPE', status: 'draft' }));
    createExpense(s.db, s.asAna, dinner(s, { merchant: 'Casa Pepe', total: 999 }));
    createExpense(s.db, s.asAna, dinner(s, { merchant: 'Casa Pepe', expenseDate: '2026-09-26' }));
    createExpense(s.db, s.asAna, dinner(s, { merchant: 'Casa Pepe', currency: 'JPY' }));
    createExpense(s.db, s.asAna, dinner(s, { merchant: 'Casa Pepa' }));
    deleteExpense(s.db, s.asAna, createExpense(s.db, s.asAna, dinner(s, { merchant: 'Casa Pepe' })).id, 1);
    discardExpense(s.db, s.asAna, createExpense(s.db, s.asAna, dinner(s, { merchant: 'Casa Pepe', status: 'draft' })).id, 1);

    const match = { merchant: ' casa  PEPE', total: 1000, currency: 'SGD', expenseDate: '2026-09-27' };
    expect(findPossibleDuplicates(s.db, s.asAna, s.trip.id, match).map((e) => e.id)).toEqual([first.id, draft.id]);
    expect(findPossibleDuplicates(s.db, s.asAna, s.trip.id, { ...match, excludeId: draft.id }).map((e) => e.id)).toEqual([first.id]);
    expect(findPossibleDuplicates(s.db, s.asAna, s.trip.id, { ...match, merchant: null })).toEqual([]);
  });
});

describe('an expense in a foreign currency', () => {
  it('cannot be confirmed without a rate', () => {
    const s = seed();
    expect(code(() => createExpense(s.db, s.asAna, ramen(s)))).toBe('rate_missing');
    const draft = createExpense(s.db, s.asAna, ramen(s, { status: 'draft' }));
    expect(draft).toMatchObject({ currency: 'JPY', fxRate: null, fxRateSource: 'missing' });
    const error = caught(() => confirmExpense(s.db, s.asAna, draft.id, 1)) as ValidationError;
    expect(error.code).toBe('rate_missing');
    expect(error.problems).toEqual([expect.objectContaining({ field: 'fxRate', code: 'rate_missing' })]);
    expect(getExpense(s.db, s.asAna, draft.id).status).toBe('draft');
  });

  it('reports the currency before the rate, and lists both', () => {
    const s = seed();
    const draft = createExpense(s.db, s.asAna, ramen(s, { status: 'draft', currencyNeedsReview: true }));
    const error = caught(() => confirmExpense(s.db, s.asAna, draft.id, 1)) as ValidationError;
    expect(error.code).toBe('currency_needs_review');
    expect(error.problems.map((p) => p.code)).toEqual(['currency_needs_review', 'rate_missing']);
  });
});
