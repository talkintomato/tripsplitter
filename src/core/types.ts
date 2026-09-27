/** How an expense is divided between members. */
export type SplitType = 'even' | 'portions' | 'items';

/**
 * An amount in minor units. Records and inputs hold whole numbers as `number` (they travel as JSON);
 * the arithmetic converts them to `bigint` and returns `bigint`. A `number` must be a safe integer.
 */
export type Amount = number | bigint;

/** The figures of an expense that the split arithmetic needs. Amounts are minor units of the expense currency. */
export interface SplitExpense {
  payerId: number;
  total: Amount;
  tax: Amount;
  /** True when the item prices already include the tax. A stored field, never guessed from the numbers. */
  taxIncluded: boolean;
  tip: Amount;
  serviceCharge: Amount;
  discount: Amount;
  splitType: SplitType;
}

/** A receipt line. `amount` is the line total: "Beer x2 16.00" has amount 1600. Quantity is never multiplied in. */
export interface SplitItem {
  /** Any number unique within the expense. For an unsaved expense use the line's index. */
  id: number;
  amount: Amount;
  /** Descriptive only. Ignored by the arithmetic. */
  quantity?: number;
}

/**
 * One member's part in an expense or in one item.
 * `itemId` null or missing: the member is included in the expense.
 * `itemId` set: the member is assigned to that item, and must also be included in the expense.
 */
export interface SplitShare {
  memberId: number;
  /** Positive whole number. Ignored by even splits. */
  weight: number;
  expenseId?: number | null;
  itemId?: number | null;
}

export type ProblemField =
  | 'total'
  | 'tax'
  | 'tip'
  | 'serviceCharge'
  | 'discount'
  | 'shares'
  | 'items'
  | 'fxRate'
  | 'currency';

export type ProblemCode =
  | 'total_not_positive'
  | 'invalid_amount'
  | 'no_members'
  | 'invalid_weight'
  | 'duplicate_member'
  | 'no_items'
  | 'unknown_item'
  | 'member_not_included'
  | 'total_mismatch'
  | 'zero_items_with_adjustments'
  | 'rate_missing'
  | 'rate_invalid'
  | 'currency_needs_review';

/** One reason an expense cannot be confirmed. */
export interface ExpenseProblem {
  /** The field of the expense the problem concerns. */
  field: ProblemField;
  code: ProblemCode;
  /** Plain sentence fit to show a member. */
  message: string;
  /** Only with `total_mismatch`: total minus expected total, in minor units. Positive: the total is more than the parts explain. */
  difference?: number;
}

/** Thrown by `computeShares`, `convertExpense` and `computeBalances` when an expense does not pass validation. */
export class InvalidExpenseError extends Error {
  readonly problems: ExpenseProblem[];

  constructor(problems: ExpenseProblem[]) {
    super(problems[0]?.message ?? 'This expense cannot be split.');
    this.name = 'InvalidExpenseError';
    this.problems = problems;
  }
}

/** An expense with what is needed to work out balances. An `ExpenseDetail` from `src/db` fits this type. */
export interface BalanceExpense extends SplitExpense {
  id: number;
  status: string;
  /** Currency code of the expense, from `CURRENCIES`. */
  currency: string;
  /** Units of the expense currency per 1 unit of home currency, as text. "1" for the home currency. Null when missing. */
  fxRate: string | null;
  items: SplitItem[];
  shares: SplitShare[];
}

/** A settlement with what is needed to work out balances. `amount` is in home currency minor units. */
export interface BalanceSettlement {
  fromMemberId: number;
  toMemberId: number;
  amount: Amount;
  status: string;
}

/** One suggested payment, in home currency minor units. */
export interface Payment {
  fromMemberId: number;
  toMemberId: number;
  amount: bigint;
}
