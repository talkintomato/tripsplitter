import { currencyDecimals, fromMinorUnits, toMinorUnits } from '../../../src/core/currencies';
import type { ExpenseInput, ExpenseItemInput, ExpenseView, Member, ShareInput, SplitType } from '../api/types';
import { amountText, today } from '../format';

/**
 * Everything the form holds about one expense. It carries every field of the expense, also the ones
 * no screen of this build edits, because a save replaces the whole expense.
 */
export interface ExpenseFormState {
  description: string;
  merchant: string | null;
  /** The amount as typed, such as "84.50". */
  amountText: string;
  /** YYYY-MM-DD */
  expenseDate: string;
  payerId: number;
  splitType: SplitType;
  /** Members included, for the even and the items split. */
  included: number[];
  /** Portions per member, for the portions split. Zero or missing: not included. */
  portions: Record<number, number>;
  items: ExpenseItemInput[];
  tax: number;
  taxIncluded: boolean;
  tip: number;
  serviceCharge: number;
  discount: number;
  /** The currency of this expense, independent of the trip home currency. */
  currency: string;
  /** Undefined means the member has not edited the own rate in this session. */
  rateOverride?: string | null;
  currencyChanged?: boolean;
  /** True when the currency was guessed from a receipt and nobody has checked it yet. */
  currencyNeedsReview: boolean;
  /** The member selected or confirmed a currency this session. */
  currencyChecked: boolean;
}

export type FormPatch = Partial<ExpenseFormState>;

/** A new expense: today, paid by the caller, every active member included. */
export function newExpenseState(options: { members: ReadonlyArray<Member>; meId: number; currency: string; now?: Date }): ExpenseFormState {
  const active = options.members.filter((m) => m.active).map((m) => m.id);
  return {
    description: '',
    merchant: null,
    amountText: '',
    expenseDate: today(options.now),
    payerId: options.meId,
    splitType: 'even',
    included: active,
    portions: Object.fromEntries(active.map((id) => [id, 1])),
    items: [],
    tax: 0,
    taxIncluded: false,
    tip: 0,
    serviceCharge: 0,
    discount: 0,
    currency: options.currency,
    currencyNeedsReview: false,
    currencyChecked: false,
  };
}

/** The form filled from a saved expense. */
export function stateFromExpense(expense: ExpenseView): ExpenseFormState {
  const included = expense.shares.filter((s) => s.itemId === null);
  return {
    description: expense.description,
    merchant: expense.merchant,
    amountText: expense.total === 0 ? '' : amountText(expense.total, expense.currency),
    expenseDate: expense.expenseDate,
    payerId: expense.payerId,
    splitType: expense.splitType,
    included: included.map((s) => s.memberId),
    portions: Object.fromEntries(included.map((s) => [s.memberId, s.weight])),
    items: expense.items.map((item) => ({
      label: item.label,
      quantity: item.quantity,
      amount: item.amount,
      shares: expense.shares.filter((s) => s.itemId === item.id).map((s) => ({ memberId: s.memberId, weight: s.weight })),
    })),
    tax: expense.tax,
    taxIncluded: expense.taxIncluded,
    tip: expense.tip,
    serviceCharge: expense.serviceCharge,
    discount: expense.discount,
    currency: expense.currency,
    currencyNeedsReview: expense.currencyNeedsReview,
    currencyChecked: false,
  };
}

/** The typed amount in minor units, or null when it cannot be read. An empty field is 0. */
export function parseAmount(text: string, currency: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  try {
    return toMinorUnits(trimmed, currency);
  } catch {
    return null;
  }
}

/** The members included in the expense, as the split type in use counts them. */
export function includedShares(state: ExpenseFormState): ShareInput[] {
  if (state.splitType === 'portions') {
    return Object.entries(state.portions)
      .map(([id, weight]) => ({ memberId: Number(id), weight }))
      .filter((s) => Number.isInteger(s.weight) && s.weight > 0);
  }
  return state.included.map((memberId) => ({ memberId }));
}

/**
 * The whole expense, ready to send. An untouched own rate is deliberately omitted.
 */
export function toExpenseInput(state: ExpenseFormState, total: number): ExpenseInput {
  const shares = includedShares(state);
  const includedIds = new Set(shares.map((s) => s.memberId));
  return {
    payerId: state.payerId,
    description: state.description.trim(),
    merchant: state.merchant,
    expenseDate: state.expenseDate,
    total,
    tax: state.tax,
    taxIncluded: state.taxIncluded,
    tip: state.tip,
    serviceCharge: state.serviceCharge,
    discount: state.discount,
    splitType: state.splitType,
    // A person taken out of the expense is taken off its items too.
    items: state.items.map((item) => ({ ...item, shares: (item.shares ?? []).filter((s) => includedIds.has(s.memberId)) })),
    shares,
    ...(state.currencyChanged || state.currencyChecked ? { currency: state.currency } : {}),
    ...(state.rateOverride !== undefined ? { rateOverride: state.rateOverride } : {}),
  };
}

/** The people to list in the form: everyone active, and anyone already on this expense. */
export function formMembers(members: ReadonlyArray<Member>, state: ExpenseFormState): Member[] {
  const onExpense = new Set<number>([state.payerId, ...state.included, ...Object.keys(state.portions).map(Number).filter((id) => (state.portions[id] ?? 0) > 0)]);
  return members.filter((m) => m.active || onExpense.has(m.id));
}

/** Preserve displayed numbers, rounding half up when the destination has fewer decimals.
 * This is decimal rescaling, not exchange-rate conversion. Nothing is mutated on failure.
 */
export function changeCurrency(state: ExpenseFormState, currency: string): ExpenseFormState {
  const oldScale = 10n ** BigInt(currencyDecimals(state.currency));
  const newScale = 10n ** BigInt(currencyDecimals(currency));
  const rescale = (value: number): number => {
    const scaled = (BigInt(value) * newScale * 2n + oldScale) / (oldScale * 2n);
    if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('This amount is too large. Enter a smaller amount first.');
    return Number(scaled);
  };
  const total = parseAmount(state.amountText, state.currency);
  if (total === null) throw new Error('Check the amount before changing currency.');
  return {
    ...state,
    currency,
    currencyChanged: state.currencyChanged || currency !== state.currency,
    currencyChecked: true,
    currencyNeedsReview: false,
    ...(currency !== state.currency && state.rateOverride !== undefined ? { rateOverride: null } : {}),
    amountText: state.amountText === '' ? '' : oldScale === newScale ? state.amountText : fromMinorUnits(rescale(total), currency),
    items: state.items.map((item) => ({ ...item, amount: rescale(item.amount) })),
    tax: rescale(state.tax),
    tip: rescale(state.tip),
    serviceCharge: rescale(state.serviceCharge),
    discount: rescale(state.discount),
  };
}
