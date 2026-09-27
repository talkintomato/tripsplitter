import type { Hono } from 'hono';
import { z } from 'zod';
import { isSupportedCurrency, isValidRate } from '../../core/index.js';
import { getTrip, listTripRates, previewTripRate, setTripRate, ValidationError } from '../../db/index.js';
import { idParam, type ApiEnv, type Services } from '../context.js';
import { notify } from '../notices.js';
import { readBody } from '../schemas.js';

const previewBody = z.object({ rate: z.string() });
const applyBody = previewBody.extend({ snapshot: z.string().min(1) });

export function registerRateRoutes(app: Hono<ApiEnv>, { db, deps }: Services): void {
  app.get('/api/trips/:tripId/rates', (c) => {
    const { scope } = c.get('caller');
    const trip = getTrip(db, scope, idParam(c, 'tripId', 'trip'));
    return c.json({ trip, rates: listTripRates(db, scope, trip.id) });
  });

  app.get('/api/trips/:tripId/rates/suggest', async (c) => {
    const { scope } = c.get('caller');
    const trip = getTrip(db, scope, idParam(c, 'tripId', 'trip'));
    const currency = c.req.query('currency');
    if (!isSupportedCurrency(currency)) throw new ValidationError('unsupported_currency', 'Choose a supported currency.');
    let rate: string | null = null;
    try {
      const suggestion = await deps.suggestRate(trip.homeCurrency, currency);
      if (isValidRate(suggestion)) rate = suggestion;
    } catch {
      // A lookup is optional; members can always enter a rate themselves.
    }
    return c.json({ homeCurrency: trip.homeCurrency, currency, rate });
  });

  app.post('/api/trips/:tripId/rates/:currency/preview', async (c) => {
    const { scope } = c.get('caller');
    const tripId = idParam(c, 'tripId', 'trip');
    getTrip(db, scope, tripId);
    const { rate } = await readBody(c, previewBody);
    return c.json(previewTripRate(db, scope, tripId, c.req.param('currency'), rate));
  });

  app.put('/api/trips/:tripId/rates/:currency', async (c) => {
    const caller = c.get('caller');
    const tripId = idParam(c, 'tripId', 'trip');
    const trip = getTrip(db, caller.scope, tripId);
    const { rate, snapshot } = await readBody(c, applyBody);
    const result = setTripRate(db, caller.scope, tripId, c.req.param('currency'), rate, 'member', snapshot);
    if (result.changed) {
      await notify('tripRateChanged', () => deps.notifier.tripRateChanged({
        chatId: caller.group.chatId,
        actorName: caller.member.displayName,
        homeCurrency: trip.homeCurrency,
        currency: result.tripRate.currency,
        rate: result.tripRate.rate,
        origin: result.tripRate.origin,
        expensesChanged: result.changedExpenses.length,
      }));
    }
    return c.json({ tripRate: result.tripRate, expensesChanged: result.changedExpenses.length, updatedExpenses: result.changedExpenses.map(({ id, version }) => ({ id, version })) });
  });
}
