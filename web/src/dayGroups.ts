import type { ExpenseView, Settlement } from './api/types';
import { dayLabel, localDay } from './format';

/** One line of the trip's list: an expense, or a payment between two people. */
export type ListEntry = { kind: 'expense'; expense: ExpenseView } | { kind: 'settlement'; settlement: Settlement };

export interface DayGroup {
  /** YYYY-MM-DD */
  day: string;
  /** "Today", "Yesterday", "Fri 25 Sep". */
  label: string;
  entries: ListEntry[];
  /**
   * The day's expenses added up in home currency, from the converted totals the API returned for each.
   * Null when there is no expense that day, or one of them has no converted total.
   */
  total: number | null;
}

const dayOf = (entry: ListEntry): string => (entry.kind === 'expense' ? entry.expense.expenseDate : localDay(entry.settlement.createdAt));
const momentOf = (entry: ListEntry): string => (entry.kind === 'expense' ? entry.expense.createdAt : entry.settlement.createdAt);

/**
 * Expenses and payments under the day they belong to, newest day first, and newest first within a day.
 * An expense belongs to its own date; a payment to the day it was recorded on this phone.
 */
export function groupByDay(expenses: ReadonlyArray<ExpenseView>, settlements: ReadonlyArray<Settlement>, now: Date = new Date()): DayGroup[] {
  const entries: ListEntry[] = [
    ...expenses.map((expense) => ({ kind: 'expense' as const, expense })),
    ...settlements.map((settlement) => ({ kind: 'settlement' as const, settlement })),
  ];
  const byDay = new Map<string, ListEntry[]>();
  for (const entry of entries) {
    const day = dayOf(entry);
    byDay.set(day, [...(byDay.get(day) ?? []), entry]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, list]) => {
      const sorted = [...list].sort((a, b) => (momentOf(a) < momentOf(b) ? 1 : momentOf(a) > momentOf(b) ? -1 : 0));
      const spent = sorted.flatMap((entry) => (entry.kind === 'expense' ? [entry.expense.homeTotal] : []));
      const total = spent.length > 0 && spent.every((value) => value !== null) ? spent.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
      return { day, label: dayLabel(day, now), entries: sorted, total };
    });
}
