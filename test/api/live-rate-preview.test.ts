import { describe, expect, it } from 'vitest';
import { listTripRates } from '../../src/db/index.js';
import { fingerprint } from '../db/helpers.js';
import { dinnerBody, harness } from './helpers.js';

const PREVIEW = '/api/expenses/preview';

describe('the live rate in a preview', () => {
  it('shows the live rate and converted amount when the trip has no rate, and saves nothing', async () => {
    const h = harness();
    h.rates.EUR = '0.67';
    const before = fingerprint(h.db);
    const preview = await h.ana.post(PREVIEW, { ...dinnerBody(h.a, { currency: 'EUR', total: 6700 }), tripId: h.a.trip.id });
    expect(preview.status).toBe(200);
    expect(preview.body.fx).toMatchObject({ fxRate: '0.67', fxRateSource: 'suggested', homeCurrency: 'SGD', homeTotal: 10000 });
    expect(fingerprint(h.db)).toBe(before);
    expect(listTripRates(h.db, h.a.asAna, h.a.trip.id)).toEqual([]);
  });

  it('saving the expense makes the live rate the trip rate', async () => {
    const h = harness();
    h.rates.EUR = '0.67';
    const saved = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, dinnerBody(h.a, { currency: 'EUR', total: 6700 }));
    expect(saved.status).toBe(201);
    expect(saved.body.expense).toMatchObject({ status: 'confirmed', fxRate: '0.67', fxRateSource: 'trip' });
    expect(listTripRates(h.db, h.a.asAna, h.a.trip.id)).toEqual([expect.objectContaining({ currency: 'EUR', rate: '0.67', origin: 'suggested' })]);
  });

  it('uses the trip rate when there is one, and does not look anything up', async () => {
    const h = harness();
    h.rates.EUR = '0.67';
    await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, dinnerBody(h.a, { currency: 'EUR', total: 6700 }));
    const lookups = h.rateLookups.length;
    const preview = await h.ana.post(PREVIEW, { ...dinnerBody(h.a, { currency: 'EUR', total: 3350 }), tripId: h.a.trip.id });
    expect(preview.body.fx).toMatchObject({ fxRate: '0.67', fxRateSource: 'trip', homeTotal: 5000 });
    expect(h.rateLookups.length).toBe(lookups);
  });

  it('shows the rate as missing when the lookup finds nothing', async () => {
    const h = harness();
    const preview = await h.ana.post(PREVIEW, { ...dinnerBody(h.a, { currency: 'EUR', total: 6700 }), tripId: h.a.trip.id });
    expect(preview.body.fx).toMatchObject({ fxRate: null, fxRateSource: 'missing' });
  });
});
