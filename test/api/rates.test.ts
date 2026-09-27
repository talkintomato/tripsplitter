import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExpense, getExpense, listTripRates, resetLink, setTripRate } from '../../src/db/index.js';
import { fingerprint, ramen } from '../db/helpers.js';
import { harness, type Harness } from './helpers.js';

let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => h.db.close());
const base = () => `/api/trips/${h.a.trip.id}/rates`;

describe('trip rates', () => {
  it('lists rates and suggests home-first without storing the suggestion', async () => {
    h.rates.JPY = '112.4';
    expect((await h.ana.get(`${base()}/suggest?currency=JPY`)).body).toEqual({ homeCurrency: 'SGD', currency: 'JPY', rate: '112.4' });
    expect(h.rateLookups).toEqual([['SGD', 'JPY']]);
    expect((await h.ana.get(base())).body.rates).toEqual([]);
    expect((await h.ana.get(`${base()}/suggest?currency=USD`)).body.rate).toBeNull();
    expect((await h.ana.get(`${base()}/suggest?currency=INVALID`)).status).toBe(400);
  });

  it('previews balances without writes, applies to drafts and confirmed expenses, and preserves overrides', async () => {
    setTripRate(h.db, h.a.asAna, h.a.trip.id, 'JPY', '100', 'suggested');
    const expense = createExpense(h.db, h.a.asAna, ramen(h.a, { total: 1200 }));
    createExpense(h.db, h.a.asAna, ramen(h.a, { total: 1200, status: 'draft' }));
    const own = createExpense(h.db, h.a.asAna, ramen(h.a, { total: 1200, rateOverride: '120' }));
    const before = fingerprint(h.db);
    const preview = await h.ana.post(`${base()}/JPY/preview`, { rate: '120' });
    expect(preview.status).toBe(200);
    expect(preview.body.expensesChanged).toBe(2);
    expect(preview.body.confirmedExpensesChanged).toBe(1);
    expect(preview.body.balancesBefore).not.toEqual(preview.body.balancesAfter);
    expect(fingerprint(h.db)).toBe(before);
    const applied = await h.ana.put(`${base()}/JPY`, { rate: '120', snapshot: preview.body.snapshot, origin: 'suggested' });
    expect(applied.status).toBe(200);
    expect(applied.body.tripRate.origin).toBe('member');
    expect(applied.body.expensesChanged).toBe(2);
    expect(getExpense(h.db, h.a.asAna, expense.id).fxRate).toBe('120');
    expect(getExpense(h.db, h.a.asAna, own.id)).toEqual(own);
    expect(h.notices).toEqual([{ name: 'tripRateChanged', notice: {
      chatId: h.a.group.chatId, actorName: 'Ana', homeCurrency: 'SGD', currency: 'JPY', rate: '120', origin: 'member', expensesChanged: 2,
    } }]);
  });

  it('requires a snapshot and refuses a stale snapshot with 409 without writes or notices', async () => {
    const preview = await h.ana.post(`${base()}/JPY/preview`, { rate: '112.4' });
    createExpense(h.db, h.a.asAna, ramen(h.a, { status: 'draft' }));
    const before = fingerprint(h.db);
    const refused = await h.ana.put(`${base()}/JPY`, { rate: '112.4', snapshot: preview.body.snapshot });
    expect(refused.status).toBe(409);
    expect(refused.body.error.current.snapshot).not.toBe(preview.body.snapshot);
    expect(fingerprint(h.db)).toBe(before);
    expect(h.sent()).toEqual([]);
    expect((await h.ana.put(`${base()}/JPY`, { rate: '112.4' })).status).toBe(400);
  });

  it('returns 404 for another group on all four routes', async () => {
    const other = `/api/trips/${h.b.trip.id}/rates`;
    const results = await Promise.all([
      h.ana.get(other), h.ana.get(`${other}/suggest?currency=JPY`),
      h.ana.post(`${other}/JPY/preview`, { rate: '112.4' }),
      h.ana.put(`${other}/JPY`, { rate: '112.4', snapshot: 'old' }),
    ]);
    expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    expect(h.rateLookups).toEqual([]);
  });

  it('refuses an existing member using a link from before a reset on every route', async () => {
    resetLink(h.db, h.a.asAna);
    const results = await Promise.all([
      h.ana.get(base()), h.ana.get(`${base()}/suggest?currency=JPY`),
      h.ana.post(`${base()}/JPY/preview`, { rate: '112.4' }),
      h.ana.put(`${base()}/JPY`, { rate: '112.4', snapshot: 'old' }),
    ]);
    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect(listTripRates(h.db, h.a.asAna, h.a.trip.id)).toEqual([]);
  });
});
