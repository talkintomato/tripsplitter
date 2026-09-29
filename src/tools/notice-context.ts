import { amountsToRecord, computeBalances } from '../core/index.js';
import type { ExpenseNoticeContext } from '../core/contracts.js';
import { getTrip, getTripBalances, type Db, type Scope, type ExpenseDetail } from '../db/index.js';

/** Capture at the mutation, before a later action can change the expense or trip. */
export function expenseNoticeContext(db: Db, scope: Scope, expense: ExpenseDetail): ExpenseNoticeContext {
  const trip = getTrip(db, scope, expense.tripId);
  return {
    actorMemberId: scope.actor.kind === 'member' ? scope.actor.memberId : 0,
    tripId: trip.id, tripName: trip.name, payerId: expense.payerId,
    memberIds: [...new Set(expense.shares.map(s => s.memberId))], homeCurrency: trip.homeCurrency,
    balances: amountsToRecord(computeBalances([expense], [], trip.homeCurrency)),
  };
}

/** Compare foundation results; do not infer affected people from expense membership. */
export function rateAffectedMembers(db: Db, scope: Scope, tripId: number, before: Record<number, number>): number[] {
  const after = getTripBalances(db, scope, tripId).balances;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].map(Number)
    .filter(id => (before[id] ?? 0) !== (after[id] ?? 0));
}
