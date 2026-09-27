import { toBigInt } from './amounts.js';
import { convertToHome, isValidRate } from './rates.js';
import { computeShares } from './split.js';
import { InvalidExpenseError, type Amount, type BalanceExpense, type BalanceSettlement } from './types.js';

export interface ConvertedExpense {
  /** The expense total in home currency minor units, rounded half up. The amount the payer is credited. */
  total: bigint;
  /** Each member's share in home currency minor units. Sums to `total`. Lowest member ID first. */
  shares: Map<number, bigint>;
}

/**
 * Converts an expense and its shares to the home currency.
 * 1. The total is converted, rounding half up.
 * 2. Each member's share is converted, rounding down.
 * 3. The leftover, converted total minus the sum of the converted shares, goes to the payer if the payer is
 *    included, otherwise to the included member with the lowest ID.
 * `shares` is the result of `computeShares`, in the expense currency.
 * Throws `InvalidExpenseError` when the expense has no valid rate.
 */
export function convertExpense(
  expense: { payerId: number; total: Amount; currency: string; fxRate: string | null },
  shares: ReadonlyMap<number, Amount>,
  homeCurrency: string,
): ConvertedExpense {
  if (expense.fxRate === null || expense.fxRate === undefined) {
    throw new InvalidExpenseError([
      { field: 'fxRate', code: 'rate_missing', message: `This expense needs an exchange rate for ${expense.currency}.` },
    ]);
  }
  if (!isValidRate(expense.fxRate)) {
    throw new InvalidExpenseError([{ field: 'fxRate', code: 'rate_invalid', message: 'The exchange rate of this expense is not valid.' }]);
  }
  const rate = expense.fxRate;
  const total = convertToHome(expense.total, rate, expense.currency, homeCurrency, 'half-up');
  const ids = [...shares.keys()].sort((a, b) => a - b);
  const converted = new Map<number, bigint>();
  let sum = 0n;
  for (const memberId of ids) {
    const amount = convertToHome(shares.get(memberId)!, rate, expense.currency, homeCurrency, 'down');
    converted.set(memberId, amount);
    sum += amount;
  }
  const leftover = total - sum;
  if (leftover !== 0n && ids.length > 0) {
    const receiver = converted.has(expense.payerId) ? expense.payerId : ids[0]!;
    converted.set(receiver, converted.get(receiver)! + leftover);
  }
  return { total, shares: converted };
}

/**
 * Net balance per member in home currency minor units. Positive: the member is owed money. Negative: the
 * member owes money. Only expenses with status `confirmed` and settlements with status `active` count.
 * For each expense the payer is credited the converted total and each member is debited their converted
 * share. For each settlement the member who paid is credited and the member who received is debited.
 * The balances always sum to zero. Lowest member ID first.
 * Throws `InvalidExpenseError` when a confirmed expense does not pass validation or has no rate.
 */
export function computeBalances(
  expenses: ReadonlyArray<BalanceExpense>,
  settlements: ReadonlyArray<BalanceSettlement>,
  homeCurrency: string,
): Map<number, bigint> {
  const balances = new Map<number, bigint>();
  const change = (memberId: number, delta: bigint) => balances.set(memberId, (balances.get(memberId) ?? 0n) + delta);

  for (const expense of expenses) {
    if (expense.status !== 'confirmed') continue;
    const shares = computeShares(expense, expense.items, expense.shares);
    const converted = convertExpense(expense, shares, homeCurrency);
    change(expense.payerId, converted.total);
    for (const [memberId, amount] of converted.shares) change(memberId, -amount);
  }
  for (const settlement of settlements) {
    if (settlement.status !== 'active') continue;
    const amount = toBigInt(settlement.amount);
    change(settlement.fromMemberId, amount);
    change(settlement.toMemberId, -amount);
  }
  return new Map([...balances].sort((a, b) => a[0] - b[0]));
}
