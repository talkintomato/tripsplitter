import type { ExpenseFormState, FormPatch } from '../expense-form/formState';
import type { ExpenseItemInput } from '../api/types';
import { amountText } from '../format';

// Changes to the expense made from the item screen. Each returns the fields to change.
// No share is worked out here: that is the server's answer.

/** The members assigned to an item who are included in the expense. Nobody: the item is shared by everyone. */
export function assignedTo(item: ExpenseItemInput, included: ReadonlyArray<number>): number[] {
  const ids = new Set((item.shares ?? []).map((s) => s.memberId));
  return included.filter((id) => ids.has(id));
}

/** Puts a person on an item, or takes them off it when they were on it. */
export function toggleOnItem(items: ReadonlyArray<ExpenseItemInput>, index: number, memberId: number): FormPatch {
  return {
    items: items.map((item, i) => {
      if (i !== index) return item;
      const shares = item.shares ?? [];
      const on = shares.some((s) => s.memberId === memberId);
      return { ...item, shares: on ? shares.filter((s) => s.memberId !== memberId) : [...shares, { memberId }] };
    }),
  };
}

/** Includes a person in the expense or takes them out. Someone taken out is taken off every item too. */
export function toggleIncluded(state: ExpenseFormState, memberId: number): FormPatch {
  if (!state.included.includes(memberId)) return { included: [...state.included, memberId] };
  return {
    included: state.included.filter((id) => id !== memberId),
    items: state.items.map((item) => ({ ...item, shares: (item.shares ?? []).filter((s) => s.memberId !== memberId) })),
  };
}

export function replaceItem(items: ReadonlyArray<ExpenseItemInput>, index: number, item: ExpenseItemInput): FormPatch {
  return { items: items.map((old, i) => (i === index ? item : old)) };
}

export function removeItem(items: ReadonlyArray<ExpenseItemInput>, index: number): FormPatch {
  return { items: items.filter((_, i) => i !== index) };
}

export function addItem(items: ReadonlyArray<ExpenseItemInput>, item: ExpenseItemInput): FormPatch {
  return { items: [...items, item] };
}

// What can be done when the figures do not add up. `difference` is the one the server reported:
// total minus what the items, tax, tip, service charge and discount add up to.

/** The total that makes the figures add up. Null when that would not be an amount above zero. */
export function matchingTotal(total: number, difference: number): number | null {
  const next = total - difference;
  return next > 0 ? next : null;
}

export function changeTotalToMatch(total: number, difference: number, currency: string): FormPatch {
  const next = matchingTotal(total, difference);
  return next === null ? {} : { amountText: amountText(next, currency) };
}

/** For a total that is more than the items explain: the rest becomes an item shared by everyone. */
export function addDifferenceAsOther(state: ExpenseFormState, difference: number): FormPatch {
  if (difference <= 0) return {};
  return addItem(state.items, { label: 'Other', quantity: 1, amount: difference, shares: [] });
}

/** For a total that is less than the items explain: the rest is a discount. Never a negative item. */
export function addDifferenceAsDiscount(state: ExpenseFormState, difference: number): FormPatch {
  if (difference >= 0) return {};
  return { discount: state.discount - difference };
}
