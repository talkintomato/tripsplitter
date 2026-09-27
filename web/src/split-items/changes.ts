import type { ExpenseFormState, FormPatch } from '../expense-form/formState';
import type { ExpenseItemInput } from '../api/types';

// Changes to the expense made from the item screen. Each returns the fields to change.
// No share is worked out here: that is the server's answer.

/** The members assigned to an item who are included in the expense. Nobody: the item is shared by everyone. */
export function assignedTo(item: ExpenseItemInput, included: ReadonlyArray<number>): number[] {
  const ids = new Set((item.shares ?? []).map((s) => s.memberId));
  return included.filter((id) => ids.has(id));
}

/**
 * How many of an item a person had: the weight of their share on it, 0 when they are not on it.
 * A share saved before counts existed has weight 1, or none, and counts as 1.
 */
export function countOf(item: ExpenseItemInput, memberId: number): number {
  const share = (item.shares ?? []).find((s) => s.memberId === memberId);
  return share ? (share.weight ?? 1) : 0;
}

/** The shares of an item with one person's count set. 0 takes them off; 1 or more is sent as the weight. */
export function withCount(shares: ReadonlyArray<{ memberId: number; weight?: number }>, memberId: number, count: number): Array<{ memberId: number; weight?: number }> {
  const next = Math.max(0, Math.min(99, Math.trunc(count)));
  const others = shares.filter((s) => s.memberId !== memberId);
  if (next === 0) return others;
  const at = shares.findIndex((s) => s.memberId === memberId);
  const share = { memberId, weight: next };
  if (at === -1) return [...others, share];
  return shares.map((s) => (s.memberId === memberId ? share : s));
}

/** Adds to, or takes from, a person's count on an item, as paint mode does. */
export function stepOnItem(items: ReadonlyArray<ExpenseItemInput>, index: number, memberId: number, step: 1 | -1): FormPatch {
  return {
    items: items.map((item, i) => (i === index ? { ...item, shares: withCount(item.shares ?? [], memberId, countOf(item, memberId) + step) } : item)),
  };
}

/** "Sam ×2, Mei": who is on an item and how many each had. "Everyone" when nobody is assigned. */
export function whoText(item: ExpenseItemInput, included: ReadonlyArray<number>, nameOf: (id: number) => string): string {
  const ids = assignedTo(item, included);
  if (ids.length === 0) return 'Everyone';
  return ids.map((id) => {
    const count = countOf(item, id);
    return count > 1 ? `${nameOf(id)} ×${count}` : nameOf(id);
  }).join(', ');
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

/** For a total that is more than the items explain: the rest becomes an item shared by everyone. */
export function addDifferenceAsOther(state: ExpenseFormState, difference: number): FormPatch {
  if (difference <= 0) return {};
  return addItem(state.items, { label: 'Other', quantity: 1, amount: difference, shares: [] });
}
