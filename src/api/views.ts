import {
  amountsToRecord,
  computeShares,
  convertExpense,
  toSafeNumber,
  validateExpense,
  type ExpenseProblem,
} from '../core/index.js';
import { getTrip, listExpenses, type CurrencyCode, type Db, type ExpenseDetail, type Group, type Scope, type Trip } from '../db/index.js';
import { RATE_MISSING_NOTICE, type ExpenseView, type GroupInfo, type MyStake, type TripSummary } from './types.js';

/** Everything that stops the expense from being confirmed, in the order a member should fix it. */
export function expenseProblems(detail: ExpenseDetail): ExpenseProblem[] {
  const problems: ExpenseProblem[] = [];
  if (detail.fxRateSource === 'missing' || detail.fxRate === null) {
    problems.push({ field: 'fxRate', code: 'rate_missing', message: RATE_MISSING_NOTICE });
  }
  return [...problems, ...validateExpense(detail, detail.items, detail.shares)];
}

/** The expense with each person's amount. Every figure is a plain number, ready for JSON. */
export function toExpenseView(db: Db, scope: Scope, detail: ExpenseDetail, trip?: Trip): ExpenseView {
  const ofTrip = trip && trip.id === detail.tripId ? trip : getTrip(db, scope, detail.tripId);
  const problems = expenseProblems(detail);
  const splitProblems = validateExpense(detail, detail.items, detail.shares);

  let amounts: Record<number, number> | null = null;
  let homeTotal: number | null = null;
  let homeAmounts: Record<number, number> | null = null;
  if (splitProblems.length === 0) {
    const shares = computeShares(detail, detail.items, detail.shares);
    amounts = amountsToRecord(shares);
    if (detail.fxRate !== null && detail.fxRateSource !== 'missing') {
      try {
        const converted = convertExpense(detail, shares, ofTrip.homeCurrency);
        homeTotal = toSafeNumber(converted.total);
        homeAmounts = amountsToRecord(converted.shares);
      } catch {
        // Left as null: the expense is shown without converted amounts.
      }
    }
  }
  const rateMissing = detail.fxRateSource === 'missing' && (detail.status === 'draft' || detail.status === 'discarded');
  return {
    ...detail,
    homeCurrency: ofTrip.homeCurrency,
    amounts,
    homeTotal,
    homeAmounts,
    problems,
    notice: rateMissing ? RATE_MISSING_NOTICE : null,
    myStake: stakeOf(scope, detail.payerId, homeTotal, homeAmounts, ofTrip.homeCurrency),
  };
}

/** The member the request is made by, or null for the system. */
function callerId(scope: Scope): number | null {
  return scope.actor.kind === 'member' ? scope.actor.memberId : null;
}

/** The caller's side of an expense, from the converted figures the view already has. */
function stakeOf(scope: Scope, payerId: number, homeTotal: number | null, homeAmounts: Record<number, number> | null, currency: CurrencyCode): MyStake {
  const me = callerId(scope);
  const none: MyStake = { kind: 'none', amount: 0, currency };
  if (me === null || homeTotal === null || homeAmounts === null) return none;
  const share = homeAmounts[me] ?? 0;
  if (payerId === me) {
    const lent = homeTotal - share;
    return lent > 0 ? { kind: 'lent', amount: lent, currency } : none;
  }
  return share > 0 ? { kind: 'borrowed', amount: share, currency } : none;
}

/** What the caller and the whole group spent on a trip: its confirmed expenses, converted to home currency. */
export function tripSummary(db: Db, scope: Scope, trip: Trip): TripSummary {
  const me = callerId(scope);
  let myExpenses = 0;
  let totalExpenses = 0;
  for (const detail of listExpenses(db, scope, trip.id, { status: 'confirmed' })) {
    const view = toExpenseView(db, scope, detail, trip);
    if (view.homeTotal === null || view.homeAmounts === null) continue;
    totalExpenses += view.homeTotal;
    if (me !== null) myExpenses += view.homeAmounts[me] ?? 0;
  }
  return { myExpenses, totalExpenses, currency: trip.homeCurrency };
}

export function toGroupInfo(group: Group): GroupInfo {
  return { id: group.id, title: group.title, linkVersion: group.linkVersion };
}
