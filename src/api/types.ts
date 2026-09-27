// The shapes that travel between the API and the Mini App. Types only, so the Mini App can import this
// file without pulling in any server code.
import type { ExpenseProblem, LaunchView } from '../core/index.js';
import type {
  Activity,
  CurrencyCode,
  ExpenseDetail,
  ExpenseInput,
  ExpenseRef,
  ExpenseStatus,
  Member,
  RateOrigin,
  Settlement,
  Trip,
  ValidationCode,
} from '../db/index.js';

/** An expense as the API returns it: the record, plus what each person owes. */
export interface ExpenseView extends ExpenseDetail {
  /** Home currency of the expense's trip. */
  homeCurrency: CurrencyCode;
  /** Each included member's amount in the expense currency. Null while the expense has a problem. */
  amounts: Record<number, number> | null;
  /** The total in home currency. Null without a rate or while the expense has a problem. */
  homeTotal: number | null;
  /** Each included member's amount in home currency. Null when `homeTotal` is. */
  homeAmounts: Record<number, number> | null;
  /** Everything that stops this expense from being confirmed. Empty when nothing does. */
  problems: ExpenseProblem[];
  /** A sentence to show with the expense, or null. Set when the exchange rate could not be looked up. */
  notice: string | null;
}

export const RATE_MISSING_NOTICE = "Couldn't look up an exchange rate. Enter one to save this.";

export interface GroupInfo {
  id: number;
  title: string;
  linkVersion: number;
}

export interface Destination {
  view: LaunchView;
  /** Only with view `expense`. */
  expenseId?: number;
  /** Only with view `expense`: the trip the expense belongs to, which may have ended. */
  tripId?: number;
}

export interface GroupResponse {
  group: GroupInfo;
  /** The caller. */
  me: Member;
  members: Member[];
  access: 'write';
  activeTrip: Trip | null;
  /** The home currency a trip started now would get. */
  newTripCurrency: CurrencyCode;
  destination: Destination;
  /** The group's link, to share. */
  link: string;
}

export interface TripsResponse {
  trips: Trip[];
}

export interface TripResponse {
  trip: Trip;
}

export interface CreateTripBody {
  name?: string;
  homeCurrency?: string;
}

export interface PatchTripBody {
  name?: string;
  homeCurrency?: string;
  /** Only `true` is accepted: setup cannot be undone. */
  setupDone?: true;
}

/** Body of `POST /api/trips/:tripId/expenses`. */
export interface CreateExpenseBody extends ExpenseInput {
  /** Defaults to `confirmed`. */
  status?: 'draft' | 'confirmed';
}

/** Body of `PUT /api/expenses/:id`. */
export interface SaveExpenseBody extends ExpenseInput {
  version: number;
  /** For a draft: save and confirm in one step. Either both happen or neither. */
  confirm?: boolean;
}

export interface VersionBody {
  version: number;
}

export interface RateSet {
  currency: string;
  rate: string;
  origin: RateOrigin;
}

export interface ExpenseResponse {
  expense: ExpenseView;
}

export interface ExpenseWriteResponse extends ExpenseResponse {
  /** Set when this request looked up a rate and made it the trip's rate. */
  rateSet: RateSet | null;
  /** True when the expense was asked to be confirmed and was kept as a draft, because no rate was found. */
  keptAsDraft: boolean;
}

export interface ExpensesResponse {
  expenses: ExpenseView[];
}

export interface BalancesResponse {
  trip: Trip;
  /** Home currency, minor units. Positive: is owed money. A member missing here has 0. */
  balances: Record<number, number>;
  payments: Array<{ fromMemberId: number; toMemberId: number; amount: number }>;
  /** Active and undone, newest first. */
  settlements: Settlement[];
}

export interface CreateSettlementBody {
  fromMemberId: number;
  toMemberId: number;
  amount: number;
}

export interface SettlementResponse {
  settlement: Settlement;
}

export interface AddMemberBody {
  displayName: string;
}

export interface MemberResponse {
  member: Member;
}

export interface ClaimResponse {
  me: Member;
  members: Member[];
}

export interface ResetLinkResponse {
  group: GroupInfo;
  /** The start parameter to use from now on. The one the request came with has stopped working. */
  launch: string;
  link: string;
}

export interface RestoreTarget {
  kind: 'expense' | 'settlement';
  id: number;
  version: number;
}

export interface ActivityEntry extends Activity {
  /** Display name of the member who did it, or "TripSplitter" for the system. */
  actorName: string;
  /** Set when the record can be restored from this entry. */
  restore: RestoreTarget | null;
}

export interface ActivityResponse {
  entries: ActivityEntry[];
  /** Pass as `before` for the next page. Null on the last page. */
  nextBefore: number | null;
}

export type ApiErrorCode =
  | 'unauthorized'
  | 'link_invalid'
  | 'forbidden'
  | 'not_found'
  | 'stale'
  | 'server_error'
  | ValidationCode;

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    /** Fit to show a member. */
    message: string;
    problems?: ExpenseProblem[];
    expenses?: ExpenseRef[];
    /** Only with `stale`. */
    entityType?: 'expense' | 'settlement' | 'trip_rate';
    /** Only with `stale`: the record as it is now. An `ExpenseView` for an expense, a `Settlement` for a settlement. */
    current?: unknown;
  };
}

export type { ExpenseStatus };
