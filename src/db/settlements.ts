import { nowIso } from './clock.js';
import { StaleEditError, ValidationError } from './errors.js';
import {
  assertAmount,
  assertVersionNumber,
  loadSettlement,
  loadTrip,
  mapSettlement,
  openForRead,
  openForWrite,
  requireMemberActor,
  usableMember,
  writeActivity,
} from './internal.js';
import type { Db, Scope, Settlement, SettlementStatus } from './types.js';

/**
 * Records that `fromMemberId` paid `toMemberId`. `amount` is in the trip's home currency, minor units, above
 * zero. Allowed on an ended trip. The actor must be a member and becomes `createdBy`.
 * Locks the trip's home currency. Throws `NotFoundError` for a trip of another group and `ValidationError`
 * `member_not_in_group` or `invalid_input`. Activity: `settlement.create`.
 */
export function createSettlement(
  db: Db,
  scope: Scope,
  input: { tripId: number; fromMemberId: number; toMemberId: number; amount: number },
): Settlement {
  return db.transaction(() => {
    openForWrite(db, scope);
    const createdBy = requireMemberActor(scope);
    const trip = loadTrip(db, scope, input.tripId);
    const from = usableMember(db, scope, input.fromMemberId, 'person paying');
    const to = usableMember(db, scope, input.toMemberId, 'person being paid');
    if (from.id === to.id) throw new ValidationError('invalid_input', 'A payment needs two different people.');
    const amount = assertAmount(input.amount, 'amount', { positive: true });
    const id = Number(
      db
        .prepare(
          `INSERT INTO settlement (trip_id, created_by, from_member_id, to_member_id, amount, status, version, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', 1, ?)`,
        )
        .run(trip.id, createdBy, from.id, to.id, amount, nowIso()).lastInsertRowid,
    );
    db.prepare('UPDATE trip SET home_currency_locked = 1 WHERE id = ?').run(trip.id);
    const settlement = loadSettlement(db, scope, id);
    writeActivity(db, scope, { tripId: trip.id, action: 'settlement.create', entityType: 'settlement', entityId: id, before: null, after: settlement });
    return settlement;
  })();
}

/** A settlement of the group. Throws `NotFoundError` when it does not exist or belongs to another group. */
export function getSettlement(db: Db, scope: Scope, settlementId: number): Settlement {
  openForRead(db, scope);
  return loadSettlement(db, scope, settlementId);
}

/** Settlements of a trip, newest first. Without `status`: active and undone. */
export function listSettlements(db: Db, scope: Scope, tripId: number, options: { status?: SettlementStatus } = {}): Settlement[] {
  openForRead(db, scope);
  loadTrip(db, scope, tripId);
  const rows = options.status
    ? db.prepare('SELECT * FROM settlement WHERE trip_id = ? AND status = ? ORDER BY id DESC').all(tripId, options.status)
    : db.prepare('SELECT * FROM settlement WHERE trip_id = ? ORDER BY id DESC').all(tripId);
  return rows.map(mapSettlement);
}

function changeStatus(db: Db, scope: Scope, settlementId: number, expectedVersion: number, to: SettlementStatus): Settlement {
  return db.transaction(() => {
    openForWrite(db, scope);
    const before = loadSettlement(db, scope, settlementId);
    const version = assertVersionNumber(expectedVersion);
    if (before.status === to) {
      throw new ValidationError('invalid_status', to === 'undone' ? 'This payment was already undone.' : 'This payment is already active.');
    }
    if (version !== before.version) throw new StaleEditError('settlement', before.id, before);
    if (to === 'active') {
      if (before.fromMemberId === before.toMemberId) {
        throw new ValidationError('invalid_status', 'This payment was between two members who are now one person, so it cannot be restored.');
      }
      usableMember(db, scope, before.fromMemberId, 'person paying');
      usableMember(db, scope, before.toMemberId, 'person being paid');
    }
    db.prepare('UPDATE settlement SET status = ?, version = version + 1 WHERE id = ?').run(to, settlementId);
    const after = loadSettlement(db, scope, settlementId);
    writeActivity(db, scope, {
      tripId: before.tripId,
      action: to === 'undone' ? 'settlement.undo' : 'settlement.restore',
      entityType: 'settlement',
      entityId: settlementId,
      before,
      after,
    });
    return after;
  })();
}

/**
 * Active to undone, so it no longer counts. Allowed on an ended trip.
 * Throws `ValidationError` `invalid_status` when it is undone already, then `StaleEditError` when
 * `expectedVersion` is not the current version. Activity: `settlement.undo`.
 */
export function undoSettlement(db: Db, scope: Scope, settlementId: number, expectedVersion: number): Settlement {
  return changeStatus(db, scope, settlementId, expectedVersion, 'undone');
}

/**
 * Undone to active, so it counts again. Allowed on an ended trip.
 * Throws `ValidationError` `invalid_status` when it is active already or is from a member to themselves
 * after a claim, then `StaleEditError` for an old version. Activity: `settlement.restore`.
 */
export function restoreSettlement(db: Db, scope: Scope, settlementId: number, expectedVersion: number): Settlement {
  return changeStatus(db, scope, settlementId, expectedVersion, 'active');
}
