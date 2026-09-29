import { validateExpense, type ExpenseProblem } from '../core/index.js';
import { nowIso } from './clock.js';
import { StaleEditError, ValidationError } from './errors.js';
import {
  assertAmount,
  assertCurrency,
  assertDate,
  assertRate,
  assertTripOpen,
  assertVersionNumber,
  cleanEmoji,
  cleanOptionalText,
  cleanText,
  loadExpense,
  loadTrip,
  mapExpense,
  openForRead,
  openForWrite,
  requireMemberActor,
  resolveForTrip,
  usableMember,
  withItemsAndShares,
  writeActivity,
} from './internal.js';
import type {
  ActivityAction,
  CreateExpenseInput,
  Db,
  Expense,
  ExpenseDetail,
  ExpenseInput,
  ExpenseItemInput,
  ExpenseStatus,
  Scope,
  ShareInput,
  SplitType,
  Trip,
} from './types.js';

/** Location is a single optional unit; unrelated edits preserve it. */
function cleanLocation(input: ExpenseInput, before?: Expense): [number | null, number | null, string | null, string | null] {
  const keys = ['locationLat', 'locationLng', 'placeName', 'locationSource'] as const;
  if (keys.every(key => input[key] === undefined)) {
    return [before?.locationLat ?? null, before?.locationLng ?? null, before?.placeName ?? null, before?.locationSource ?? null];
  }
  const { locationLat: lat, locationLng: lng } = input;
  if ((lat === null && lng === null) || (lat == null && lng == null && input.placeName == null && input.locationSource == null)) return [null, null, null, null];
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180 ||
      (input.locationSource != null && input.locationSource !== 'photo' && input.locationSource !== 'device')) {
    throw new ValidationError('invalid_input', 'Choose a valid location with both coordinates.');
  }
  return [Number(lat.toFixed(5)), Number(lng.toFixed(5)), cleanOptionalText(input.placeName, 'place', 200), input.locationSource ?? null];
}

interface CleanShare {
  memberId: number;
  weight: number;
}

function cleanShares(db: Db, scope: Scope, shares: ShareInput[] | undefined, role: string): CleanShare[] {
  if (shares === undefined || shares === null) return [];
  if (!Array.isArray(shares)) throw new ValidationError('invalid_input', 'The list of people must be a list.');
  const seen = new Set<number>();
  return shares.map((share) => {
    const weight = share?.weight ?? 1;
    if (typeof weight !== 'number' || !Number.isSafeInteger(weight) || weight <= 0) {
      throw new ValidationError('invalid_input', 'Each portion must be a whole number above zero.');
    }
    const member = usableMember(db, scope, share?.memberId, role);
    if (seen.has(member.id)) throw new ValidationError('invalid_input', `${member.displayName} is listed twice.`);
    seen.add(member.id);
    return { memberId: member.id, weight };
  });
}

function assertSplitType(value: unknown): SplitType {
  if (value === 'even' || value === 'portions' || value === 'items') return value;
  throw new ValidationError('invalid_input', 'The split type must be even, portions or items.');
}

function assertFlag(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError('invalid_input', `"${what}" must be true or false.`);
  return value;
}

/** Writes the items and both kinds of shares of an expense. The expense must have none. */
function writeItemsAndShares(db: Db, scope: Scope, expenseId: number, input: ExpenseInput): void {
  const included = cleanShares(db, scope, input.shares, 'person in the split');
  const includedIds = new Set(included.map((s) => s.memberId));
  const insertShare = db.prepare('INSERT INTO share (member_id, weight, expense_id, item_id) VALUES (?, ?, ?, ?)');
  for (const share of included) insertShare.run(share.memberId, share.weight, expenseId, null);

  const items: ExpenseItemInput[] = input.items ?? [];
  if (!Array.isArray(items)) throw new ValidationError('invalid_input', 'The items must be a list.');
  if (items.length > 500) throw new ValidationError('invalid_input', 'An expense can have at most 500 items.');
  const insertItem = db.prepare('INSERT INTO expense_item (expense_id, label, quantity, amount, position) VALUES (?, ?, ?, ?, ?)');
  items.forEach((item, position) => {
    const label = cleanText(item?.label ?? '', 'item name', { allowEmpty: true });
    const quantity = item.quantity ?? 1;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
      throw new ValidationError('invalid_input', 'The quantity of an item must be above zero.');
    }
    const amount = assertAmount(item.amount, 'line total of an item');
    const itemId = Number(insertItem.run(expenseId, label === '' ? 'Item' : label, quantity, amount, position).lastInsertRowid);
    for (const share of cleanShares(db, scope, item.shares, 'person assigned to an item')) {
      if (!includedIds.has(share.memberId)) {
        throw new ValidationError('invalid_input', 'A person assigned to an item must be included in the expense.');
      }
      insertShare.run(share.memberId, share.weight, null, itemId);
    }
  });
}

/** A rate given for one expense, or null when none applies. For the home currency any value is ignored. */
function cleanOverride(rateOverride: string | null | undefined, currency: string, trip: Trip): string | null {
  if (currency === trip.homeCurrency) return null;
  if (rateOverride === null || rateOverride === undefined) return null;
  return assertRate(rateOverride);
}

/** Everything that stops the expense from counting toward balances, in the order a member should fix it. */
function confirmProblems(detail: ExpenseDetail): ExpenseProblem[] {
  // The currency read from a receipt is not a problem: confirming accepts it (the flag is cleared then).
  const problems: ExpenseProblem[] = [];
  if (detail.fxRateSource === 'missing' || detail.fxRate === null) {
    problems.push({ field: 'fxRate', code: 'rate_missing', message: 'This needs an exchange rate before it can be saved.' });
  }
  return [...problems, ...validateExpense(detail, detail.items, detail.shares)];
}

function assertConfirmable(detail: ExpenseDetail): void {
  const problems = confirmProblems(detail);
  const first = problems[0];
  if (!first) return;
  const code = first.code === 'currency_needs_review' || first.code === 'rate_missing' ? first.code : 'invalid_expense';
  throw new ValidationError(code, first.message, { problems });
}

/**
 * Creates an expense with its items and shares, as one unit. The actor must be a member and becomes
 * `createdBy`. The rate and its source are worked out here: `home` when the currency is the trip's home
 * currency, `expense` when `rateOverride` is given, otherwise the trip's rate, otherwise `missing`.
 * With status `confirmed` (the default) the expense must pass every check of `confirmExpense`, and the
 * trip's home currency is locked. A draft may be incomplete, but its members, amounts and currency must
 * still be acceptable.
 * Throws `NotFoundError` for a trip of another group, `PermissionError` for the system actor, and
 * `ValidationError`: `trip_ended`, `unsupported_currency`, `member_not_in_group`,
 * `invalid_input`, and for a confirmed expense `rate_missing`, `invalid_expense`.
 * Activity: `expense.create`.
 */
export function createExpense(db: Db, scope: Scope, input: CreateExpenseInput): ExpenseDetail {
  return db.transaction(() => {
    openForWrite(db, scope);
    const createdBy = requireMemberActor(scope);
    const trip = loadTrip(db, scope, input.tripId);
    assertTripOpen(trip);

    const status = input.status ?? 'confirmed';
    if (status !== 'draft' && status !== 'confirmed') {
      throw new ValidationError('invalid_input', 'A new expense is a draft or confirmed.');
    }
    const currency = assertCurrency(input.currency ?? trip.homeCurrency);
    const payer = usableMember(db, scope, input.payerId, 'payer');
    const resolved = resolveForTrip(db, trip, currency, cleanOverride(input.rateOverride, currency, trip));
    const stamp = nowIso();

    // Inserted as a draft, so that a confirmed expense is checked with its items and shares in place.
    const id = Number(
      db
        .prepare(
          `INSERT INTO expense (trip_id, created_by, payer_id, description, merchant, expense_date, total, tax, tax_included,
             tip, service_charge, discount, currency, currency_needs_review, fx_rate, fx_rate_source, split_type,
             receipt_file_id, emoji, location_lat, location_lng, place_name, location_source, status, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?)`,
        )
        .run(
          trip.id,
          createdBy,
          payer.id,
          cleanText(input.description ?? '', 'description', { allowEmpty: true, max: 500 }),
          cleanOptionalText(input.merchant, 'merchant'),
          assertDate(input.expenseDate, 'date'),
          assertAmount(input.total, 'total'),
          assertAmount(input.tax ?? 0, 'tax'),
          assertFlag(input.taxIncluded ?? false, 'taxIncluded') ? 1 : 0,
          assertAmount(input.tip ?? 0, 'tip'),
          assertAmount(input.serviceCharge ?? 0, 'service charge'),
          assertAmount(input.discount ?? 0, 'discount'),
          currency,
          // Only a draft keeps the flag; a confirmed expense has its currency accepted.
          assertFlag(input.currencyNeedsReview ?? false, 'currencyNeedsReview') && status !== 'confirmed' ? 1 : 0,
          resolved.rate,
          resolved.source,
          assertSplitType(input.splitType),
          cleanOptionalText(input.receiptFileId, 'receipt reference', 500),
          cleanEmoji(input.emoji),
          ...cleanLocation(input),
          stamp,
          stamp,
        ).lastInsertRowid,
    );
    writeItemsAndShares(db, scope, id, input);

    if (status === 'confirmed') {
      assertConfirmable(loadExpense(db, scope, id));
      db.prepare(`UPDATE expense SET status = 'confirmed' WHERE id = ?`).run(id);
      db.prepare('UPDATE trip SET home_currency_locked = 1 WHERE id = ?').run(trip.id);
    }
    const detail = loadExpense(db, scope, id);
    writeActivity(db, scope, { tripId: trip.id, action: 'expense.create', entityType: 'expense', entityId: id, before: null, after: detail });
    return detail;
  })();
}

/** An expense of the group with its items and shares, whatever its status. Throws `NotFoundError` when missing or in another group. */
export function getExpense(db: Db, scope: Scope, expenseId: number): ExpenseDetail {
  openForRead(db, scope);
  return loadExpense(db, scope, expenseId);
}

/**
 * Expenses of a trip with items and shares, newest date first. Without `status`: drafts and confirmed
 * expenses. Pass one status or a list to choose, for example `['discarded', 'deleted']`.
 */
export function listExpenses(
  db: Db,
  scope: Scope,
  tripId: number,
  options: { status?: ExpenseStatus | ExpenseStatus[] } = {},
): ExpenseDetail[] {
  openForRead(db, scope);
  loadTrip(db, scope, tripId);
  const statuses = options.status === undefined ? ['draft', 'confirmed'] : Array.isArray(options.status) ? options.status : [options.status];
  if (statuses.length === 0) return [];
  return db
    .prepare(
      `SELECT * FROM expense WHERE trip_id = ? AND status IN (${statuses.map(() => '?').join(', ')})
       ORDER BY expense_date DESC, id DESC`,
    )
    .all(tripId, ...statuses)
    .map((row) => withItemsAndShares(db, mapExpense(row)));
}

/**
 * Replaces a draft or confirmed expense with the whole expense given: fields, items and shares, in one
 * transaction. The version goes up by one. See `ExpenseInput` for what a field left out means.
 * The rate is worked out again: `rateOverride` as a string sets the expense's own rate, null clears it and
 * returns the expense to the trip rate, left out keeps what the expense had. An expense that followed the
 * trip rate keeps source `trip`. Changing the currency clears the expense's own rate unless a new one is
 * given in the same call.
 * A confirmed expense must still pass every check of `confirmExpense` afterwards.
 * Throws, in this order: `NotFoundError`; `PermissionError`; `ValidationError` `trip_ended`;
 * `ValidationError` `invalid_status` for a discarded or deleted expense; `StaleEditError` carrying the
 * current expense; then `ValidationError` for the input.
 * Activity: `expense.save`, with the whole expense before and after.
 */
export function saveExpense(db: Db, scope: Scope, expenseId: number, expectedVersion: number, input: ExpenseInput): ExpenseDetail {
  return db.transaction(() => {
    openForWrite(db, scope);
    const before = loadExpense(db, scope, expenseId);
    const version = assertVersionNumber(expectedVersion);
    const trip = loadTrip(db, scope, before.tripId);
    assertTripOpen(trip);
    if (before.status !== 'draft' && before.status !== 'confirmed') {
      throw new ValidationError('invalid_status', `This expense was ${before.status}. Restore it before changing it.`);
    }
    if (version !== before.version) throw new StaleEditError('expense', before.id, before);
    if (typeof input !== 'object' || input === null) throw new ValidationError('invalid_input', 'The expense is missing.');

    const currency = input.currency === undefined ? before.currency : assertCurrency(input.currency);
    const payer = usableMember(db, scope, input.payerId, 'payer');
    let override: string | null;
    if (input.rateOverride !== undefined) override = cleanOverride(input.rateOverride, currency, trip);
    else override = before.fxRateSource === 'expense' && currency === before.currency ? before.fxRate : null;
    const resolved = resolveForTrip(db, trip, currency, override);
    const asked =
      input.currencyNeedsReview !== undefined
        ? assertFlag(input.currencyNeedsReview, 'currencyNeedsReview')
        : input.currency !== undefined
          ? false
          : before.currencyNeedsReview;
    // A confirmed expense has its currency accepted, so the flag only ever stays on a draft.
    const needsReview = before.status === 'confirmed' ? false : asked;
    if (before.status === 'confirmed') {
      // A confirmed expense cannot be left without a rate.
      if (resolved.source === 'missing') {
        throw new ValidationError('rate_missing', 'This needs an exchange rate before it can be saved.', {
          problems: [{ field: 'fxRate', code: 'rate_missing', message: 'This needs an exchange rate before it can be saved.' }],
        });
      }
    }

    db.prepare(
      `UPDATE expense SET payer_id = ?, description = ?, merchant = ?, expense_date = ?, total = ?, tax = ?, tax_included = ?,
         tip = ?, service_charge = ?, discount = ?, currency = ?, currency_needs_review = ?, fx_rate = ?, fx_rate_source = ?,
         split_type = ?, receipt_file_id = ?, emoji = ?, location_lat = ?, location_lng = ?, place_name = ?, location_source = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(
      payer.id,
      cleanText(input.description ?? '', 'description', { allowEmpty: true, max: 500 }),
      cleanOptionalText(input.merchant, 'merchant'),
      assertDate(input.expenseDate, 'date'),
      assertAmount(input.total, 'total'),
      assertAmount(input.tax ?? 0, 'tax'),
      assertFlag(input.taxIncluded ?? false, 'taxIncluded') ? 1 : 0,
      assertAmount(input.tip ?? 0, 'tip'),
      assertAmount(input.serviceCharge ?? 0, 'service charge'),
      assertAmount(input.discount ?? 0, 'discount'),
      currency,
      needsReview ? 1 : 0,
      resolved.rate,
      resolved.source,
      assertSplitType(input.splitType),
      input.receiptFileId === undefined ? before.receiptFileId : cleanOptionalText(input.receiptFileId, 'receipt reference', 500),
      input.emoji === undefined ? before.emoji : cleanEmoji(input.emoji),
      ...cleanLocation(input, before),
      nowIso(),
      expenseId,
    );
    // Shares of the items go with them (ON DELETE CASCADE).
    db.prepare('DELETE FROM expense_item WHERE expense_id = ?').run(expenseId);
    db.prepare('DELETE FROM share WHERE expense_id = ?').run(expenseId);
    writeItemsAndShares(db, scope, expenseId, input);

    const after = loadExpense(db, scope, expenseId);
    if (after.status === 'confirmed') assertConfirmable(after);
    writeActivity(db, scope, { tripId: trip.id, action: 'expense.save', entityType: 'expense', entityId: expenseId, before, after });
    return after;
  })();
}

const TRANSITIONS: Record<'confirm' | 'discard' | 'delete' | 'restore', Partial<Record<ExpenseStatus, ExpenseStatus>>> = {
  confirm: { draft: 'confirmed' },
  discard: { draft: 'discarded' },
  delete: { confirmed: 'deleted' },
  restore: { discarded: 'draft', deleted: 'confirmed' },
};

const REFUSAL: Record<keyof typeof TRANSITIONS, string> = {
  confirm: 'Only a draft can be saved as an expense.',
  discard: 'Only a draft can be discarded.',
  delete: 'Only a saved expense can be deleted. A draft is discarded instead.',
  restore: 'Only a deleted expense or a discarded draft can be restored.',
};

function changeStatus(
  db: Db,
  scope: Scope,
  expenseId: number,
  expectedVersion: number,
  change: keyof typeof TRANSITIONS,
): ExpenseDetail {
  return db.transaction(() => {
    openForWrite(db, scope);
    const before = loadExpense(db, scope, expenseId);
    const version = assertVersionNumber(expectedVersion);
    const trip = loadTrip(db, scope, before.tripId);
    assertTripOpen(trip);
    const to = TRANSITIONS[change][before.status];
    if (to === undefined) {
      throw new ValidationError('invalid_status', `${REFUSAL[change]} This one is ${before.status}.`);
    }
    if (version !== before.version) throw new StaleEditError('expense', before.id, before);
    if (to === 'confirmed') {
      usableMember(db, scope, before.payerId, 'payer');
      assertConfirmable(before);
      db.prepare('UPDATE trip SET home_currency_locked = 1 WHERE id = ?').run(trip.id);
    }
    const removed = to === 'discarded' || to === 'deleted' ? before.status : null;
    // Confirming accepts the currency read from a receipt, so its review flag is cleared.
    db.prepare(
      `UPDATE expense SET status = ?, status_before_removal = ?, version = version + 1, updated_at = ?,
         currency_needs_review = CASE WHEN ? = 'confirmed' THEN 0 ELSE currency_needs_review END WHERE id = ?`,
    ).run(to, removed, nowIso(), to, expenseId);
    const after = loadExpense(db, scope, expenseId);
    writeActivity(db, scope, {
      tripId: trip.id,
      action: `expense.${change}` as ActivityAction,
      entityType: 'expense',
      entityId: expenseId,
      before,
      after,
    });
    return after;
  })();
}

/**
 * Draft to confirmed, so it counts toward balances. Locks the trip's home currency.
 * Throws, in this order: `NotFoundError`; `PermissionError`; `ValidationError` `trip_ended`;
 * `ValidationError` `invalid_status` unless the expense is a draft; `StaleEditError` carrying the current
 * expense; `ValidationError` `rate_missing`; `invalid_expense` with the problems
 * of `validateExpense`. `problems` on the error lists everything found, not only the first.
 * Activity: `expense.confirm`.
 */
export function confirmExpense(db: Db, scope: Scope, expenseId: number, expectedVersion: number): ExpenseDetail {
  return changeStatus(db, scope, expenseId, expectedVersion, 'confirm');
}

/**
 * Draft to discarded. The row and its receipt file ID are kept. Errors as `confirmExpense`, up to and
 * including `StaleEditError`. Activity: `expense.discard`.
 */
export function discardExpense(db: Db, scope: Scope, expenseId: number, expectedVersion: number): ExpenseDetail {
  return changeStatus(db, scope, expenseId, expectedVersion, 'discard');
}

/**
 * Confirmed to deleted. The row is kept. The home currency stays locked. Errors as `confirmExpense`, up to
 * and including `StaleEditError`. Activity: `expense.delete`.
 */
export function deleteExpense(db: Db, scope: Scope, expenseId: number, expectedVersion: number): ExpenseDetail {
  return changeStatus(db, scope, expenseId, expectedVersion, 'delete');
}

/**
 * Discarded back to draft, or deleted back to confirmed. Restoring a deleted expense runs the same checks
 * as `confirmExpense`. Errors as `confirmExpense`. Activity: `expense.restore`.
 */
export function restoreExpense(db: Db, scope: Scope, expenseId: number, expectedVersion: number): ExpenseDetail {
  return changeStatus(db, scope, expenseId, expectedVersion, 'restore');
}

const normaliseMerchant = (value: string) => value.toLowerCase().replace(/\s+/g, '');

/**
 * Confirmed expenses and open drafts of the trip with the same total, currency and date, and the same
 * merchant ignoring case and spacing. Oldest first. Empty when `merchant` is null or blank.
 * `excludeId` leaves one expense out, usually the draft being checked.
 */
export function findPossibleDuplicates(
  db: Db,
  scope: Scope,
  tripId: number,
  match: { merchant: string | null; total: number; currency: string; expenseDate: string; excludeId?: number },
): Expense[] {
  openForRead(db, scope);
  loadTrip(db, scope, tripId);
  if (typeof match.merchant !== 'string' || normaliseMerchant(match.merchant) === '') return [];
  const wanted = normaliseMerchant(match.merchant);
  return db
    .prepare(
      `SELECT * FROM expense
       WHERE trip_id = ? AND total = ? AND currency = ? AND expense_date = ?
         AND status IN ('draft', 'confirmed') AND merchant IS NOT NULL
       ORDER BY id`,
    )
    .all(tripId, match.total, match.currency, match.expenseDate)
    .map(mapExpense)
    .filter((e) => e.id !== match.excludeId && normaliseMerchant(e.merchant ?? '') === wanted);
}
