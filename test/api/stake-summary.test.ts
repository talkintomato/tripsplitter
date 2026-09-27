import { describe, expect, it } from 'vitest';
import { createExpense, setTripRate } from '../../src/db/index.js';
import { dinner, ramen } from '../db/helpers.js';
import { harness } from './helpers.js';

describe("the caller's stake on an expense", () => {
  it('is what the caller lent when they paid, and what they borrowed when someone else did', async () => {
    const h = harness();
    // 10.00 SGD paid by Ana, split by Ana, Sam and Leo: Ana's share is 3.34, the others 3.33.
    const expense = createExpense(h.db, h.a.asAna, dinner(h.a));
    const asAna = (await h.ana.get(`/api/expenses/${expense.id}`)).body.expense;
    const asSam = (await h.sam.get(`/api/expenses/${expense.id}`)).body.expense;
    expect(asAna.myStake).toEqual({ kind: 'lent', amount: 666, currency: 'SGD' });
    expect(asSam.myStake).toEqual({ kind: 'borrowed', amount: 333, currency: 'SGD' });
  });

  it('is in home currency for an expense in a foreign currency', async () => {
    const h = harness();
    setTripRate(h.db, h.a.asAna, h.a.trip.id, 'JPY', '112.4', 'member');
    // 11,240 JPY paid by Sam, split by three, is 100.00 SGD. Converted shares: Ana 33.32, Leo 33.32, Sam 33.36.
    const expense = createExpense(h.db, h.a.asSam, ramen(h.a));
    const asAna = (await h.ana.get(`/api/expenses/${expense.id}`)).body.expense;
    const asSam = (await h.sam.get(`/api/expenses/${expense.id}`)).body.expense;
    expect(asAna.homeTotal).toBe(10000);
    expect(asAna.myStake).toEqual({ kind: 'borrowed', amount: asAna.homeAmounts[h.a.ana.id], currency: 'SGD' });
    expect(asAna.myStake.amount).toBe(3332);
    expect(asSam.myStake).toEqual({ kind: 'lent', amount: 10000 - asSam.homeAmounts[h.a.sam.id], currency: 'SGD' });
    expect(asSam.myStake.amount).toBe(6664);
  });

  it('is the whole amount lent when the caller paid but is not in the split', async () => {
    const h = harness();
    const expense = createExpense(h.db, h.a.asAna, dinner(h.a, { total: 900, shares: [{ memberId: h.a.sam.id }, { memberId: h.a.leo.id }] }));
    expect((await h.ana.get(`/api/expenses/${expense.id}`)).body.expense.myStake).toEqual({ kind: 'lent', amount: 900, currency: 'SGD' });
    expect((await h.sam.get(`/api/expenses/${expense.id}`)).body.expense.myStake).toEqual({ kind: 'borrowed', amount: 450, currency: 'SGD' });
  });

  it('is none when the caller is not involved, and when there are no converted amounts yet', async () => {
    const h = harness();
    const notMine = createExpense(h.db, h.a.asAna, dinner(h.a, { shares: [{ memberId: h.a.ana.id }, { memberId: h.a.leo.id }] }));
    expect((await h.sam.get(`/api/expenses/${notMine.id}`)).body.expense.myStake).toEqual({ kind: 'none', amount: 0, currency: 'SGD' });
    // A draft in a currency the trip has no rate for has no converted amounts.
    const noRate = createExpense(h.db, h.a.asAna, ramen(h.a, { payerId: h.a.ana.id, status: 'draft' }));
    const view = (await h.ana.get(`/api/expenses/${noRate.id}`)).body.expense;
    expect(view.homeTotal).toBeNull();
    expect(view.myStake).toEqual({ kind: 'none', amount: 0, currency: 'SGD' });
  });

  it('is on every expense in a list, for the caller who asks', async () => {
    const h = harness();
    createExpense(h.db, h.a.asAna, dinner(h.a));
    const [asSam] = (await h.sam.get(`/api/trips/${h.a.trip.id}/expenses`)).body.expenses;
    expect(asSam.myStake).toEqual({ kind: 'borrowed', amount: 333, currency: 'SGD' });
  });
});

describe('the trip summary', () => {
  it("adds up the caller's converted shares and the converted totals of confirmed expenses only", async () => {
    const h = harness();
    setTripRate(h.db, h.a.asAna, h.a.trip.id, 'JPY', '112.4', 'member');
    // Counted: 10.00 SGD paid by Ana, and 11,240 JPY (100.00 SGD) paid by Sam, both split by three.
    createExpense(h.db, h.a.asAna, dinner(h.a));
    createExpense(h.db, h.a.asSam, ramen(h.a));
    // Ana paid, but is not in the split: counts toward the total, not toward her own expenses.
    createExpense(h.db, h.a.asAna, dinner(h.a, { total: 500, shares: [{ memberId: h.a.sam.id }] }));
    // Not counted: a deleted expense and a draft.
    const removed = createExpense(h.db, h.a.asAna, dinner(h.a, { total: 70000 }));
    const deleted = await h.ana.post(`/api/expenses/${removed.id}/delete`, { version: removed.version });
    expect(deleted.body.expense.status).toBe('deleted');
    createExpense(h.db, h.a.asAna, dinner(h.a, { total: 80000, status: 'draft' }));

    const asAna = (await h.ana.get(`/api/trips/${h.a.trip.id}/balances`)).body.summary;
    expect(asAna).toEqual({ myExpenses: 334 + 3332, totalExpenses: 1000 + 10000 + 500, currency: 'SGD' });
    const asSam = (await h.sam.get(`/api/trips/${h.a.trip.id}/balances`)).body.summary;
    expect(asSam).toEqual({ myExpenses: 333 + 3336 + 500, totalExpenses: 11500, currency: 'SGD' });
  });

  it('is zero for a trip without confirmed expenses', async () => {
    const h = harness();
    createExpense(h.db, h.a.asAna, dinner(h.a, { status: 'draft' }));
    const reply = await h.ana.get(`/api/trips/${h.a.trip.id}/balances`);
    expect(reply.body.summary).toEqual({ myExpenses: 0, totalExpenses: 0, currency: 'SGD' });
  });
});
