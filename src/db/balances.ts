import { amountsToRecord, computeBalances, suggestPayments } from '../core/index.js';
import { loadTrip, mapExpense, mapSettlement, openForRead, withItemsAndShares } from './internal.js';
import type { Db, Scope, Trip } from './types.js';

/** Internal: balances of a trip as bigint. */
export function computeTripBalances(db: Db, trip: Trip): Map<number, bigint> {
  const expenses = db
    .prepare(`SELECT * FROM expense WHERE trip_id = ? AND status = 'confirmed' ORDER BY id`)
    .all(trip.id)
    .map((row) => withItemsAndShares(db, mapExpense(row)));
  const settlements = db.prepare(`SELECT * FROM settlement WHERE trip_id = ? AND status = 'active' ORDER BY id`).all(trip.id).map(mapSettlement);
  return computeBalances(expenses, settlements, trip.homeCurrency);
}

export interface TripBalances {
  trip: Trip;
  /**
   * Net balance per member: member ID to home currency minor units. Positive: is owed money. Negative: owes.
   * Holds every member who took part in a confirmed expense or an active settlement. Sums to zero.
   */
  balances: Record<number, number>;
  /** Suggested payments that settle every balance, in home currency minor units. */
  payments: Array<{ fromMemberId: number; toMemberId: number; amount: number }>;
}

/**
 * Balances and suggested payments of a trip, recomputed from its confirmed expenses and active settlements.
 * Nothing is stored. Amounts are plain numbers, ready for JSON. Works for ended trips too.
 */
export function getTripBalances(db: Db, scope: Scope, tripId: number): TripBalances {
  openForRead(db, scope);
  const trip = loadTrip(db, scope, tripId);
  const balances = computeTripBalances(db, trip);
  return {
    trip,
    balances: amountsToRecord(balances),
    payments: suggestPayments(balances).map((p) => ({ ...p, amount: Number(p.amount) })),
  };
}
