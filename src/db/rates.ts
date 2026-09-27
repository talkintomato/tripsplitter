import { createHash } from 'node:crypto';
import { toSafeNumber } from '../core/index.js';
import { computeTripBalances } from './balances.js';
import { nowIso } from './clock.js';
import { StaleEditError, ValidationError } from './errors.js';
import {
  actorId,
  assertCurrency,
  assertRate,
  assertTripOpen,
  findTripRate,
  loadTrip,
  mapExpense,
  mapTripRate,
  openForRead,
  openForWrite,
  reresolveExpenses,
  writeActivity,
} from './internal.js';
import type { Db, Expense, ExpenseDetail, RateOrigin, Scope, Trip, TripFxRate } from './types.js';

/** The trip's rates, ordered by currency code. */
export function listTripRates(db: Db, scope: Scope, tripId: number): TripFxRate[] {
  openForRead(db, scope);
  loadTrip(db, scope, tripId);
  return db.prepare('SELECT * FROM trip_fx_rate WHERE trip_id = ? ORDER BY currency').all(tripId).map(mapTripRate);
}

/** The expenses a change of the trip rate looks at: this trip and currency, source `trip` or `missing`, any status. */
function followers(db: Db, tripId: number, currency: string): Expense[] {
  return db
    .prepare(`SELECT * FROM expense WHERE trip_id = ? AND currency = ? AND fx_rate_source IN ('trip', 'missing') ORDER BY id`)
    .all(tripId, currency)
    .map(mapExpense);
}

function snapshotOf(current: TripFxRate | undefined, expenses: Expense[]): string {
  const text = `${current?.rate ?? ''}|${current?.origin ?? ''}|${expenses.map((e) => `${e.id}:${e.version}`).join(',')}`;
  return createHash('sha256').update(text).digest('base64url').slice(0, 22);
}

function checkTarget(db: Db, scope: Scope, tripId: number, currency: string, rate: string): { trip: Trip; code: string; value: string } {
  const trip = loadTrip(db, scope, tripId);
  const code = assertCurrency(currency);
  const value = assertRate(rate);
  assertTripOpen(trip);
  if (code === trip.homeCurrency) {
    throw new ValidationError('invalid_input', `${code} is the home currency of this trip, so it needs no rate.`);
  }
  return { trip, code, value };
}

export interface TripRatePreview {
  /** The trip's rate for the currency as it is now, or null when it has none. */
  currentRate: TripFxRate | null;
  /** How many expenses, of any status, would get a different rate or source. */
  expensesChanged: number;
  /** How many of those are confirmed, so count toward balances. */
  confirmedExpensesChanged: number;
  /** Balances now: member ID to home currency minor units. */
  balancesBefore: Record<number, number>;
  /** Balances after the change. */
  balancesAfter: Record<number, number>;
  /**
   * Stands for the state the preview was worked out from: the current rate and the IDs and versions of the
   * expenses that follow the trip rate. Pass it to `setTripRate` as `expectedSnapshot`.
   */
  snapshot: string;
}

class Rollback extends Error {}

/**
 * What `setTripRate` would do with this rate, without changing anything.
 * Throws the same `NotFoundError` and `ValidationError` as `setTripRate`.
 */
export function previewTripRate(db: Db, scope: Scope, tripId: number, currency: string, rate: string): TripRatePreview {
  openForRead(db, scope);
  const { trip, code, value } = checkTarget(db, scope, tripId, currency, rate);
  const current = findTripRate(db, tripId, code);
  const snapshot = snapshotOf(current, followers(db, tripId, code));
  const balancesBefore = balanceRecord(db, trip);

  let preview: TripRatePreview | undefined;
  try {
    // Make the change for real, look at the result, and always roll back.
    db.transaction(() => {
      const changed = applyRate(db, scope, trip, code, value, current?.origin ?? 'member', current, false);
      preview = {
        currentRate: current ?? null,
        expensesChanged: changed.length,
        confirmedExpensesChanged: changed.filter((e) => e.status === 'confirmed').length,
        balancesBefore,
        balancesAfter: balanceRecord(db, trip),
        snapshot,
      };
      throw new Rollback();
    })();
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return preview!;
}

function balanceRecord(db: Db, trip: Trip): Record<number, number> {
  const record: Record<number, number> = {};
  for (const [memberId, amount] of computeTripBalances(db, trip)) record[memberId] = toSafeNumber(amount);
  return record;
}

function applyRate(
  db: Db,
  scope: Scope,
  trip: Trip,
  currency: string,
  rate: string,
  origin: RateOrigin,
  previous: TripFxRate | undefined,
  log: boolean,
): ExpenseDetail[] {
  const setBy = actorId(scope.actor);
  if (previous) {
    db.prepare('UPDATE trip_fx_rate SET rate = ?, origin = ?, set_by = ?, updated_at = ? WHERE id = ?').run(rate, origin, setBy, nowIso(), previous.id);
  } else {
    db.prepare('INSERT INTO trip_fx_rate (trip_id, currency, rate, origin, set_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      trip.id,
      currency,
      rate,
      origin,
      setBy,
      nowIso(),
    );
  }
  if (log) {
    const after = findTripRate(db, trip.id, currency)!;
    writeActivity(db, scope, {
      tripId: trip.id,
      action: previous ? 'trip_rate.change' : 'trip_rate.set',
      entityType: 'trip_rate',
      entityId: after.id,
      before: previous ?? null,
      after,
    });
  }
  return reresolveExpenses(db, scope, trip, followers(db, trip.id, currency), { keepOverride: true });
}

export interface SetTripRateResult {
  tripRate: TripFxRate;
  /** The rate before the change, or null when the trip had none for this currency. */
  previous: TripFxRate | null;
  /** False when rate and origin were already so. Nothing was changed then. */
  changed: boolean;
  /** The expenses whose rate or source changed, as they are now. Their version went up by one. */
  changedExpenses: ExpenseDetail[];
}

/**
 * Sets or changes the trip's rate for a currency, in one transaction: writes the rate and re-resolves every
 * expense of the trip in that currency whose source is `trip` or `missing`, whatever its status, confirmed
 * ones included. Expenses with their own rate (source `expense`) are untouched. A trip rate cannot be
 * removed, only changed.
 *
 * `rate`: units of `currency` equal to 1 unit of the home currency, as a decimal string ("112.4"), stored
 * exactly as given. `origin`: `member` for a rate a member entered, `suggested` for one filled in from a
 * rate service. With the system actor `setBy` is null.
 * `expectedSnapshot`: the `snapshot` of a `previewTripRate`. When given and no longer matching, throws
 * `StaleEditError` whose `current` is a fresh `TripRatePreview` for the same rate.
 * Throws `ValidationError`: `invalid_input` for a bad rate or origin or for the home currency,
 * `unsupported_currency`, `trip_ended`.
 * Activity: one `trip_rate.set` (first time) or `trip_rate.change`, plus one `expense.rate_change` per
 * expense changed. None when nothing changed.
 */
export function setTripRate(
  db: Db,
  scope: Scope,
  tripId: number,
  currency: string,
  rate: string,
  origin: RateOrigin,
  expectedSnapshot?: string,
): SetTripRateResult {
  if (origin !== 'member' && origin !== 'suggested') {
    throw new ValidationError('invalid_input', 'The origin of a rate is "suggested" or "member".');
  }
  return db.transaction((): SetTripRateResult => {
    openForWrite(db, scope);
    const { trip, code, value } = checkTarget(db, scope, tripId, currency, rate);
    const previous = findTripRate(db, tripId, code);
    if (expectedSnapshot !== undefined && expectedSnapshot !== snapshotOf(previous, followers(db, tripId, code))) {
      throw new StaleEditError('trip_rate', previous?.id ?? 0, previewTripRate(db, scope, tripId, code, value));
    }
    if (previous && previous.rate === value && previous.origin === origin) {
      return { tripRate: previous, previous, changed: false, changedExpenses: [] };
    }
    const changedExpenses = applyRate(db, scope, trip, code, value, origin, previous, true);
    return { tripRate: findTripRate(db, tripId, code)!, previous: previous ?? null, changed: true, changedExpenses };
  })();
}
