import type Database from 'better-sqlite3';
import type { CurrencyCode, RateOrigin, RateSource, SplitType } from '../core/index.js';

/** An open database, from `openDatabase`. */
export type Db = Database.Database;

/** Who makes a change: a member, or the system for changes made by Telegram events or by the bot itself. */
export type Actor = { kind: 'member'; memberId: number } | { kind: 'system' };

/** The group an operation works in and who is acting. The first argument after `db` of every operation on group data. */
export interface Scope {
  groupId: number;
  actor: Actor;
}

export type JoinedVia = 'chat' | 'link' | 'manual';
export type TripStatus = 'active' | 'ended';
export type ExpenseStatus = 'draft' | 'confirmed' | 'discarded' | 'deleted';
export type SettlementStatus = 'active' | 'undone';
export type { CurrencyCode, RateOrigin, RateSource, SplitType };

/** One Telegram chat. Stored in table `chat_group`. */
export interface Group {
  id: number;
  /** The chat's current ID. */
  chatId: number;
  /** Earlier chat IDs, from before Telegram upgraded the chat. Oldest first. */
  previousChatIds: number[];
  title: string;
  /** Telegram message ID of the intro message, or null when none was posted. */
  introMessageId: number | null;
  /** The number links into the Mini App must carry. Starts at 1. `resetLink` adds 1. */
  linkVersion: number;
  createdAt: string;
}

export interface Member {
  id: number;
  groupId: number;
  /** Null for a member added by hand. */
  telegramUserId: number | null;
  displayName: string;
  username: string | null;
  /** True: included in new splits by default. False after the member left the chat. Has no effect on access. */
  active: boolean;
  /** `chat`: seen in the Telegram chat. `link`: joined by opening the group's link. `manual`: added by hand. */
  joinedVia: JoinedVia;
  /** Set when this member was absorbed by a claim. Such members are left out of lists by default. */
  mergedInto: number | null;
  createdAt: string;
}

export interface Trip {
  id: number;
  groupId: number;
  name: string;
  homeCurrency: CurrencyCode;
  /** True from the trip's first confirmed expense or settlement. Never goes back to false. */
  homeCurrencyLocked: boolean;
  status: TripStatus;
  /** True once a member finished or skipped the setup step. */
  setupDone: boolean;
  createdAt: string;
  endedAt: string | null;
}

export interface TripFxRate {
  id: number;
  tripId: number;
  currency: CurrencyCode;
  /** Units of `currency` equal to 1 unit of the trip's home currency, as entered. */
  rate: string;
  origin: RateOrigin;
  /** Null when set with the system actor. */
  setBy: number | null;
  updatedAt: string;
}

export interface Expense {
  id: number;
  tripId: number;
  createdBy: number;
  payerId: number;
  description: string;
  merchant: string | null;
  /** YYYY-MM-DD */
  expenseDate: string;
  /** Minor units of `currency`, as are tax, tip, serviceCharge and discount. */
  total: number;
  tax: number;
  /** True when the item prices already include the tax. */
  taxIncluded: boolean;
  tip: number;
  serviceCharge: number;
  discount: number;
  currency: CurrencyCode;
  /** True when the currency was guessed. The expense cannot be confirmed until a member saves it with the currency chosen. */
  currencyNeedsReview: boolean;
  /**
   * Units of `currency` equal to 1 unit of home currency, as entered ("112.4" for 1 SGD = 112.4 JPY).
   * "1" when `fxRateSource` is `home`. Null only when it is `missing`.
   */
  fxRate: string | null;
  /** Worked out by the operations, never taken from a caller. */
  fxRateSource: RateSource;
  splitType: SplitType;
  receiptFileId: string | null;
  /** An emoji chosen as the expense's picture, or null. */
  emoji: string | null;
  status: ExpenseStatus;
  /** For a discarded or deleted expense: the status that restoring returns it to. Otherwise null. */
  statusBeforeRemoval: 'draft' | 'confirmed' | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseItem {
  id: number;
  expenseId: number;
  label: string;
  /** Descriptive only. Never multiplied into the amount. */
  quantity: number;
  /** Line total in minor units. */
  amount: number;
  position: number;
}

/** Exactly one of `expenseId` and `itemId` is set. */
export interface Share {
  id: number;
  memberId: number;
  weight: number;
  expenseId: number | null;
  itemId: number | null;
}

/**
 * An expense with its items and every share: one versioned unit. `shares` holds both kinds in one list,
 * members included in the expense (`itemId` null) and members assigned to an item (`itemId` set).
 * Fits `validateExpense(detail, detail.items, detail.shares)`, `computeShares` and `computeBalances` as is.
 */
export interface ExpenseDetail extends Expense {
  items: ExpenseItem[];
  shares: Share[];
}

export interface Settlement {
  id: number;
  tripId: number;
  createdBy: number;
  /** The member who paid. */
  fromMemberId: number;
  /** The member who was paid. */
  toMemberId: number;
  /** Home currency of the trip, minor units. */
  amount: number;
  status: SettlementStatus;
  version: number;
  createdAt: string;
}

export type ActivityAction =
  | 'group.create'
  | 'group.rename'
  | 'group.migrate'
  | 'group.intro_message'
  | 'group.link_reset'
  | 'member.add'
  | 'member.update'
  | 'member.activate'
  | 'member.deactivate'
  | 'member.claim'
  | 'trip.create'
  | 'trip.rename'
  | 'trip.home_currency'
  | 'trip.setup_done'
  | 'trip.end'
  | 'trip.reopen'
  | 'trip_rate.set'
  | 'trip_rate.change'
  | 'trip_rate.remove'
  | 'trip_rate.member_merged'
  | 'expense.photo_added'
  | 'expense.photo_removed'
  | 'expense.create'
  | 'expense.save'
  | 'expense.rate_change'
  | 'expense.member_merged'
  | 'expense.confirm'
  | 'expense.discard'
  | 'expense.delete'
  | 'expense.restore'
  | 'settlement.create'
  | 'settlement.undo'
  | 'settlement.restore'
  | 'settlement.member_merged';

export type ActivityEntityType = 'group' | 'member' | 'trip' | 'trip_rate' | 'expense' | 'settlement';

export interface Activity {
  id: number;
  groupId: number;
  tripId: number | null;
  actor: Actor;
  action: ActivityAction;
  entityType: ActivityEntityType;
  entityId: number;
  /** The record before the change, parsed from JSON. Null for a creation. */
  before: unknown;
  /** The record after the change, parsed from JSON. Null for a removal. */
  after: unknown;
  createdAt: string;
}

/** What Telegram tells us about a person. */
export interface TelegramProfile {
  telegramUserId: number;
  displayName: string;
  username?: string | null;
}

/** A member in a list of shares. `weight` defaults to 1. */
export interface ShareInput {
  memberId: number;
  weight?: number;
}

export interface ExpenseItemInput {
  label: string;
  /** Descriptive only. Defaults to 1. */
  quantity?: number;
  /** Line total in minor units. */
  amount: number;
  /** Members assigned to this item, each of whom must be in the expense's `shares`. Empty or missing: shared by everyone included. */
  shares?: ShareInput[];
}

/**
 * A whole expense: fields, items and shares. Used by `createExpense` and `saveExpense`.
 * A field marked "default" takes that value when left out, also on a save, because a save replaces the
 * whole expense. The four marked "keeps" are the exceptions on a save.
 */
export interface ExpenseInput {
  payerId: number;
  /** Default: empty. */
  description?: string;
  /** Default: null. */
  merchant?: string | null;
  /** YYYY-MM-DD */
  expenseDate: string;
  /** Minor units of the currency. */
  total: number;
  /** Default: 0. */
  tax?: number;
  /** Default: false. */
  taxIncluded?: boolean;
  /** Default: 0. */
  tip?: number;
  /** Default: 0. */
  serviceCharge?: number;
  /** Default: 0. */
  discount?: number;
  /** Create: defaults to the trip's home currency. Save: left out keeps the currency. */
  currency?: string;
  /**
   * Create: defaults to false. Save: when left out, the flag is cleared if `currency` is given in the same
   * call (the member chose the currency) and kept otherwise.
   */
  currencyNeedsReview?: boolean;
  /**
   * A rate for this expense only, as a decimal string: units of the expense currency per 1 unit of home
   * currency. A string sets it, null clears it, left out keeps what the expense had.
   * Changing the currency clears it unless a new one is given in the same call.
   * Ignored for an expense in the home currency.
   */
  rateOverride?: string | null;
  splitType: SplitType;
  /** Create: defaults to null. Save: left out keeps it, null removes it. */
  receiptFileId?: string | null;
  /** One emoji as the expense's picture. Create: defaults to null. Save: left out keeps it, null removes it. */
  emoji?: string | null;
  /** Receipt lines in order. Default: none. Kept on the expense whatever the split type. */
  items?: ExpenseItemInput[];
  /** Members included in the expense. */
  shares: ShareInput[];
}

export interface CreateExpenseInput extends ExpenseInput {
  tripId: number;
  /** Defaults to `confirmed`. A draft may be incomplete. A confirmed expense must pass every check of `confirmExpense`. */
  status?: 'draft' | 'confirmed';
}

export interface ExpensePhoto {
  id: number;
  groupId: number;
  expenseId: number;
  fileKey: string;
  width: number;
  height: number;
  bytes: number;
  addedByMemberId: number;
  createdAt: string;
}
