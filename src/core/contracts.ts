// Shared types, so that the bot (PRD 1), the API (PRD 2), the receipt reader (PRD 3) and the rate lookup
// (PRD 3b) agree without importing each other. Types only.
import type { Amount, SplitType } from './types.js';

/** Where a trip rate came from. */
export type RateOrigin = 'suggested' | 'member';

export interface NoticeShare {
  /** Display name of the member. */
  name: string;
  /** Minor units of the expense currency. */
  amount: Amount;
}

/** Optional for older callers; all mutation paths supply this context. */
export interface ExpenseNoticeContext {
  actorMemberId: number;
  tripId: number;
  tripName: string;
  payerId: number;
  memberIds: number[];
  homeCurrency: string;
  /** Foundation balances for this expense alone, in home minor units. */
  balances: Record<number, number>;
}

export interface ExpenseNotice {
  personal?: ExpenseNoticeContext;
  beforePersonal?: ExpenseNoticeContext;
  /** Telegram chat to post in. */
  chatId: number;
  /** Display name of the member who made the change. */
  actorName: string;
  expenseId: number;
  groupId: number;
  /** What to call the expense: its description, or the merchant when it has none. */
  description: string;
  /** Minor units of the expense currency. */
  total: Amount;
  currency: string;
  splitType: SplitType;
  /** Each member's amount in the expense currency. */
  shares: NoticeShare[];
}

export interface SettlementNotice {
  groupId?: number;
  actorMemberId?: number;
  tripId?: number;
  tripName?: string;
  fromMemberId?: number;
  toMemberId?: number;
  chatId: number;
  /** Display name of the member who recorded, undid or restored it. */
  actorName: string;
  /** Display name of the member who paid. */
  fromName: string;
  /** Display name of the member who was paid. */
  toName: string;
  /** Minor units of the home currency. */
  amount: Amount;
  /** The trip's home currency. */
  currency: string;
}

export interface RateNotice {
  groupId?: number;
  actorMemberId?: number;
  tripId?: number;
  tripName?: string;
  /** Only members whose foundation balance changed because of this rate. */
  affectedMemberIds?: number[];
  chatId: number;
  actorName: string;
  homeCurrency: string;
  /** The foreign currency the rate is for. */
  currency: string;
  /** Units of `currency` per 1 unit of `homeCurrency`, as entered. */
  rate: string;
  origin: RateOrigin;
  /** Number of expenses whose rate changed. */
  expensesChanged: number;
}

export interface TripNotice {
  groupId?: number;
  chatId: number;
  actorName: string;
  tripName: string;
}

export interface LinkResetNotice {
  chatId: number;
  groupId: number;
  /** Display name of the member who reset the link. */
  actorName: string;
}

export interface MemberJoinedNotice {
  groupId?: number;
  chatId: number;
  /** Display name of the person who joined through the link. */
  memberName: string;
}

/**
 * Posts one line to the group per change. Functions never throw: a failure to post is logged by the
 * implementation. Changes that are logged in activity and post no notice: adding a member by hand, claiming
 * a member, renaming a trip, changing home currency, finishing setup, discarding or restoring a draft,
 * saving a draft.
 */
export interface Notifier {
  expenseSaved(n: ExpenseNotice): Promise<void>;
  expenseEdited(n: ExpenseNotice & { changes: string[] }): Promise<void>;
  expenseDeleted(n: ExpenseNotice): Promise<void>;
  expenseRestored(n: ExpenseNotice): Promise<void>;
  settlementRecorded(n: SettlementNotice): Promise<void>;
  settlementUndone(n: SettlementNotice): Promise<void>;
  settlementRestored(n: SettlementNotice): Promise<void>;
  tripRateChanged(n: RateNotice): Promise<void>;
  tripEnded(n: TripNotice): Promise<void>;
  tripReopened(n: TripNotice): Promise<void>;
  linkReset(n: LinkResetNotice): Promise<void>;
  memberJoinedByLink(n: MemberJoinedNotice): Promise<void>;
}

/**
 * Looks up the latest rate: the number of units of `to` equal to 1 unit of `from`, as a decimal string with
 * at most 6 decimal places, or null when no rate could be found. Callers pass the trip's home currency as
 * `from` and the expense currency as `to`, which is the direction `setTripRate` stores.
 * Implemented by PRD 3b. Tests pass a fake.
 */
export type RateSuggester = (from: string, to: string) => Promise<string | null>;
