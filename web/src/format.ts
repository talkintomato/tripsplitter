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
  return "You're settled up!";
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

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The phone's own calendar day of a moment, as YYYY-MM-DD. */
export function localDay(iso: string): string {
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) return iso.slice(0, 10);
  return today(moment);
}

/**
 * A day as a heading: "Today", "Yesterday", then "Fri 25 Sep", with the year only when it is not this year.
 * Today is the phone's own today.
 */
export function dayLabel(date: string, now: Date = new Date()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (date === today(now)) return 'Today';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date === today(yesterday)) return 'Yesterday';
  // Noon, so that no daylight saving change moves it to another day.
  const weekday = WEEKDAYS[new Date(year, month, day, 12).getDay()];
  const text = `${weekday} ${day} ${MONTHS[month] ?? ''}`;
  return year === now.getFullYear() ? text : `${text} ${year}`;
}

/** "Fri 25 Sep 2026", always with the year. */
export function longDayText(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const weekday = WEEKDAYS[new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12).getDay()];
  return `${weekday} ${dayText(date)}`;
}

/** "you lent 20.00 SGD" and the like. Null when the person is not involved. */
export function stakeText(stake: { kind: 'lent' | 'borrowed' | 'none'; amount: number; currency: string } | undefined): string | null {
  if (!stake || stake.kind === 'none' || stake.amount <= 0) return null;
  return `you ${stake.kind} ${money(stake.amount, stake.currency)}`;
}

/** "Today 14:05", "Yesterday 09:30", "25 Sep 18:20", with the year when it is not this year. In the phone's time zone. */
export function whenText(iso: string, now: Date = new Date()): string {
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) return iso;
  const time = `${String(moment.getHours()).padStart(2, '0')}:${String(moment.getMinutes()).padStart(2, '0')}`;
  const day = today(moment);
  if (day === today(now)) return `Today ${time}`;
  if (day === today(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return `Yesterday ${time}`;
  const date = `${moment.getDate()} ${MONTHS[moment.getMonth()]}`;
  return moment.getFullYear() === now.getFullYear() ? `${date} ${time}` : `${date} ${moment.getFullYear()} ${time}`;
}

const LEADING_EMOJI = /^(\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s*/u;

/** The emoji a title starts with, such as 🍜 in "🍜 Ramen", and the title without it. */
export function splitEmoji(title: string): { emoji: string | null; rest: string } {
  const match = LEADING_EMOJI.exec(title.trim());
  if (!match) return { emoji: null, rest: title.trim() };
  return { emoji: match[1]!, rest: title.trim().slice(match[0].length) };
}
