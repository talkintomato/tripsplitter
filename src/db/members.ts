import { computeShares, convertExpense, isValidRate, planMerge, validateExpense } from '../core/index.js';
import { nowIso } from './clock.js';
import { cleanProfile } from './groups.js';
import { ValidationError } from './errors.js';
import {
  cleanText,
  expenseRef,
  loadMember,
  mapExpense,
  mapMember,
  mapSettlement,
  mapTrip,
  mapTripRate,
  openForRead,
  openForWrite,
  requireMemberActor,
  withItemsAndShares,
  writeActivity,
} from './internal.js';
import type { Db, ExpenseDetail, Member, Scope, Settlement, TelegramProfile } from './types.js';

export interface UpsertMemberResult {
  member: Member;
  /** True when the member did not exist before. */
  created: boolean;
  /** True when the member was created, renamed or marked active again. */
  changed: boolean;
}

/**
 * Adds a Telegram user to the group, or updates their display name and username and marks them active.
 * Matched by Telegram user ID, so someone who joined by link and later posts in the chat stays one member.
 * Meant to be called for every message the bot sees. The caller must never pass a bot.
 * `joinedVia` says how a new member arrived: `chat` (the default) or `link`. It is set once, when the
 * member is created, and not changed afterwards.
 * Activity: `member.add` when created, `member.activate` when an inactive member became active,
 * `member.update` when only the name or username changed. None when nothing changed.
 */
export function upsertTelegramMember(
  db: Db,
  scope: Scope,
  profile: TelegramProfile,
  options: { joinedVia?: 'chat' | 'link' } = {},
): UpsertMemberResult {
  const clean = cleanProfile(profile);
  const joinedVia = options.joinedVia ?? 'chat';
  if (joinedVia !== 'chat' && joinedVia !== 'link') {
    throw new ValidationError('invalid_input', 'A Telegram member joins through the chat or through the link.');
  }
  return db.transaction((): UpsertMemberResult => {
    openForWrite(db, scope);
    const row = db.prepare('SELECT * FROM member WHERE group_id = ? AND telegram_user_id = ?').get(scope.groupId, clean.telegramUserId);
    if (!row) {
      const id = Number(
        db
          .prepare(
            `INSERT INTO member (group_id, telegram_user_id, display_name, username, active, joined_via, created_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(scope.groupId, clean.telegramUserId, clean.displayName, clean.username, joinedVia, nowIso()).lastInsertRowid,
      );
      const member = loadMember(db, scope, id);
      writeActivity(db, scope, { action: 'member.add', entityType: 'member', entityId: id, before: null, after: member });
      return { member, created: true, changed: true };
    }

    const before = mapMember(row);
    const renamed = before.displayName !== clean.displayName || before.username !== clean.username;
    const reactivated = !before.active;
    if (!renamed && !reactivated) return { member: before, created: false, changed: false };
    db.prepare('UPDATE member SET display_name = ?, username = ?, active = 1 WHERE id = ?').run(clean.displayName, clean.username, before.id);
    const member = loadMember(db, scope, before.id);
    writeActivity(db, scope, {
      action: reactivated ? 'member.activate' : 'member.update',
      entityType: 'member',
      entityId: member.id,
      before,
      after: member,
    });
    return { member, created: false, changed: true };
  })();
}

/**
 * Marks a member active, or inactive after they left or were removed from the chat. Inactive only means
 * "left out of new splits by default": it has no effect on what the member may do.
 * Throws `NotFoundError` for a member of another group and `ValidationError` `invalid_status` for a member
 * that was merged away.
 * Activity: `member.activate` or `member.deactivate`. None when the member was already so.
 */
export function setMemberActive(db: Db, scope: Scope, memberId: number, active: boolean): Member {
  if (typeof active !== 'boolean') throw new ValidationError('invalid_input', '"active" must be true or false.');
  return db.transaction(() => {
    openForWrite(db, scope);
    const before = loadMember(db, scope, memberId);
    if (before.mergedInto !== null) throw new ValidationError('invalid_status', 'This person was merged into another member.');
    if (before.active === active) return before;
    db.prepare('UPDATE member SET active = ? WHERE id = ?').run(active ? 1 : 0, memberId);
    const after = loadMember(db, scope, memberId);
    writeActivity(db, scope, {
      action: active ? 'member.activate' : 'member.deactivate',
      entityType: 'member',
      entityId: memberId,
      before,
      after,
    });
    return after;
  })();
}

/** Adds a person by name, without a Telegram account. They can be in splits and settlements at once. Activity: `member.add`. */
export function addManualMember(db: Db, scope: Scope, displayName: string): Member {
  const name = cleanText(displayName, 'name', { max: 128 });
  return db.transaction(() => {
    openForWrite(db, scope);
    const id = Number(
      db
        .prepare(
          `INSERT INTO member (group_id, telegram_user_id, display_name, username, active, joined_via, created_at)
           VALUES (?, NULL, ?, NULL, 1, 'manual', ?)`,
        )
        .run(scope.groupId, name, nowIso()).lastInsertRowid,
    );
    const member = loadMember(db, scope, id);
    writeActivity(db, scope, { action: 'member.add', entityType: 'member', entityId: id, before: null, after: member });
    return member;
  })();
}

/** A member of the group, merged ones included. Throws `NotFoundError` when missing or in another group. */
export function getMember(db: Db, scope: Scope, memberId: number): Member {
  openForRead(db, scope);
  return loadMember(db, scope, memberId);
}

/** The member of the group with this Telegram user ID, or undefined. */
export function findMemberByTelegramId(db: Db, scope: Scope, telegramUserId: number): Member | undefined {
  openForRead(db, scope);
  if (typeof telegramUserId !== 'number' || !Number.isSafeInteger(telegramUserId)) return undefined;
  const row = db.prepare('SELECT * FROM member WHERE group_id = ? AND telegram_user_id = ?').get(scope.groupId, telegramUserId);
  return row ? mapMember(row) : undefined;
}

/**
 * Members of the group ordered by name: active, inactive and hand-added. Members absorbed by a claim are
 * left out unless `includeMerged` is true. `activeOnly` leaves out inactive members, which gives the people
 * to tick by default in a new split.
 */
export function listMembers(db: Db, scope: Scope, options: { includeMerged?: boolean; activeOnly?: boolean } = {}): Member[] {
  openForRead(db, scope);
  const where = ['group_id = ?'];
  if (!options.includeMerged) where.push('merged_into IS NULL');
  if (options.activeOnly) where.push('active = 1');
  return db
    .prepare(`SELECT * FROM member WHERE ${where.join(' AND ')} ORDER BY display_name COLLATE NOCASE, id`)
    .all(scope.groupId)
    .map(mapMember);
}

export interface ClaimResult {
  /** The acting member, who now also stands for the hand-added one. */
  survivor: Member;
  /** The hand-added member, now with `mergedInto` set and inactive. */
  absorbed: Member;
  /** The expenses that changed, as they are now. */
  expenses: ExpenseDetail[];
  /** The settlements that changed, as they are now. */
  settlements: Settlement[];
}

/**
 * "That's me": the acting member claims a hand-added member. The actor must be a member with a Telegram
 * account and is the survivor. The hand-added member is absorbed.
 *
 * Refused with `ValidationError`, nothing changed:
 * - `claim_overlap`: both have a share on the same expense or the same item, in any trip and whatever the
 *   status of the expense. `expenses` lists them. Message: "Remove one of the two from these expenses first".
 * - `claim_changes_amounts`: on a confirmed or deleted expense the merge would move a rounding difference
 *   onto someone else, because the leftover goes to the lowest member ID. `expenses` lists them.
 * - `invalid_status`: the target has a Telegram account, was merged already, or is the actor.
 * - `invalid_input`: the actor has no Telegram account.
 * Throws `NotFoundError` for a member of another group and `PermissionError` for the system actor.
 * An inactive member can claim too.
 *
 * Otherwise, in one transaction and across all trips of the group: shares, payer, created-by and set-by
 * references and both ends of every settlement, undone ones included, move to the survivor. A settlement
 * that would then be from the survivor to themselves is marked undone. The absorbed member gets `mergedInto`
 * set and `active` false. The version of each expense and settlement touched goes up by one.
 * Afterwards every other member's balance is unchanged and the survivor's balance is the sum of the two.
 *
 * Activity: one `member.claim`, one `expense.member_merged` per expense touched, one
 * `settlement.member_merged` per settlement touched, one `trip_rate.member_merged` per trip rate touched.
 */
export function claimMember(db: Db, scope: Scope, manualMemberId: number): ClaimResult {
  return db.transaction((): ClaimResult => {
    openForWrite(db, scope);
    const survivorBefore = loadMember(db, scope, requireMemberActor(scope));
    const absorbedBefore = loadMember(db, scope, manualMemberId);
    if (survivorBefore.telegramUserId === null) {
      throw new ValidationError('invalid_input', 'Only someone with a Telegram account can claim a person.');
    }
    if (absorbedBefore.id === survivorBefore.id) throw new ValidationError('invalid_status', 'You cannot claim yourself.');
    if (absorbedBefore.mergedInto !== null) throw new ValidationError('invalid_status', 'This person was already claimed.');
    if (absorbedBefore.telegramUserId !== null) {
      throw new ValidationError('invalid_status', 'This person has their own Telegram account, so they cannot be claimed.');
    }
    const survivorId = survivorBefore.id;
    const absorbedId = absorbedBefore.id;
    const groupId = scope.groupId;

    const trips = new Map(db.prepare('SELECT * FROM trip WHERE group_id = ?').all(groupId).map((r) => [mapTrip(r).id, mapTrip(r)]));
    const expenses = db
      .prepare('SELECT e.* FROM expense e JOIN trip t ON t.id = e.trip_id WHERE t.group_id = ? ORDER BY e.id')
      .all(groupId)
      .map(mapExpense);
    const shares = db
      .prepare(
        `SELECT s.id, s.member_id AS memberId, s.expense_id AS expenseId, s.item_id AS itemId,
                COALESCE(s.expense_id, i.expense_id) AS ownerExpenseId
         FROM share s LEFT JOIN expense_item i ON i.id = s.item_id
         WHERE s.member_id IN (?, ?)`,
      )
      .all(survivorId, absorbedId) as Array<{ id: number; memberId: number; expenseId: number | null; itemId: number | null; ownerExpenseId: number }>;
    const settlements = db
      .prepare('SELECT s.* FROM settlement s JOIN trip t ON t.id = s.trip_id WHERE t.group_id = ? ORDER BY s.id')
      .all(groupId)
      .map(mapSettlement);
    const tripRates = db
      .prepare('SELECT r.* FROM trip_fx_rate r JOIN trip t ON t.id = r.trip_id WHERE t.group_id = ? ORDER BY r.id')
      .all(groupId)
      .map(mapTripRate);

    const plan = planMerge(survivorId, absorbedId, { expenses, shares, settlements, tripRates });
    const byId = new Map(expenses.map((e) => [e.id, e]));
    if (plan.overlappingExpenseIds.length > 0) {
      throw new ValidationError('claim_overlap', 'Remove one of the two from these expenses first', {
        expenses: plan.overlappingExpenseIds.map((id) => expenseRef(byId.get(id)!)),
      });
    }

    // The leftover of a split goes to the payer or to the lowest member ID. Moving a share to another ID
    // can therefore move a minor unit between people. Such a claim is refused rather than changing amounts.
    const before = new Map(plan.touchedExpenseIds.map((id) => [id, withItemsAndShares(db, byId.get(id)!)]));
    const swap = (memberId: number) => (memberId === absorbedId ? survivorId : memberId);
    const shifting = [...before.values()].filter((detail) => {
      if (detail.status !== 'confirmed' && detail.status !== 'deleted') return false;
      const home = trips.get(detail.tripId)!.homeCurrency;
      const was = homeAmounts(detail, home);
      const will = homeAmounts({ ...detail, payerId: swap(detail.payerId), shares: detail.shares.map((s) => ({ ...s, memberId: swap(s.memberId) })) }, home);
      if (was === null || will === null) return false;
      const ids = new Set([...was.keys()].map(swap));
      for (const id of will.keys()) ids.add(id);
      for (const id of ids) {
        const earlier = id === survivorId ? (was.get(survivorId) ?? 0n) + (was.get(absorbedId) ?? 0n) : (was.get(id) ?? 0n);
        if ((will.get(id) ?? 0n) !== earlier) return true;
      }
      return false;
    });
    if (shifting.length > 0) {
      throw new ValidationError(
        'claim_changes_amounts',
        'Claiming would move a rounding difference onto someone else on these expenses. Change who paid or who is included first.',
        { expenses: shifting.map(expenseRef) },
      );
    }

    const stamp = nowIso();
    db.prepare('UPDATE member SET active = 0, merged_into = ? WHERE id = ?').run(survivorId, absorbedId);
    const absorbed = loadMember(db, scope, absorbedId);
    const survivor = loadMember(db, scope, survivorId);
    writeActivity(db, scope, {
      action: 'member.claim',
      entityType: 'member',
      entityId: survivorId,
      before: { survivor: survivorBefore, absorbed: absorbedBefore },
      after: { survivor, absorbed, expenseIds: plan.touchedExpenseIds, settlementIds: plan.settlements.map((s) => s.id) },
    });

    for (const id of plan.shareIds) db.prepare('UPDATE share SET member_id = ? WHERE id = ?').run(survivorId, id);
    for (const id of plan.payerExpenseIds) db.prepare('UPDATE expense SET payer_id = ? WHERE id = ?').run(survivorId, id);
    for (const id of plan.creatorExpenseIds) db.prepare('UPDATE expense SET created_by = ? WHERE id = ?').run(survivorId, id);
    const changedExpenses: ExpenseDetail[] = [];
    for (const id of plan.touchedExpenseIds) {
      db.prepare('UPDATE expense SET version = version + 1, updated_at = ? WHERE id = ?').run(stamp, id);
      const after = withItemsAndShares(db, mapExpense(db.prepare('SELECT * FROM expense WHERE id = ?').get(id)));
      writeActivity(db, scope, {
        tripId: after.tripId,
        action: 'expense.member_merged',
        entityType: 'expense',
        entityId: id,
        before: before.get(id),
        after,
      });
      changedExpenses.push(after);
    }

    const settlementBefore = new Map(settlements.map((s) => [s.id, s]));
    const changedSettlements: Settlement[] = [];
    for (const change of plan.settlements) {
      db.prepare(
        `UPDATE settlement SET from_member_id = ?, to_member_id = ?, created_by = ?,
           status = CASE WHEN ? THEN 'undone' ELSE status END, version = version + 1 WHERE id = ?`,
      ).run(change.fromMemberId, change.toMemberId, change.createdBy, change.fromMemberId === change.toMemberId ? 1 : 0, change.id);
      const after = mapSettlement(db.prepare('SELECT * FROM settlement WHERE id = ?').get(change.id));
      writeActivity(db, scope, {
        tripId: after.tripId,
        action: 'settlement.member_merged',
        entityType: 'settlement',
        entityId: change.id,
        before: settlementBefore.get(change.id),
        after,
      });
      changedSettlements.push(after);
    }

    const rateBefore = new Map(tripRates.map((r) => [r.id, r]));
    for (const id of plan.tripRateIds) {
      db.prepare('UPDATE trip_fx_rate SET set_by = ? WHERE id = ?').run(survivorId, id);
      const after = mapTripRate(db.prepare('SELECT * FROM trip_fx_rate WHERE id = ?').get(id));
      writeActivity(db, scope, {
        tripId: after.tripId,
        action: 'trip_rate.member_merged',
        entityType: 'trip_rate',
        entityId: id,
        before: rateBefore.get(id),
        after,
      });
    }

    return { survivor, absorbed, expenses: changedExpenses, settlements: changedSettlements };
  })();
}

/** Each member's amount of an expense in home currency, or null when the expense cannot be worked out. */
function homeAmounts(detail: ExpenseDetail, homeCurrency: string): Map<number, bigint> | null {
  if (validateExpense(detail, detail.items, detail.shares).length > 0) return null;
  const shares = computeShares(detail, detail.items, detail.shares);
  if (detail.fxRate === null || !isValidRate(detail.fxRate)) return shares;
  return convertExpense(detail, shares, homeCurrency).shares;
}
