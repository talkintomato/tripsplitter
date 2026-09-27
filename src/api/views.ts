import {
  amountsToRecord,
  computeShares,
  convertExpense,
  toSafeNumber,
  validateExpense,
  type ExpenseProblem,
} from '../core/index.js';
import { getTrip, type Db, type ExpenseDetail, type Group, type Scope, type Trip } from '../db/index.js';
import { RATE_MISSING_NOTICE, type ExpenseView, type GroupInfo } from './types.js';

/** Everything that stops the expense from being confirmed, in the order a member should fix it. */
export function expenseProblems(detail: ExpenseDetail): ExpenseProblem[] {
  const problems: ExpenseProblem[] = [];
  if (detail.currencyNeedsReview) {
    problems.push({ field: 'currency', code: 'currency_needs_review', message: 'Check the currency of this expense before saving it.' });
  }
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
  };
}

export function toGroupInfo(group: Group): GroupInfo {
  return { id: group.id, title: group.title, linkVersion: group.linkVersion };
}
