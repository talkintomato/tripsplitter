// Not exported from src/db/index.ts. Shared by the operations only.
import { CURRENCIES, isSupportedCurrency, isValidRate, resolveRate, type CurrencyCode, type ResolvedRate } from '../core/index.js';
import { nowIso } from './clock.js';
import { NotFoundError, PermissionError, ValidationError, type ExpenseRef } from './errors.js';
import type {
  Activity,
  ActivityAction,
  ActivityEntityType,
  Actor,
  Db,
  Expense,
  ExpenseDetail,
  ExpenseItem,
  Group,
  Member,
  Scope,
  Settlement,
  Share,
  Trip,
  TripFxRate,
} from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

/** better-sqlite3 returns rows as unknown. */
const mapper =
  <T>(fn: (r: Row) => T) =>
  (row: unknown): T =>
    fn(row as Row);

export const mapMember = mapper<Member>((r) => ({
  id: r.id,
  groupId: r.group_id,
  telegramUserId: r.telegram_user_id,
  displayName: r.display_name,
  username: r.username,
  active: r.active === 1,
  joinedVia: r.joined_via,
  mergedInto: r.merged_into,
  createdAt: r.created_at,
}));

export const mapTrip = mapper<Trip>((r) => ({
  id: r.id,
  groupId: r.group_id,
  name: r.name,
  homeCurrency: r.home_currency,
  homeCurrencyLocked: r.home_currency_locked === 1,
  status: r.status,
  setupDone: r.setup_done === 1,
  createdAt: r.created_at,
  endedAt: r.ended_at,
}));

export const mapExpense = mapper<Expense>((r) => ({
  id: r.id,
  tripId: r.trip_id,
  createdBy: r.created_by,
  payerId: r.payer_id,
  description: r.description,
  merchant: r.merchant,
  expenseDate: r.expense_date,
  total: r.total,
  tax: r.tax,
  taxIncluded: r.tax_included === 1,
  tip: r.tip,
  serviceCharge: r.service_charge,
  discount: r.discount,
  currency: r.currency,
  currencyNeedsReview: r.currency_needs_review === 1,
  fxRate: r.fx_rate,
  fxRateSource: r.fx_rate_source,
  splitType: r.split_type,
  receiptFileId: r.receipt_file_id,
  emoji: r.emoji ?? null,
  status: r.status,
  statusBeforeRemoval: r.status_before_removal,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
}));

export const mapItem = mapper<ExpenseItem>((r) => ({
  id: r.id,
  expenseId: r.expense_id,
  label: r.label,
  quantity: r.quantity,
  amount: r.amount,
  position: r.position,
}));

export const mapShare = mapper<Share>((r) => ({
  id: r.id,
  memberId: r.member_id,
  weight: r.weight,
  expenseId: r.expense_id,
  itemId: r.item_id,
}));

export const mapSettlement = mapper<Settlement>((r) => ({
  id: r.id,
  tripId: r.trip_id,
  createdBy: r.created_by,
  fromMemberId: r.from_member_id,
  toMemberId: r.to_member_id,
  amount: r.amount,
  status: r.status,
  version: r.version,
  createdAt: r.created_at,
}));

export const mapTripRate = mapper<TripFxRate>((r) => ({
  id: r.id,
  tripId: r.trip_id,
  currency: r.currency,
  rate: r.rate,
  origin: r.origin,
  setBy: r.set_by,
  updatedAt: r.updated_at,
}));

export const mapActivity = mapper<Activity>((r) => ({
  id: r.id,
  groupId: r.group_id,
  tripId: r.trip_id,
  actor: r.actor_kind === 'member' ? { kind: 'member', memberId: r.actor_id } : { kind: 'system' },
  action: r.action,
  entityType: r.entity_type,
  entityId: r.entity_id,
  before: r.before === null ? null : JSON.parse(r.before),
  after: r.after === null ? null : JSON.parse(r.after),
  createdAt: r.created_at,
}));

export function readGroup(db: Db, groupId: number): Group | undefined {
  const row = isId(groupId) ? (db.prepare('SELECT * FROM chat_group WHERE id = ?').get(groupId) as Row | undefined) : undefined;
  if (!row) return undefined;
  const aliases = db.prepare('SELECT chat_id FROM chat_alias WHERE group_id = ? ORDER BY id').all(groupId) as Array<{ chat_id: number }>;
  return {
    id: row.id,
    chatId: row.chat_id,
    previousChatIds: aliases.map((a) => a.chat_id),
    title: row.title,
    introMessageId: row.intro_message_id,
    linkVersion: row.link_version,
    createdAt: row.created_at,
  };
}

export const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export const actorId = (actor: Actor): number | null => (actor.kind === 'member' ? actor.memberId : null);

export interface ActivityInput {
  tripId?: number | null;
  action: ActivityAction;
  entityType: ActivityEntityType;
  entityId: number;
  before: unknown;
  after: unknown;
}

/** Writes one activity entry. Always called inside the transaction of the change it records. */
export function writeActivity(db: Db, scope: Scope, input: ActivityInput): void {
  db.prepare(
    `INSERT INTO activity (group_id, trip_id, actor_kind, actor_id, action, entity_type, entity_id, "before", "after", created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    scope.groupId,
    input.tripId ?? null,
    scope.actor.kind,
    actorId(scope.actor),
    input.action,
    input.entityType,
    input.entityId,
    input.before === null || input.before === undefined ? null : JSON.stringify(input.before),
    input.after === null || input.after === undefined ? null : JSON.stringify(input.after),
    nowIso(),
  );
}

function checkScopeShape(scope: Scope): void {
  if (typeof scope !== 'object' || scope === null || !isId(scope.groupId)) throw new NotFoundError('group', String(scope?.groupId));
  const actor = scope.actor;
  if (!actor || (actor.kind !== 'system' && !(actor.kind === 'member' && isId(actor.memberId)))) {
    throw new PermissionError('The scope has no valid actor.');
  }
}

/** For operations that read. The group must exist. A member actor must belong to the group. */
export function openForRead(db: Db, scope: Scope): Group {
  checkScopeShape(scope);
  const group = readGroup(db, scope.groupId);
  if (!group) throw new NotFoundError('group', scope.groupId);
  if (scope.actor.kind === 'member') {
    const row = db.prepare('SELECT * FROM member WHERE id = ?').get(scope.actor.memberId);
    if (!row || mapMember(row).groupId !== group.id) throw new PermissionError();
  }
  return group;
}

/**
 * For operations that change data. The group must exist. A member actor must belong to the group and must
 * not have been merged away. Whether the member is active plays no part: every member can do every action.
 */
export function openForWrite(db: Db, scope: Scope): Group {
  const group = openForRead(db, scope);
  if (scope.actor.kind === 'member') {
    const member = mapMember(db.prepare('SELECT * FROM member WHERE id = ?').get(scope.actor.memberId));
    if (member.mergedInto !== null) throw new PermissionError();
  }
  return group;
}

/** The acting member's ID, for changes that need a person, such as creating an expense. */
export function requireMemberActor(scope: Scope): number {
  if (scope.actor.kind !== 'member') throw new PermissionError('This needs a member. The system cannot do it.');
  return scope.actor.memberId;
}

/** A member of the scope's group by ID, merged ones included. Throws `NotFoundError` for another group's member. */
export function loadMember(db: Db, scope: Scope, memberId: number): Member {
  const row = isId(memberId) ? db.prepare('SELECT * FROM member WHERE id = ? AND group_id = ?').get(memberId, scope.groupId) : undefined;
  if (!row) throw new NotFoundError('member', String(memberId));
  return mapMember(row);
}

/** A trip of the scope's group. Throws `NotFoundError` for another group's trip. */
export function loadTrip(db: Db, scope: Scope, tripId: number): Trip {
  const row = isId(tripId) ? db.prepare('SELECT * FROM trip WHERE id = ? AND group_id = ?').get(tripId, scope.groupId) : undefined;
  if (!row) throw new NotFoundError('trip', String(tripId));
  return mapTrip(row);
}

/** An expense whose trip belongs to the scope's group, with items and shares. */
export function loadExpense(db: Db, scope: Scope, expenseId: number): ExpenseDetail {
  const row = isId(expenseId)
    ? db
        .prepare('SELECT e.* FROM expense e JOIN trip t ON t.id = e.trip_id WHERE e.id = ? AND t.group_id = ?')
        .get(expenseId, scope.groupId)
    : undefined;
  if (!row) throw new NotFoundError('expense', String(expenseId));
  return withItemsAndShares(db, mapExpense(row));
}

export function withItemsAndShares(db: Db, expense: Expense): ExpenseDetail {
  const items = db.prepare('SELECT * FROM expense_item WHERE expense_id = ? ORDER BY position, id').all(expense.id).map(mapItem);
  const shares = db
    .prepare(
      `SELECT s.* FROM share s LEFT JOIN expense_item i ON i.id = s.item_id
       WHERE s.expense_id = ? OR i.expense_id = ?
       ORDER BY (s.item_id IS NOT NULL), i.position, s.item_id, s.member_id`,
    )
    .all(expense.id, expense.id)
    .map(mapShare);
  return { ...expense, items, shares };
}

/** A settlement whose trip belongs to the scope's group. */
export function loadSettlement(db: Db, scope: Scope, settlementId: number): Settlement {
  const row = isId(settlementId)
    ? db
        .prepare('SELECT s.* FROM settlement s JOIN trip t ON t.id = s.trip_id WHERE s.id = ? AND t.group_id = ?')
        .get(settlementId, scope.groupId)
    : undefined;
  if (!row) throw new NotFoundError('settlement', String(settlementId));
  return mapSettlement(row);
}

/** Checks that a member named in the input (payer, share, settlement party) belongs to the group and was not merged away. */
export function usableMember(db: Db, scope: Scope, memberId: unknown, role: string): Member {
  const row = isId(memberId) ? db.prepare('SELECT * FROM member WHERE id = ? AND group_id = ?').get(memberId, scope.groupId) : undefined;
  const member = row ? mapMember(row) : undefined;
  if (!member || member.mergedInto !== null) {
    throw new ValidationError('member_not_in_group', `The ${role} is not a member of this group.`);
  }
  return member;
}

export function assertTripOpen(trip: Trip): void {
  if (trip.status !== 'active') {
    throw new ValidationError('trip_ended', 'This trip has ended. Only settlements can be recorded on it.');
  }
}

export function assertCurrency(code: unknown): CurrencyCode {
  if (!isSupportedCurrency(code)) {
    throw new ValidationError(
      'unsupported_currency',
      `${String(code)} is not a supported currency. Supported: ${CURRENCIES.map((c) => c.code).join(', ')}.`,
    );
  }
  return code;
}

export function assertRate(rate: unknown): string {
  if (!isValidRate(rate)) {
    throw new ValidationError(
      'invalid_input',
      'The rate must be a number above zero with at most 6 decimal places, for example 112.4.',
    );
  }
  return rate;
}

export function assertVersionNumber(expectedVersion: unknown): number {
  if (!isId(expectedVersion)) throw new ValidationError('invalid_input', 'The version of the record is needed to change it.');
  return expectedVersion;
}

export function cleanText(value: unknown, what: string, options: { max?: number; allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string') throw new ValidationError('invalid_input', `The ${what} must be text.`);
  const text = value.trim();
  if (text === '' && !options.allowEmpty) throw new ValidationError('invalid_input', `The ${what} cannot be empty.`);
  const max = options.max ?? 200;
  if (text.length > max) throw new ValidationError('invalid_input', `The ${what} is too long. The limit is ${max} characters.`);
  return text;
}

const ONE_EMOJI = /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)$/u;

/** One emoji, or null to have none. Anything else is refused. */
export function cleanEmoji(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 32 || !ONE_EMOJI.test(value.trim())) {
    throw new ValidationError('invalid_input', 'The picture of an expense must be one emoji.');
  }
  return value.trim();
}

export function cleanOptionalText(value: unknown, what: string, max = 200): string | null {
  if (value === null || value === undefined) return null;
  const text = cleanText(value, what, { allowEmpty: true, max });
  return text === '' ? null : text;
}

export function assertAmount(value: unknown, what: string, options: { positive?: boolean } = {}): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError('invalid_input', `The ${what} must be a whole number of minor units, zero or more.`);
  }
  if (options.positive && value === 0) throw new ValidationError('invalid_input', `The ${what} must be more than zero.`);
  return value;
}

export function assertDate(value: unknown, what: string): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value) return value;
  }
  throw new ValidationError('invalid_input', `The ${what} must be a date in the form YYYY-MM-DD.`);
}

export function findTripRate(db: Db, tripId: number, currency: string): TripFxRate | undefined {
  const row = db.prepare('SELECT * FROM trip_fx_rate WHERE trip_id = ? AND currency = ?').get(tripId, currency);
  return row ? mapTripRate(row) : undefined;
}

/** The rate an expense of this trip and currency gets, given the rate set on the expense itself, if any. */
export function resolveForTrip(db: Db, trip: Trip, currency: string, expenseOverride: string | null): ResolvedRate {
  return resolveRate({
    expenseCurrency: currency,
    homeCurrency: trip.homeCurrency,
    expenseOverride,
    tripRate: findTripRate(db, trip.id, currency)?.rate ?? null,
  });
}

/**
 * Re-resolves the rate of the given expenses. For each expense whose rate or source changes: the version
 * goes up by one and one `expense.rate_change` entry is written, with the whole expense before and after.
 * `keepOverride` false drops rates set on the expense. Returns the changed expenses as they are now.
 */
export function reresolveExpenses(
  db: Db,
  scope: Scope,
  trip: Trip,
  expenses: Expense[],
  options: { keepOverride: boolean },
): ExpenseDetail[] {
  const changed: ExpenseDetail[] = [];
  const update = db.prepare(
    'UPDATE expense SET fx_rate = ?, fx_rate_source = ?, version = version + 1, updated_at = ? WHERE id = ?',
  );
  for (const expense of expenses) {
    const override = options.keepOverride && expense.fxRateSource === 'expense' ? expense.fxRate : null;
    const resolved = resolveForTrip(db, trip, expense.currency, override);
    if (resolved.rate === expense.fxRate && resolved.source === expense.fxRateSource) continue;
    const before = withItemsAndShares(db, expense);
    update.run(resolved.rate, resolved.source, nowIso(), expense.id);
    const after = withItemsAndShares(db, mapExpense(db.prepare('SELECT * FROM expense WHERE id = ?').get(expense.id)));
    writeActivity(db, scope, {
      tripId: trip.id,
      action: 'expense.rate_change',
      entityType: 'expense',
      entityId: expense.id,
      before,
      after,
    });
    changed.push(after);
  }
  return changed;
}

export const expenseRef = (e: Expense): ExpenseRef => ({
  id: e.id,
  tripId: e.tripId,
  description: e.description,
  merchant: e.merchant,
  expenseDate: e.expenseDate,
  total: e.total,
  currency: e.currency,
  status: e.status,
});
