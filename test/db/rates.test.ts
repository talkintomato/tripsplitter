import { describe, expect, it } from 'vitest';
import {
  StaleEditError,
  ValidationError,
  changeHomeCurrency,
  confirmExpense,
  createExpense,
  createSettlement,
  deleteExpense,
  getExpense,
  getTrip,
  getTripBalances,
  listTripRates,
  previewTripRate,
  saveExpense,
  setTripRate,
  type ExpenseDetail,
  type TripRatePreview,
} from '../../src/db/index.js';
import { dinner, fingerprint, logged, ramen, sameAs, seed } from './helpers.js';

const rateOf = (e: ExpenseDetail) => [e.fxRate, e.fxRateSource, e.version];
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

describe('the rate of an expense', () => {
  it('follows the order home, expense, trip, missing', () => {
    const s = seed();
    expect(rateOf(createExpense(s.db, s.asAna, dinner(s)))).toEqual(['1', 'home', 1]);
    expect(rateOf(createExpense(s.db, s.asAna, ramen(s, { status: 'draft' })))).toEqual([null, 'missing', 1]);
    expect(rateOf(createExpense(s.db, s.asAna, ramen(s, { rateOverride: '110' })))).toEqual(['110', 'expense', 1]);
    setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.4', 'member');
    expect(rateOf(createExpense(s.db, s.asAna, ramen(s)))).toEqual(['112.4', 'trip', 1]);
    expect(rateOf(createExpense(s.db, s.asAna, ramen(s, { rateOverride: '110' })))).toEqual(['110', 'expense', 1]);
    expect(rateOf(createExpense(s.db, s.asAna, ramen(s, { rateOverride: null })))).toEqual(['112.4', 'trip', 1]);
  });

  it('saving an expense without rateOverride keeps a trip-derived rate as source trip', () => {
    const s = seed();
    setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.4', 'member');
    const created = createExpense(s.db, s.asAna, ramen(s));
    const saved = saveExpense(s.db, s.asAna, created.id, 1, { ...sameAs(s, ramen(s)), description: 'Ramen and beer' });
    expect(rateOf(saved)).toEqual(['112.4', 'trip', 2]);
    // So it still follows the trip rate afterwards.
    setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '110', 'member');
    expect(rateOf(getExpense(s.db, s.asAna, created.id))).toEqual(['110', 'trip', 3]);
  });

  it('never takes the rate or its source from the caller', () => {
    const s = seed();
    setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.4', 'member');
    const created = createExpense(s.db, s.asAna, ramen(s));
    const sneaky = { ...sameAs(s, ramen(s)), fxRate: '1', fxRateSource: 'expense' };
    expect(rateOf(saveExpense(s.db, s.asAna, created.id, 1, sneaky))).toEqual(['112.4', 'trip', 2]);
  });

  it('sets, keeps and clears the rate of one expense', () => {
    const s = seed();
    setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.4', 'member');
    const created = createExpense(s.db, s.asAna, ramen(s));
    const own = saveExpense(s.db, s.asAna, created.id, 1, { ...sameAs(s, ramen(s)), rateOverride: '110' });
    expect(rateOf(own)).toEqual(['110', 'expense', 2]);
    // Left out: keeps what the expense had.
    expect(rateOf(saveExpense(s.db, s.asAna, created.id, 2, sameAs(s, ramen(s))))).toEqual(['110', 'expense', 3]);
    // Null: back to the trip rate.
    expect(rateOf(saveExpense(s.db, s.asAna, created.id, 3, { ...sameAs(s, ramen(s)), rateOverride: null }))).toEqual(['112.4', 'trip', 4]);
  });

  it('clearing the rate of a confirmed expense is refused when the trip has none', () => {
    const s = seed();
    const draft = createExpense(s.db, s.asAna, ramen(s, { status: 'draft', rateOverride: '110' }));
    expect(rateOf(saveExpense(s.db, s.asAna, draft.id, 1, { ...sameAs(s, ramen(s)), rateOverride: null }))).toEqual([null, 'missing', 2]);
    const confirmed = createExpense(s.db, s.asAna, ramen(s, { rateOverride: '110' }));
    const before = fingerprint(s.db);
    expect(code(() => saveExpense(s.db, s.asAna, confirmed.id, 1, { ...sameAs(s, ramen(s)), rateOverride: null }))).toBe('rate_missing');
    expect(fingerprint(s.db)).toBe(before);
  });

  it('changing the currency of an expense clears its override', () => {
    const s = seed();
    setTripRate(s.db, s.asAna, s.trip.id, 'THB', '25.1', 'member');
    const created = createExpense(s.db, s.asAna, ramen(s, { rateOverride: '110' }));
    expect(rateOf(saveExpense(s.db, s.asAna, created.id, 1, { ...sameAs(s, ramen(s)), currency: 'THB' }))).toEqual(['25.1', 'trip', 2]);
    expect(rateOf(saveExpense(s.db, s.asAna, created.id, 2, { ...sameAs(s, ramen(s)), currency: 'SGD' }))).toEqual(['1', 'home', 3]);
    // Unless a new one is supplied in the same call.
    expect(rateOf(saveExpense(s.db, s.asAna, created.id, 3, { ...sameAs(s, ramen(s)), currency: 'JPY', rateOverride: '111' }))).toEqual(['111', 'expense', 4]);
    // To a currency without a trip rate: the old override does not carry over.
    const draft = createExpense(s.db, s.asAna, ramen(s, { status: 'draft', rateOverride: '110' }));
    expect(rateOf(saveExpense(s.db, s.asAna, draft.id, 1, { ...sameAs(s, ramen(s)), currency: 'KRW' }))).toEqual([null, 'missing', 2]);
  });

  it('an unsupported currency is refused', () => {
    const s = seed();
    const before = fingerprint(s.db);
    expect(code(() => createExpense(s.db, s.asAna, dinner(s, { currency: 'EUR', rateOverride: '0.68' })))).toBe('unsupported_currency');
    expect(code(() => createExpense(s.db, s.asAna, dinner(s, { currency: 'sgd' })))).toBe('unsupported_currency');
    expect(code(() => setTripRate(s.db, s.asAna, s.trip.id, 'EUR', '0.68', 'member'))).toBe('unsupported_currency');
    expect(code(() => previewTripRate(s.db, s.asAna, s.trip.id, 'EUR', '0.68'))).toBe('unsupported_currency');
    expect(code(() => changeHomeCurrency(s.db, s.asAna, s.trip.id, 'EUR'))).toBe('unsupported_currency');
    const e = createExpense(s.db, s.asAna, dinner(s, { status: 'draft' }));
    expect(code(() => saveExpense(s.db, s.asAna, e.id, 1, { ...sameAs(s, dinner(s)), currency: 'EUR' }))).toBe('unsupported_currency');
    expect(getExpense(s.db, s.asAna, e.id).version).toBe(1);
    expect(listTripRates(s.db, s.asAna, s.trip.id)).toEqual([]);
    expect(fingerprint(s.db)).not.toBe(before);
  });
});

describe('setTripRate', () => {
  it('updates confirmed and draft expenses with source trip or missing, leaves source expense untouched, raises their versions and logs each', () => {
    const s = seed();
    const { db, trip } = s;
    const waiting = createExpense(db, s.asAna, ramen(s, { status: 'draft', description: 'waiting for a rate' }));
    const ownDraft = createExpense(db, s.asAna, ramen(s, { status: 'draft', rateOverride: '105' }));

    // First time: one entry for the rate, one for the draft that had no rate.
    let first: ReturnType<typeof setTripRate> | undefined;
    let entries = logged(db, () => (first = setTripRate(db, s.asAna, trip.id, 'JPY', '112.4', 'suggested')));
    expect(first!.previous).toBeNull();
    expect(first!.tripRate).toMatchObject({ tripId: trip.id, currency: 'JPY', rate: '112.4', origin: 'suggested', setBy: s.ana.id });
    expect(first!.changedExpenses.map((e) => e.id)).toEqual([waiting.id]);
    expect(entries.map((e) => [e.action, e.entityId])).toEqual([
      ['trip_rate.set', first!.tripRate.id],
      ['expense.rate_change', waiting.id],
    ]);
    expect(rateOf(getExpense(db, s.asAna, waiting.id))).toEqual(['112.4', 'trip', 2]);

    const confirmed = createExpense(db, s.asSam, ramen(s));
    const draft = createExpense(db, s.asSam, ramen(s, { status: 'draft' }));
    const own = createExpense(db, s.asSam, ramen(s, { rateOverride: '110' }));
    const home = createExpense(db, s.asAna, dinner(s, { total: 3000 }));
    setTripRate(db, s.asAna, trip.id, 'THB', '25', 'member');
    const thb = createExpense(db, s.asAna, dinner(s, { currency: 'THB', total: 2500 }));
    const deleted = deleteExpense(db, s.asAna, createExpense(db, s.asSam, ramen(s)).id, 1);

    let changed: ReturnType<typeof setTripRate> | undefined;
    entries = logged(db, () => (changed = setTripRate(db, s.asSam, trip.id, 'JPY', '110.5', 'member')));
    expect(changed!.changed).toBe(true);
    expect(changed!.previous).toMatchObject({ rate: '112.4', origin: 'suggested' });
    expect(changed!.tripRate).toMatchObject({ id: first!.tripRate.id, rate: '110.5', origin: 'member', setBy: s.sam.id });
    expect(changed!.changedExpenses.map((e) => e.id)).toEqual([waiting.id, confirmed.id, draft.id, deleted.id]);

    expect(getExpense(db, s.asAna, confirmed.id)).toMatchObject({ status: 'confirmed', fxRate: '110.5', fxRateSource: 'trip', version: 2 });
    expect(getExpense(db, s.asAna, draft.id)).toMatchObject({ status: 'draft', fxRate: '110.5', fxRateSource: 'trip', version: 2 });
    expect(rateOf(getExpense(db, s.asAna, waiting.id))).toEqual(['110.5', 'trip', 3]);
    expect(getExpense(db, s.asAna, deleted.id)).toMatchObject({ status: 'deleted', fxRate: '110.5', version: 3 });
    // Untouched: own rate, home currency, another currency.
    expect(getExpense(db, s.asAna, own.id)).toEqual(own);
    expect(getExpense(db, s.asAna, ownDraft.id)).toEqual(ownDraft);
    expect(getExpense(db, s.asAna, home.id)).toEqual(home);
    expect(getExpense(db, s.asAna, thb.id)).toEqual(thb);

    expect(entries.map((e) => [e.action, e.entityType, e.entityId])).toEqual([
      ['trip_rate.change', 'trip_rate', first!.tripRate.id],
      ['expense.rate_change', 'expense', waiting.id],
      ['expense.rate_change', 'expense', confirmed.id],
      ['expense.rate_change', 'expense', draft.id],
      ['expense.rate_change', 'expense', deleted.id],
    ]);
    expect(entries.every((e) => e.actorKind === 'member' && e.actorId === s.sam.id && e.tripId === trip.id)).toBe(true);
    expect(entries[0]).toMatchObject({ before: { rate: '112.4', origin: 'suggested' }, after: { rate: '110.5', origin: 'member' } });
    expect(entries[2]).toMatchObject({
      before: { id: confirmed.id, fxRate: '112.4', fxRateSource: 'trip', version: 1, status: 'confirmed' },
      after: { id: confirmed.id, fxRate: '110.5', fxRateSource: 'trip', version: 2, status: 'confirmed' },
    });

    // An open editor holding the old version is refused.
    expect(() => saveExpense(db, s.asAna, confirmed.id, 1, sameAs(s, ramen(s)))).toThrow(StaleEditError);
  });

  it('changes balances, because confirmed expenses follow', () => {
    const s = seed();
    setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.4', 'member');
    createExpense(s.db, s.asSam, ramen(s));
    // 11240 JPY = 100.00 SGD. Shares 33.32, 33.36 (payer), 33.32.
    expect(getTripBalances(s.db, s.asAna, s.trip.id).balances).toEqual({ [s.ana.id]: -3332, [s.sam.id]: 6664, [s.leo.id]: -3332 });
    setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '100', 'member');
    // 11240 JPY = 112.40 SGD. JPY shares 3746, 3748, 3746 are 37.46, 37.48, 37.46.
    expect(getTripBalances(s.db, s.asAna, s.trip.id).balances).toEqual({ [s.ana.id]: -3746, [s.sam.id]: 7492, [s.leo.id]: -3746 });
  });

  it('with the system actor has no set-by', () => {
    const s = seed();
    const entries = logged(s.db, () => {
      expect(setTripRate(s.db, s.asSystem, s.trip.id, 'JPY', '112.4', 'suggested').tripRate.setBy).toBeNull();
    });
    expect(entries.map((e) => [e.action, e.actorKind, e.actorId])).toEqual([['trip_rate.set', 'system', null]]);
  });

  it('writes nothing when nothing changes, and one entry when only the origin does', () => {
    const s = seed();
    setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.4', 'suggested');
    createExpense(s.db, s.asSam, ramen(s));
    const before = fingerprint(s.db);
    expect(setTripRate(s.db, s.asSam, s.trip.id, 'JPY', '112.4', 'suggested').changed).toBe(false);
    expect(fingerprint(s.db)).toBe(before);
    const entries = logged(s.db, () => {
      const result = setTripRate(s.db, s.asSam, s.trip.id, 'JPY', '112.4', 'member');
      expect(result.tripRate.origin).toBe('member');
      expect(result.changedExpenses).toEqual([]);
    });
    expect(entries.map((e) => e.action)).toEqual(['trip_rate.change']);
  });

  it('refuses a bad rate, a bad origin and the home currency', () => {
    const s = seed();
    for (const bad of ['0', '-1', 'abc', '', '1e2', '1,5', '112.1234567']) {
      expect(code(() => setTripRate(s.db, s.asAna, s.trip.id, 'JPY', bad, 'member')), bad).toBe('invalid_input');
    }
    expect(code(() => setTripRate(s.db, s.asAna, s.trip.id, 'JPY', 112.4 as never, 'member'))).toBe('invalid_input');
    expect(code(() => setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.4', 'market' as never))).toBe('invalid_input');
    expect(code(() => setTripRate(s.db, s.asAna, s.trip.id, 'SGD', '1', 'member'))).toBe('invalid_input');
    expect(listTripRates(s.db, s.asAna, s.trip.id)).toEqual([]);
  });

  it('stores the rate exactly as entered', () => {
    const s = seed();
    expect(setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.40', 'member').tripRate.rate).toBe('112.40');
    expect(setTripRate(s.db, s.asAna, s.trip.id, 'IDR', '11500', 'member').tripRate.rate).toBe('11500');
    expect(setTripRate(s.db, s.asAna, s.trip.id, 'USD', '0.741234', 'member').tripRate.rate).toBe('0.741234');
    expect(listTripRates(s.db, s.asAna, s.trip.id).map((r) => [r.currency, r.rate])).toEqual([
      ['IDR', '11500'],
      ['JPY', '112.40'],
      ['USD', '0.741234'],
    ]);
  });
});

describe('previewTripRate', () => {
  it('changes nothing and reports what would change', () => {
    const s = seed();
    setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.4', 'member');
    createExpense(s.db, s.asSam, ramen(s));
    createExpense(s.db, s.asSam, ramen(s, { status: 'draft' }));
    createExpense(s.db, s.asSam, ramen(s, { rateOverride: '110' }));
    const before = fingerprint(s.db);

    const preview = previewTripRate(s.db, s.asAna, s.trip.id, 'JPY', '100');
    expect(fingerprint(s.db)).toBe(before);
    expect(preview.currentRate).toMatchObject({ rate: '112.4' });
    expect(preview.expensesChanged).toBe(2);
    expect(preview.confirmedExpensesChanged).toBe(1);
    expect(preview.balancesBefore).toEqual(getTripBalances(s.db, s.asAna, s.trip.id).balances);
    expect(preview.snapshot).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(JSON.parse(JSON.stringify(preview))).toEqual(preview);

    setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '100', 'member', preview.snapshot);
    expect(getTripBalances(s.db, s.asAna, s.trip.id).balances).toEqual(preview.balancesAfter);
    expect(preview.balancesAfter).not.toEqual(preview.balancesBefore);
  });

  it('works for a currency the trip has no rate for yet', () => {
    const s = seed();
    createExpense(s.db, s.asSam, ramen(s, { status: 'draft' }));
    const preview = previewTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.4');
    expect(preview).toMatchObject({ currentRate: null, expensesChanged: 1, confirmedExpensesChanged: 0 });
    expect(listTripRates(s.db, s.asAna, s.trip.id)).toEqual([]);
    expect(setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.4', 'member', preview.snapshot).changedExpenses).toHaveLength(1);
  });

  it('setTripRate with an out-of-date snapshot is refused', () => {
    const s = seed();
    setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.4', 'member');
    const expense = createExpense(s.db, s.asSam, ramen(s));
    const preview = previewTripRate(s.db, s.asAna, s.trip.id, 'JPY', '100');

    const refused = (what: string) => {
      const before = fingerprint(s.db);
      const error = caught(() => setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '100', 'member', preview.snapshot));
      expect(error, what).toBeInstanceOf(StaleEditError);
      expect((error as StaleEditError).entityType).toBe('trip_rate');
      const current = (error as StaleEditError<TripRatePreview>).current;
      expect(current.snapshot).not.toBe(preview.snapshot);
      expect(current.snapshot).toBe(previewTripRate(s.db, s.asAna, s.trip.id, 'JPY', '100').snapshot);
      expect(fingerprint(s.db)).toBe(before);
    };

    // Someone edits an expense that follows the rate.
    saveExpense(s.db, s.asSam, expense.id, 1, { ...sameAs(s, ramen(s)), total: 12000 });
    refused('expense edited');

    // Someone adds another expense in the currency.
    const again = previewTripRate(s.db, s.asAna, s.trip.id, 'JPY', '100');
    createExpense(s.db, s.asSam, ramen(s));
    expect(previewTripRate(s.db, s.asAna, s.trip.id, 'JPY', '100').snapshot).not.toBe(again.snapshot);
    refused('expense added');

    // Someone else changes the rate first.
    const third = previewTripRate(s.db, s.asAna, s.trip.id, 'JPY', '100');
    setTripRate(s.db, s.asSam, s.trip.id, 'JPY', '111', 'member');
    expect(() => setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '100', 'member', third.snapshot)).toThrow(StaleEditError);
    expect(listTripRates(s.db, s.asAna, s.trip.id)[0]!.rate).toBe('111');

    // A change elsewhere does not make it stale.
    const fourth = previewTripRate(s.db, s.asAna, s.trip.id, 'JPY', '100');
    createExpense(s.db, s.asSam, dinner(s));
    createExpense(s.db, s.asSam, ramen(s, { rateOverride: '105' }));
    expect(setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '100', 'member', fourth.snapshot).changed).toBe(true);
  });
});

describe('changeHomeCurrency', () => {
  it('clears rates and overrides and re-resolves drafts', () => {
    const s = seed();
    setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '112.4', 'member');
    setTripRate(s.db, s.asAna, s.trip.id, 'THB', '25', 'member');
    const followsTrip = createExpense(s.db, s.asAna, ramen(s, { status: 'draft' }));
    const ownRate = createExpense(s.db, s.asAna, dinner(s, { status: 'draft', currency: 'USD', rateOverride: '0.75' }));
    const wasHome = createExpense(s.db, s.asAna, dinner(s, { status: 'draft', total: 3000 }));
    const noRate = createExpense(s.db, s.asAna, dinner(s, { status: 'draft', currency: 'KRW', total: 45000 }));

    let result: ReturnType<typeof changeHomeCurrency> | undefined;
    const entries = logged(s.db, () => (result = changeHomeCurrency(s.db, s.asSam, s.trip.id, 'JPY')));
    expect(result!.changed).toBe(true);
    expect(result!.trip).toMatchObject({ homeCurrency: 'JPY', homeCurrencyLocked: false });
    expect(result!.removedRates.map((r) => r.currency)).toEqual(['JPY', 'THB']);
    expect(listTripRates(s.db, s.asAna, s.trip.id)).toEqual([]);

    // Each expense keeps its own currency and amounts.
    expect(getExpense(s.db, s.asAna, followsTrip.id)).toMatchObject({ currency: 'JPY', total: 11240, fxRate: '1', fxRateSource: 'home', version: 2 });
    expect(getExpense(s.db, s.asAna, ownRate.id)).toMatchObject({ currency: 'USD', total: 1000, fxRate: null, fxRateSource: 'missing', version: 2 });
    expect(getExpense(s.db, s.asAna, wasHome.id)).toMatchObject({ currency: 'SGD', total: 3000, fxRate: null, fxRateSource: 'missing', version: 2 });
    // Had no rate before and has none now: unchanged.
    expect(getExpense(s.db, s.asAna, noRate.id)).toEqual(noRate);

    expect(entries.map((e) => [e.action, e.entityType])).toEqual([
      ['trip.home_currency', 'trip'],
      ['trip_rate.remove', 'trip_rate'],
      ['trip_rate.remove', 'trip_rate'],
      ['expense.rate_change', 'expense'],
      ['expense.rate_change', 'expense'],
      ['expense.rate_change', 'expense'],
    ]);
    expect(entries[0]).toMatchObject({ before: { homeCurrency: 'SGD' }, after: { homeCurrency: 'JPY' }, actorId: s.sam.id });
    expect(entries[1]).toMatchObject({ before: { currency: 'JPY', rate: '112.4' }, after: null });

    expect(logged(s.db, () => expect(changeHomeCurrency(s.db, s.asSam, s.trip.id, 'JPY').changed).toBe(false))).toEqual([]);
  });

  it('is refused once locked, by a confirmed expense or by a settlement', () => {
    const s = seed();
    const draft = createExpense(s.db, s.asAna, dinner(s, { status: 'draft' }));
    expect(getTrip(s.db, s.asAna, s.trip.id).homeCurrencyLocked).toBe(false);
    expect(changeHomeCurrency(s.db, s.asAna, s.trip.id, 'USD').changed).toBe(true);
    changeHomeCurrency(s.db, s.asAna, s.trip.id, 'SGD');

    confirmExpense(s.db, s.asAna, draft.id, getExpense(s.db, s.asAna, draft.id).version);
    expect(getTrip(s.db, s.asAna, s.trip.id).homeCurrencyLocked).toBe(true);
    const before = fingerprint(s.db);
    expect(code(() => changeHomeCurrency(s.db, s.asAna, s.trip.id, 'USD'))).toBe('home_currency_locked');
    expect(fingerprint(s.db)).toBe(before);

    const other = seed();
    createSettlement(other.db, other.asAna, { tripId: other.trip.id, fromMemberId: other.sam.id, toMemberId: other.ana.id, amount: 1 });
    expect(getTrip(other.db, other.asAna, other.trip.id).homeCurrencyLocked).toBe(true);
    expect(code(() => changeHomeCurrency(other.db, other.asAna, other.trip.id, 'USD'))).toBe('home_currency_locked');

    const third = seed();
    createExpense(third.db, third.asAna, dinner(third));
    expect(code(() => changeHomeCurrency(third.db, third.asAna, third.trip.id, 'USD'))).toBe('home_currency_locked');
  });

  it('the lock stays after the only confirmed expense is deleted', () => {
    const s = seed();
    const only = createExpense(s.db, s.asAna, dinner(s));
    deleteExpense(s.db, s.asAna, only.id, 1);
    expect(getTrip(s.db, s.asAna, s.trip.id).homeCurrencyLocked).toBe(true);
    expect(code(() => changeHomeCurrency(s.db, s.asAna, s.trip.id, 'USD'))).toBe('home_currency_locked');
  });
});
