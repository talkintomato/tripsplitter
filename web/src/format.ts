import { currencyDecimals, formatAmount, fromMinorUnits } from '../../src/core/currencies';
import type { ExpenseView, Member } from './api/types';

/** "84.50 SGD". Falls back to the bare number for a currency this version does not know. */
export function money(minor: number, currency: string): string {
  try {
    return formatAmount(minor, currency).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  } catch {
    return `${minor} ${currency}`;
  }
}

/** A balance with its sign spelled out. */
export function balanceText(minor: number, currency: string): string {
  if (minor > 0) return `is owed ${money(minor, currency)}`;
  if (minor < 0) return `owes ${money(-minor, currency)}`;
  return 'is settled up';
}

export function myBalanceText(minor: number, currency: string): string {
  if (minor > 0) return `You are owed ${money(minor, currency)}`;
  if (minor < 0) return `You owe ${money(-minor, currency)}`;
  return 'You are settled up';
}

export function amountText(minor: number, currency: string): string {
  try {
    const text = fromMinorUnits(minor, currency);
    const decimals = currencyDecimals(currency);
    const [whole, fraction = ''] = text.split('.');
    return decimals === 0 ? text : `${whole}.${fraction.padEnd(decimals, '0')}`;
  } catch {
    return String(minor);
  }
}

export function expenseTitle(expense: { description: string; merchant: string | null }): string {
  return expense.description.trim() || expense.merchant?.trim() || 'Expense';
}

/** "1 SGD = 112.4 JPY", home currency first. */
export function rateText(expense: Pick<ExpenseView, 'fxRate' | 'currency' | 'homeCurrency'>): string | null {
  if (expense.fxRate === null || expense.currency === expense.homeCurrency) return null;
  return `1 ${expense.homeCurrency} = ${expense.fxRate} ${expense.currency}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "27 Sep 2026" from "2026-09-27". */
export function dayText(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? ''} ${match[1]}`;
}

/** "27 Sep, 14:05" in the phone's own time zone. */
export function momentText(iso: string): string {
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) return iso;
  const time = `${String(moment.getHours()).padStart(2, '0')}:${String(moment.getMinutes()).padStart(2, '0')}`;
  return `${moment.getDate()} ${MONTHS[moment.getMonth()]}, ${time}`;
}

/** Today on this phone, as YYYY-MM-DD. */
export function today(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function nameOf(members: ReadonlyArray<Member>, id: number): string {
  return members.find((m) => m.id === id)?.displayName ?? 'Someone who left';
}
