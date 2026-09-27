import type { Hono } from 'hono';
import {
  changeHomeCurrency,
  completeSetup,
  createSettlement,
  endTrip,
  getOrCreateActiveTrip,
  getSettlement,
  getTrip,
  getTripBalances,
  inTransaction,
  listSettlements,
  listTrips,
  renameTrip,
  reopenTrip,
  restoreSettlement,
  undoSettlement,
  ValidationError,
  type Trip,
} from '../../db/index.js';
import { idParam, type ApiEnv, type Caller, type Services } from '../context.js';
import { notify, settlementNotice } from '../notices.js';
import { createSettlementBody, createTripBody, patchTripBody, readBody, versionBody } from '../schemas.js';
import type { BalancesResponse, SettlementResponse, TripResponse, TripsResponse } from '../types.js';

export function registerTripRoutes(app: Hono<ApiEnv>, { db, deps }: Services): void {
  const tripNotice = (caller: Caller, trip: Trip) => ({
    chatId: caller.group.chatId,
    actorName: caller.member.displayName,
    tripName: trip.name,
  });

  app.get('/api/trips', (c) => {
    const { scope } = c.get('caller');
    const response: TripsResponse = { trips: listTrips(db, scope) };
    return c.json(response);
  });

  app.post('/api/trips', async (c) => {
    const { scope } = c.get('caller');
    const body = await readBody(c, createTripBody, { optional: true });
    const trip = inTransaction(db, () => {
      const { trip: made, created } = getOrCreateActiveTrip(db, scope);
      if (!created) {
        throw new ValidationError('active_trip_exists', 'This group already has a trip going. End it before starting a new one.');
      }
      if (body.name !== undefined) renameTrip(db, scope, made.id, body.name);
      if (body.homeCurrency !== undefined) changeHomeCurrency(db, scope, made.id, body.homeCurrency);
      return getTrip(db, scope, made.id);
    });
    const response: TripResponse = { trip };
    return c.json(response, 201);
  });

  app.get('/api/trips/:tripId', (c) => {
    const { scope } = c.get('caller');
    const response: TripResponse = { trip: getTrip(db, scope, idParam(c, 'tripId', 'trip')) };
    return c.json(response);
  });

  app.patch('/api/trips/:tripId', async (c) => {
    const { scope } = c.get('caller');
    const tripId = idParam(c, 'tripId', 'trip');
    getTrip(db, scope, tripId);
    const body = await readBody(c, patchTripBody);
    // All of it or none of it.
    const trip = inTransaction(db, () => {
      if (body.name !== undefined) renameTrip(db, scope, tripId, body.name);
      if (body.homeCurrency !== undefined) changeHomeCurrency(db, scope, tripId, body.homeCurrency);
      if (body.setupDone === true) completeSetup(db, scope, tripId);
      return getTrip(db, scope, tripId);
    });
    const response: TripResponse = { trip };
    return c.json(response);
  });

  app.post('/api/trips/:tripId/end', async (c) => {
    const caller = c.get('caller');
    const trip = endTrip(db, caller.scope, idParam(c, 'tripId', 'trip'));
    await notify('tripEnded', () => deps.notifier.tripEnded(tripNotice(caller, trip)));
    const response: TripResponse = { trip };
    return c.json(response);
  });

  app.post('/api/trips/:tripId/reopen', async (c) => {
    const caller = c.get('caller');
    const trip = reopenTrip(db, caller.scope, idParam(c, 'tripId', 'trip'));
    await notify('tripReopened', () => deps.notifier.tripReopened(tripNotice(caller, trip)));
    const response: TripResponse = { trip };
    return c.json(response);
  });

  app.get('/api/trips/:tripId/balances', (c) => {
    const { scope } = c.get('caller');
    const tripId = idParam(c, 'tripId', 'trip');
    const result = getTripBalances(db, scope, tripId);
    const response: BalancesResponse = {
      trip: result.trip,
      balances: result.balances,
      payments: result.payments,
      settlements: listSettlements(db, scope, tripId),
    };
    return c.json(response);
  });

  app.post('/api/trips/:tripId/settlements', async (c) => {
    const caller = c.get('caller');
    const tripId = idParam(c, 'tripId', 'trip');
    const trip = getTrip(db, caller.scope, tripId);
    const body = await readBody(c, createSettlementBody);
    const settlement = createSettlement(db, caller.scope, {
      tripId,
      fromMemberId: body.fromMemberId,
      toMemberId: body.toMemberId,
      amount: body.amount,
    });
    await notify('settlementRecorded', () => deps.notifier.settlementRecorded(settlementNotice(db, caller, settlement, trip)));
    const response: SettlementResponse = { settlement };
    return c.json(response, 201);
  });

  app.post('/api/settlements/:id/undo', async (c) => {
    const caller = c.get('caller');
    const id = idParam(c, 'id', 'settlement');
    getSettlement(db, caller.scope, id);
    const { version } = await readBody(c, versionBody);
    const settlement = undoSettlement(db, caller.scope, id, version);
    const trip = getTrip(db, caller.scope, settlement.tripId);
    await notify('settlementUndone', () => deps.notifier.settlementUndone(settlementNotice(db, caller, settlement, trip)));
    const response: SettlementResponse = { settlement };
    return c.json(response);
  });

  app.post('/api/settlements/:id/restore', async (c) => {
    const caller = c.get('caller');
    const id = idParam(c, 'id', 'settlement');
    getSettlement(db, caller.scope, id);
    const { version } = await readBody(c, versionBody);
    const settlement = restoreSettlement(db, caller.scope, id, version);
    const trip = getTrip(db, caller.scope, settlement.tripId);
    await notify('settlementRestored', () => deps.notifier.settlementRestored(settlementNotice(db, caller, settlement, trip)));
    const response: SettlementResponse = { settlement };
    return c.json(response);
  });
}
