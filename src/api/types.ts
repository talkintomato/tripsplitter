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
  photos: Array<{ id: number; width: number; height: number }>;
  hasReceiptPhoto: boolean;
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
  /** What this expense means for the caller, in the trip's home currency. */
  myStake: MyStake;
}

/**
 * The caller's side of one expense, in home currency minor units.
 * `lent`: the caller paid, and this is the converted total less the caller's own converted share.
 * `borrowed`: someone else paid, and this is the caller's converted share.
 * `none`: the caller is not involved, the figure is zero, or there are no converted amounts yet.
 */
export interface MyStake {
  kind: 'lent' | 'borrowed' | 'none';
  amount: number;
  currency: CurrencyCode;
}

/** Totals of a trip's confirmed expenses, in home currency minor units. Drafts and removed expenses do not count. */
export interface TripSummary {
  /** The caller's converted shares, added up. */
  myExpenses: number;
  /** The converted totals, added up. */
  totalExpenses: number;
  currency: CurrencyCode;
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
  /**
   * Only `confirmed`, the default. `draft` is refused: drafts come from receipt photos, read by the bot.
   * Kept in the type so that such a request gets a message fit to show rather than an unreadable-body error.
   */
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
  /**
   * True when a receipt draft was asked to be approved and was kept a draft, with its changes saved, because no
   * rate was found. Always false for a new expense: that is refused instead, with `rate_missing`.
   */
  keptAsDraft: boolean;
}

export interface ExpensePreviewBody extends CreateExpenseBody {
  tripId?: number | 'active';
  expenseId?: number;
}

/** Answer of `POST /api/expenses/preview`. Nothing is saved. */
export interface ExpensePreviewResponse {
  /**
   * Present when trip or expense context was requested. When the trip has no rate for the currency, the live
   * rate is looked up and used, with `fxRateSource` 'suggested': saving the expense makes it the trip rate.
   */
  fx?: Pick<ExpenseView, 'fxRate' | 'homeTotal' | 'homeCurrency'> & { fxRateSource: ExpenseView['fxRateSource'] | 'suggested' };
  corrections?: { total: number | null; discount: number | null };
  /** Each included member's amount in the expense currency. Null while there is a problem. */
  amounts: Record<number, number> | null;
  /** Everything about the split that stops the expense from being saved. Empty when nothing does. */
  problems: ExpenseProblem[];
  /** Total minus expected total, when the figures of an item split do not add up. Null when they do. */
  difference: number | null;
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
  /** The caller's and the group's spending on the trip. */
  summary: TripSummary;
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

export interface ActivityEntry extends Omit<Activity, 'action'> {
  action: Activity['action'] | 'group.notification';
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

export interface MyGroupsResponse {
  botUsername: string;
  groups: Array<{
    id: number;
    title: string;
    tripName: string | null;
    /** Signed minor units of the active trip's home currency. */
    balance: { amount: number; currency: CurrencyCode } | null;
    draftsCount: number;
    launch: string;
  }>;
}

export interface NotificationsResponse {
  group: import('../db/notifications.js').GroupNotificationSettings;
  personal: import('../db/notifications.js').PersonalNotificationSettings;
  /** Null: private delivery history is not tracked reliably. */
  canMessageMe: boolean | null;
  botUsername: string;
}
