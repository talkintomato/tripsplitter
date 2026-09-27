import type { ExpenseProblem } from '../core/index.js';

export type ValidationCode =
  /** A field has a value that cannot be accepted. */
  | 'invalid_input'
  /** `validateExpense` reported problems. They are in `problems`. */
  | 'invalid_expense'
  | 'unsupported_currency'
  /** A payer, share member or settlement party is not a member of the group, or was merged away. */
  | 'member_not_in_group'
  /** The status does not allow the change, for example confirming an expense that is already confirmed. */
  | 'invalid_status'
  /** The trip has ended. Only settlements can be changed. */
  | 'trip_ended'
  /** The group already has an active trip. */
  | 'active_trip_exists'
  | 'home_currency_locked'
  /** The expense is in a foreign currency and has no rate. */
  | 'rate_missing'
  /** The currency of the expense was guessed and must be checked first. */
  | 'currency_needs_review'
  /** A claim was refused because both people are on the same expense or item. The expenses are in `expenses`. */
  | 'claim_overlap'
  /** A claim was refused because it would move a rounding difference onto someone else. The expenses are in `expenses`. */
  | 'claim_changes_amounts';

/** Base of every error the operations throw on purpose. `message` is fit to show a member. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The record does not exist, or belongs to another group, which looks the same on purpose. Map to HTTP 404.
 */
export class NotFoundError extends DomainError {
  readonly entityType: string;
  readonly entityId: number | string;

  constructor(entityType: string, entityId: number | string) {
    super(`That ${entityType.replace('_', ' ')} does not exist.`);
    this.entityType = entityType;
    this.entityId = entityId;
  }
}

/** An expense named in an error. */
export interface ExpenseRef {
  id: number;
  tripId: number;
  description: string;
  merchant: string | null;
  expenseDate: string;
  total: number;
  currency: string;
  status: string;
}

/** The input or the state does not allow the change. Nothing was changed. Map to HTTP 400. */
export class ValidationError extends DomainError {
  readonly code: ValidationCode;
  /** Every problem found, each with the field it concerns. Filled for `invalid_expense`, `rate_missing` and `currency_needs_review`. */
  readonly problems: ExpenseProblem[];
  /** Filled for `claim_overlap` and `claim_changes_amounts`: the expenses to change first. */
  readonly expenses: ExpenseRef[];

  constructor(
    code: ValidationCode,
    message: string,
    details: { problems?: ExpenseProblem[]; expenses?: ExpenseRef[] } = {},
  ) {
    super(message);
    this.code = code;
    this.problems = details.problems ?? [];
    this.expenses = details.expenses ?? [];
  }
}

/**
 * The record was changed by someone else since the caller loaded it. `current` is the record as it is now:
 * an `ExpenseDetail`, a `Settlement`, or for a trip rate a `TripRatePreview`. Nothing was changed. Map to HTTP 409.
 */
export class StaleEditError<T = unknown> extends DomainError {
  readonly entityType: 'expense' | 'settlement' | 'trip_rate';
  readonly entityId: number;
  readonly current: T;

  constructor(entityType: 'expense' | 'settlement' | 'trip_rate', entityId: number, current: T) {
    super('This was changed by someone else. Reload to see the latest version.');
    this.entityType = entityType;
    this.entityId = entityId;
    this.current = current;
  }
}

/**
 * The actor may not do this: a member of another group, a member that was merged away, or the system actor
 * where a person is needed. Map to HTTP 403.
 */
export class PermissionError extends DomainError {
  constructor(message = 'Only members of this group can do that.') {
    super(message);
  }
}
