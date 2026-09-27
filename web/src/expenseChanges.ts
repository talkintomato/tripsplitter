import type { Member } from './api/types';
import { stateFromExpense, includedShares, parseAmount, type ExpenseFormState } from './expense-form/formState';
import { dayText, money, nameOf } from './format';

export const SPLIT_WORDS = { even: 'Equally', portions: 'By portions', items: 'By item' } as const;

export interface ChangeRow {
  label: string;
  before: string;
  after: string;
}

function peopleText(members: ReadonlyArray<Member>, shares: Array<{ memberId: number; weight?: number }>, portions: boolean): string {
  if (shares.length === 0) return 'Nobody';
  return shares.map((s) => `${nameOf(members, s.memberId)}${portions ? ` × ${s.weight ?? 1}` : ''}`).join(', ');
}

function itemPeople(members: ReadonlyArray<Member>, shares: Array<{ memberId: number; weight?: number }>): string {
  return shares.map((s) => `${nameOf(members, s.memberId)}${(s.weight ?? 1) > 1 ? ` ×${s.weight}` : ''}`).join(', ');
}

/**
 * Where two versions of an expense differ, one line per field, in words. Used by the conflict comparison of the
 * form (what was typed against the latest saved) and by an expense's history (before and after an edit).
 * `rate`: the rate on each side, when it is to be compared.
 */
export function expenseChanges(
  members: ReadonlyArray<Member>,
  a: ExpenseFormState,
  b: ExpenseFormState,
  options: { rate?: [string, string] | undefined; rateLabel?: string } = {},
): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const add = (label: string, x: string, y: string): void => {
    if (x !== y) rows.push({ label, before: x || '(empty)', after: y || '(empty)' });
  };
  add('Description', a.description.trim(), b.description.trim());
  add('Emoji', a.emoji ?? '', b.emoji ?? '');
  const aTotal = parseAmount(a.amountText, a.currency);
  const bTotal = parseAmount(b.amountText, b.currency);
  add('Amount', aTotal === null ? a.amountText : money(aTotal, a.currency), bTotal === null ? b.amountText : money(bTotal, b.currency));
  add('Currency', a.currency, b.currency);
  if (options.rate) add(options.rateLabel ?? 'Rate', options.rate[0], options.rate[1]);
  add('Date', dayText(a.expenseDate), dayText(b.expenseDate));
  add('Paid by', nameOf(members, a.payerId), nameOf(members, b.payerId));
  add('Split', SPLIT_WORDS[a.splitType], SPLIT_WORDS[b.splitType]);
  const sorted = (state: ExpenseFormState) => includedShares(state).sort((x, y) => x.memberId - y.memberId);
  add('People', peopleText(members, sorted(a), a.splitType === 'portions'), peopleText(members, sorted(b), b.splitType === 'portions'));
  if (a.splitType === 'items' || b.splitType === 'items') {
    const figure = (state: ExpenseFormState, value: number): string => (value === 0 ? '' : money(value, state.currency));
    add('Tax', `${figure(a, a.tax)}${a.tax > 0 && a.taxIncluded ? ', in the prices' : ''}`, `${figure(b, b.tax)}${b.tax > 0 && b.taxIncluded ? ', in the prices' : ''}`);
    add('Tip', figure(a, a.tip), figure(b, b.tip));
    add('Service charge', figure(a, a.serviceCharge), figure(b, b.serviceCharge));
    add('Discount', figure(a, a.discount), figure(b, b.discount));
    const itemText = (state: ExpenseFormState, index: number): string => {
      const item = state.items[index];
      if (!item) return '';
      const who = (item.shares ?? []).filter((s) => state.included.includes(s.memberId)).sort((x, y) => x.memberId - y.memberId);
      return `${item.label}${(item.quantity ?? 1) !== 1 ? ` ×${item.quantity}` : ''}, ${money(item.amount, state.currency)}, ${who.length === 0 ? 'everyone' : itemPeople(members, who)}`;
    };
    for (let i = 0; i < Math.max(a.items.length, b.items.length); i++) add(`Item ${i + 1}`, itemText(a, i), itemText(b, i));
  }
  return rows;
}

type Snapshot = Parameters<typeof stateFromExpense>[0];

/** What an edit changed, from the before and after an activity entry holds. Empty when either is missing. */
export function editChanges(members: ReadonlyArray<Member>, before: unknown, after: unknown): ChangeRow[] {
  const x = before as Snapshot | null;
  const y = after as Snapshot | null;
  if (!x || !y || !Array.isArray(x.shares) || !Array.isArray(y.shares) || !Array.isArray(x.items) || !Array.isArray(y.items)) return [];
  const rate = (s: Snapshot): string => (s.fxRate === null || s.currency === undefined ? '' : `${s.fxRate}${s.fxRateSource === 'expense' ? ', this expense only' : ''}`);
  const rates: [string, string] | undefined = x.currency !== y.currency || x.fxRate !== y.fxRate || x.fxRateSource !== y.fxRateSource ? [rate(x), rate(y)] : undefined;
  return expenseChanges(members, stateFromExpense(x), stateFromExpense(y), { rate: rates });
}
