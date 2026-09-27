import { DEFAULT_HOME_CURRENCY } from '../core/index.js';
import { nowIso } from './clock.js';
import { ValidationError } from './errors.js';
import {
  assertCurrency,
  assertTripOpen,
  cleanText,
  loadTrip,
  mapExpense,
  mapTrip,
  mapTripRate,
  openForRead,
  openForWrite,
  reresolveExpenses,
  writeActivity,
} from './internal.js';
import type { Db, ExpenseDetail, Scope, Trip, TripFxRate, TripStatus } from './types.js';

function activeTrip(db: Db, groupId: number): Trip | undefined {
  const row = db.prepare(`SELECT * FROM trip WHERE group_id = ? AND status = 'active'`).get(groupId);
  return row ? mapTrip(row) : undefined;
}

/** The group's active trip, or undefined when every trip has ended. */
export function getActiveTrip(db: Db, scope: Scope): Trip | undefined {
  openForRead(db, scope);
  return activeTrip(db, scope.groupId);
}

/**
 * The group's active trip. When there is none, creates one named after the group, with the home currency of
 * the group's most recent trip (SGD when the group never had one), not locked and with setup not done.
 * Activity: `trip.create` when a trip was created, none otherwise.
 */
export function getOrCreateActiveTrip(db: Db, scope: Scope): { trip: Trip; created: boolean } {
  return db.transaction(() => {
    const existing = activeTrip(db, scope.groupId);
    if (existing) {
      openForRead(db, scope);
      return { trip: existing, created: false };
    }
    const group = openForWrite(db, scope);
    const last = db.prepare('SELECT * FROM trip WHERE group_id = ? ORDER BY id DESC LIMIT 1').get(group.id);
    const homeCurrency = last ? mapTrip(last).homeCurrency : DEFAULT_HOME_CURRENCY;
    const tripId = Number(
      db
        .prepare(`INSERT INTO trip (group_id, name, home_currency, status, created_at) VALUES (?, ?, ?, 'active', ?)`)
        .run(group.id, group.title, homeCurrency, nowIso()).lastInsertRowid,
    );
    const trip = loadTrip(db, scope, tripId);
    writeActivity(db, scope, { tripId, action: 'trip.create', entityType: 'trip', entityId: tripId, before: null, after: trip });
    return { trip, created: true };
  })();
}

/** A trip of the group. Throws `NotFoundError` when it does not exist or belongs to another group. */
export function getTrip(db: Db, scope: Scope, tripId: number): Trip {
  openForRead(db, scope);
  return loadTrip(db, scope, tripId);
}

/** The group's trips, newest first. */
export function listTrips(db: Db, scope: Scope, options: { status?: TripStatus } = {}): Trip[] {
  openForRead(db, scope);
  const rows = options.status
    ? db.prepare('SELECT * FROM trip WHERE group_id = ? AND status = ? ORDER BY id DESC').all(scope.groupId, options.status)
    : db.prepare('SELECT * FROM trip WHERE group_id = ? ORDER BY id DESC').all(scope.groupId);
  return rows.map(mapTrip);
}

/** Renames an active trip. Refused on an ended trip. Activity: `trip.rename`, none when the name is the same. */
export function renameTrip(db: Db, scope: Scope, tripId: number, name: string): Trip {
  const clean = cleanText(name, 'trip name');
  return db.transaction(() => {
    openForWrite(db, scope);
    const before = loadTrip(db, scope, tripId);
    assertTripOpen(before);
    if (before.name === clean) return before;
    db.prepare('UPDATE trip SET name = ? WHERE id = ?').run(clean, tripId);
    const after = loadTrip(db, scope, tripId);
    writeActivity(db, scope, { tripId, action: 'trip.rename', entityType: 'trip', entityId: tripId, before, after });
    return after;
  })();
}

export interface ChangeHomeCurrencyResult {
  trip: Trip;
  /** False when the trip already had this home currency. Nothing was changed then. */
  changed: boolean;
  /** The trip rates that were removed. Rates are quoted against the home currency, so none survive. */
  removedRates: TripFxRate[];
  /** The expenses whose rate or source changed, as they are now. Their version went up by one. */
  changedExpenses: ExpenseDetail[];
}

/**
 * Changes the home currency of a trip, in one transaction: removes every trip rate, clears every rate set on
 * an expense, keeps each expense's own currency and amounts, and re-resolves every expense of the trip to
 * `home` or `missing`.
 * Refused with `ValidationError`: `home_currency_locked` once the trip had a confirmed expense or a
 * settlement, `trip_ended`, `unsupported_currency`.
 * Activity: one `trip.home_currency`, one `trip_rate.remove` per rate removed, one `expense.rate_change` per
 * expense changed. None when the currency is the same.
 */
export function changeHomeCurrency(db: Db, scope: Scope, tripId: number, currency: string): ChangeHomeCurrencyResult {
  return db.transaction((): ChangeHomeCurrencyResult => {
    openForWrite(db, scope);
    const before = loadTrip(db, scope, tripId);
    const code = assertCurrency(currency);
    assertTripOpen(before);
    if (before.homeCurrency === code) return { trip: before, changed: false, removedRates: [], changedExpenses: [] };
    if (before.homeCurrencyLocked) {
      throw new ValidationError(
        'home_currency_locked',
        'The home currency cannot be changed once the trip has had a saved expense or a settlement.',
      );
    }
    db.prepare('UPDATE trip SET home_currency = ? WHERE id = ?').run(code, tripId);
    const trip = loadTrip(db, scope, tripId);
    writeActivity(db, scope, { tripId, action: 'trip.home_currency', entityType: 'trip', entityId: tripId, before, after: trip });

    const removedRates = db.prepare('SELECT * FROM trip_fx_rate WHERE trip_id = ? ORDER BY id').all(tripId).map(mapTripRate);
    for (const rate of removedRates) {
      db.prepare('DELETE FROM trip_fx_rate WHERE id = ?').run(rate.id);
      writeActivity(db, scope, { tripId, action: 'trip_rate.remove', entityType: 'trip_rate', entityId: rate.id, before: rate, after: null });
    }
    const expenses = db.prepare('SELECT * FROM expense WHERE trip_id = ? ORDER BY id').all(tripId).map(mapExpense);
    const changedExpenses = reresolveExpenses(db, scope, trip, expenses, { keepOverride: false });
    return { trip, changed: true, removedRates, changedExpenses };
  })();
}

/**
 * Marks the setup step of a trip as finished or skipped. Refused on an ended trip.
 * Activity: `trip.setup_done`, none when it was done already.
 */
export function completeSetup(db: Db, scope: Scope, tripId: number): Trip {
  return db.transaction(() => {
    openForWrite(db, scope);
    const before = loadTrip(db, scope, tripId);
    assertTripOpen(before);
    if (before.setupDone) return before;
    db.prepare('UPDATE trip SET setup_done = 1 WHERE id = ?').run(tripId);
    const after = loadTrip(db, scope, tripId);
    writeActivity(db, scope, { tripId, action: 'trip.setup_done', entityType: 'trip', entityId: tripId, before, after });
    return after;
  })();
}

/** Ends a trip. Throws `ValidationError` `invalid_status` when it has ended already. Activity: `trip.end`. */
export function endTrip(db: Db, scope: Scope, tripId: number): Trip {
  return db.transaction(() => {
    openForWrite(db, scope);
    const before = loadTrip(db, scope, tripId);
    if (before.status === 'ended') throw new ValidationError('invalid_status', 'This trip has already ended.');
    db.prepare(`UPDATE trip SET status = 'ended', ended_at = ? WHERE id = ?`).run(nowIso(), tripId);
    const after = loadTrip(db, scope, tripId);
    writeActivity(db, scope, { tripId, action: 'trip.end', entityType: 'trip', entityId: tripId, before, after });
    return after;
  })();
}

/**
 * Makes an ended trip the active trip again. Throws `ValidationError`: `invalid_status` when the trip is
 * active, `active_trip_exists` when the group has another active trip. Activity: `trip.reopen`.
 */
export function reopenTrip(db: Db, scope: Scope, tripId: number): Trip {
  return db.transaction(() => {
    openForWrite(db, scope);
    const before = loadTrip(db, scope, tripId);
    if (before.status === 'active') throw new ValidationError('invalid_status', 'This trip is already active.');
    if (activeTrip(db, scope.groupId)) {
      throw new ValidationError('active_trip_exists', 'This group has another active trip. End that one first.');
    }
    db.prepare(`UPDATE trip SET status = 'active', ended_at = NULL WHERE id = ?`).run(tripId);
    const after = loadTrip(db, scope, tripId);
    writeActivity(db, scope, { tripId, action: 'trip.reopen', entityType: 'trip', entityId: tripId, before, after });
    return after;
  })();
}
