import { isAmount, toBigInt, toSafeNumber } from './amounts.js';
import {
  InvalidExpenseError,
  type ExpenseProblem,
  type SplitExpense,
  type SplitItem,
  type SplitShare,
} from './types.js';

const isWeight = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const isItemShare = (share: SplitShare) => share.itemId !== null && share.itemId !== undefined;

/** IDs of the members included in the expense, lowest first. */
function includedMembers(shares: ReadonlyArray<SplitShare>): number[] {
  return [...new Set(shares.filter((s) => !isItemShare(s)).map((s) => s.memberId))].sort((a, b) => a - b);
}

/**
 * Everything that stops an expense from being confirmed, as a list of problems. Empty when it is fine.
 * Never throws.
 *
 * Every split type: the total is above zero, at least one member is included, weights are positive whole
 * numbers, no member is listed twice.
 * `even` and `portions`: nothing more. Items are not required and are ignored.
 * `items`: at least one item; item amounts, tax, tip, service charge and discount are zero or more; every
 * member assigned to an item is included in the expense; the total equals
 * items + tip + service charge - discount + (tax when `taxIncluded` is false); and when any of tax, tip,
 * service charge or discount is not zero the items sum to more than zero.
 */
export function validateExpense(
  expense: SplitExpense,
  items: ReadonlyArray<SplitItem>,
  shares: ReadonlyArray<SplitShare>,
): ExpenseProblem[] {
  const problems: ExpenseProblem[] = [];
  const add = (problem: ExpenseProblem) => {
    if (!problems.some((p) => p.code === problem.code && p.field === problem.field)) problems.push(problem);
  };

  if (!isAmount(expense.total)) {
    add({ field: 'total', code: 'invalid_amount', message: 'The total must be a whole number of minor units.' });
  } else if (toBigInt(expense.total) <= 0n) {
    add({ field: 'total', code: 'total_not_positive', message: 'The total must be more than zero.' });
  }

  const included = includedMembers(shares);
  if (included.length === 0) {
    add({ field: 'shares', code: 'no_members', message: 'Choose at least one person to split with.' });
  }
  if (shares.some((s) => !isWeight(s.weight))) {
    add({ field: 'shares', code: 'invalid_weight', message: 'Each portion must be a whole number above zero.' });
  }
  const seen = new Set<string>();
  for (const share of shares) {
    const key = `${isItemShare(share) ? `i${share.itemId}` : 'e'}:${share.memberId}`;
    if (seen.has(key)) add({ field: isItemShare(share) ? 'items' : 'shares', code: 'duplicate_member', message: 'A person is listed twice.' });
    seen.add(key);
  }

  if (expense.splitType !== 'items') return problems;

  const adjustments = [
    ['tax', expense.tax, 'tax'],
    ['tip', expense.tip, 'tip'],
    ['serviceCharge', expense.serviceCharge, 'service charge'],
    ['discount', expense.discount, 'discount'],
  ] as const;
  let figuresOk = isAmount(expense.total);
  for (const [field, value, name] of adjustments) {
    if (!isAmount(value) || toBigInt(value) < 0n) {
      figuresOk = false;
      add({ field, code: 'invalid_amount', message: `The ${name} must be zero or more.` });
    }
  }
  if (items.length === 0) {
    add({ field: 'items', code: 'no_items', message: 'Add at least one item to split by item.' });
    return problems;
  }
  for (const item of items) {
    if (!isAmount(item.amount) || toBigInt(item.amount) < 0n) {
      figuresOk = false;
      add({ field: 'items', code: 'invalid_amount', message: 'The amount of an item must be zero or more.' });
    }
  }
  const itemIds = new Set(items.map((i) => i.id));
  if (itemIds.size !== items.length) {
    add({ field: 'items', code: 'unknown_item', message: 'Two items have the same ID.' });
  }
  const includedSet = new Set(included);
  for (const share of shares) {
    if (!isItemShare(share)) continue;
    if (!itemIds.has(share.itemId!)) {
      add({ field: 'items', code: 'unknown_item', message: 'A person is assigned to an item that is not on the expense.' });
    } else if (!includedSet.has(share.memberId)) {
      add({ field: 'items', code: 'member_not_included', message: 'A person assigned to an item must be included in the expense.' });
    }
  }
  if (!figuresOk) return problems;

  const itemsSum = items.reduce((sum, item) => sum + toBigInt(item.amount), 0n);
  const tax = toBigInt(expense.tax);
  const tip = toBigInt(expense.tip);
  const serviceCharge = toBigInt(expense.serviceCharge);
  const discount = toBigInt(expense.discount);
  const expected = itemsSum + tip + serviceCharge - discount + (expense.taxIncluded ? 0n : tax);
  const difference = toBigInt(expense.total) - expected;
  if (difference !== 0n) {
    add({
      field: 'total',
      code: 'total_mismatch',
      message:
        difference > 0n
          ? 'The total is more than the items, tax, tip and charges add up to.'
          : 'The total is less than the items, tax, tip and charges add up to.',
      difference: toSafeNumber(difference),
    });
  }
  if (itemsSum === 0n && (tax !== 0n || tip !== 0n || serviceCharge !== 0n || discount !== 0n)) {
    add({
      field: 'items',
      code: 'zero_items_with_adjustments',
      message: 'Tax, tip, service charge and discount are spread in proportion to the items, so the items cannot all be zero.',
    });
  }
  return problems;
}

/**
 * Total minus expected total for an items split, in minor units, where expected total is
 * items + tip + service charge - discount + (tax when `taxIncluded` is false). Zero when the figures add up.
 * Throws RangeError when a figure is not a whole number.
 */
export function itemsDifference(expense: SplitExpense, items: ReadonlyArray<Pick<SplitItem, 'amount'>>): bigint {
  const itemsSum = items.reduce((sum, item) => sum + toBigInt(item.amount), 0n);
  const expected =
    itemsSum +
    toBigInt(expense.tip) +
    toBigInt(expense.serviceCharge) -
    toBigInt(expense.discount) +
    (expense.taxIncluded ? 0n : toBigInt(expense.tax));
  return toBigInt(expense.total) - expected;
}

/**
 * Gives the minor units still needed to reach `total` to the payer if the payer is included, otherwise to
 * the included member with the lowest ID. The amount given can be negative.
 */
function settleLeftover(amounts: Map<number, bigint>, total: bigint, payerId: number): Map<number, bigint> {
  let sum = 0n;
  for (const amount of amounts.values()) sum += amount;
  const leftover = total - sum;
  const ids = [...amounts.keys()].sort((a, b) => a - b);
  if (leftover !== 0n) {
    const receiver = amounts.has(payerId) ? payerId : ids[0]!;
    amounts.set(receiver, amounts.get(receiver)! + leftover);
  }
  return new Map(ids.map((id) => [id, amounts.get(id)!]));
}

/**
 * Each included member's amount in minor units of the expense currency. The amounts always sum to the total.
 * The map has an entry for every included member, lowest ID first.
 * Throws `InvalidExpenseError`, carrying the problems, when `validateExpense` reports any.
 *
 * - even: the total divided equally between the included members.
 * - portions: the total divided in proportion to the weights.
 * - items: each item is divided between its assigned members by weight, or equally between all included
 *   members when nobody is assigned, with the leftover minor units of the item going to the lowest ID among
 *   them. That gives each member an item subtotal. The remainder, total minus the sum of the items (tax not
 *   already included, tip and service charge, less discount; it can be negative), is divided in proportion
 *   to the subtotals, rounded toward zero.
 * - every split type: the minor units still needed to reach the total go to the payer if the payer is
 *   included, otherwise to the included member with the lowest ID.
 */
export function computeShares(
  expense: SplitExpense,
  items: ReadonlyArray<SplitItem>,
  shares: ReadonlyArray<SplitShare>,
): Map<number, bigint> {
  const problems = validateExpense(expense, items, shares);
  if (problems.length > 0) throw new InvalidExpenseError(problems);

  const total = toBigInt(expense.total);
  const included = includedMembers(shares);

  if (expense.splitType === 'even' || expense.splitType === 'portions') {
    const weights = new Map<number, bigint>();
    for (const share of shares) {
      if (isItemShare(share)) continue;
      weights.set(share.memberId, expense.splitType === 'even' ? 1n : BigInt(share.weight));
    }
    let weightSum = 0n;
    for (const w of weights.values()) weightSum += w;
    const amounts = new Map<number, bigint>();
    for (const [memberId, w] of weights) amounts.set(memberId, (total * w) / weightSum);
    return settleLeftover(amounts, total, expense.payerId);
  }

  const assigned = new Map<number, SplitShare[]>();
  for (const share of shares) {
    if (!isItemShare(share)) continue;
    const list = assigned.get(share.itemId!) ?? [];
    list.push(share);
    assigned.set(share.itemId!, list);
  }

  const subtotals = new Map<number, bigint>(included.map((id) => [id, 0n]));
  let itemsSum = 0n;
  for (const item of items) {
    const amount = toBigInt(item.amount);
    itemsSum += amount;
    const own = assigned.get(item.id);
    const parts: Array<[number, bigint]> = (own ? own.map((s) => [s.memberId, BigInt(s.weight)] as [number, bigint]) : included.map((id) => [id, 1n] as [number, bigint])).sort(
      (a, b) => a[0] - b[0],
    );
    let weightSum = 0n;
    for (const [, w] of parts) weightSum += w;
    let given = 0n;
    for (const [memberId, w] of parts) {
      const part = (amount * w) / weightSum;
      given += part;
      subtotals.set(memberId, subtotals.get(memberId)! + part);
    }
    const lowest = parts[0]![0];
    subtotals.set(lowest, subtotals.get(lowest)! + (amount - given));
  }

  const remainder = total - itemsSum;
  const amounts = new Map<number, bigint>();
  for (const [memberId, subtotal] of subtotals) {
    // bigint division rounds toward zero, also for a negative remainder.
    const spread = itemsSum === 0n ? 0n : (remainder * subtotal) / itemsSum;
    amounts.set(memberId, subtotal + spread);
  }
  return settleLeftover(amounts, total, expense.payerId);
}
