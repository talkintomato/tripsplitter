import { nowIso, singaporeDate } from './clock.js';
import { NotFoundError, ValidationError } from './errors.js';
import { isId, readGroup } from './internal.js';
import type { Db } from './types.js';

/**
 * Reserves one call to the receipt model. In one transaction: counts the group's rows for the Singapore day
 * of `now` and inserts one if the count is below `cap`. Returns true when the reservation was made and false
 * at either cap. `globalCap` counts all groups on that day; omitted or zero disables only that limit.
 * An immediate transaction serializes reservations across database connections. A reservation is kept whatever the outcome of the model call.
 * Takes a group ID, not a scope: it holds a usage count and no group data, and writes no activity entry.
 * Throws `NotFoundError` when the group does not exist.
 */
export function reserveReceiptRead(db: Db, groupId: number, cap: number, now: Date, globalCap = 0): boolean {
  if (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 0) {
    throw new ValidationError('invalid_input', 'The cap must be a whole number, zero or more.');
  }
  if (!Number.isSafeInteger(globalCap) || globalCap < 0) {
    throw new ValidationError('invalid_input', 'The overall cap must be a whole number, zero or more.');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new ValidationError('invalid_input', 'The time is not valid.');
  return db.transaction(() => {
    if (!isId(groupId) || !readGroup(db, groupId)) throw new NotFoundError('group', String(groupId));
    const day = singaporeDate(now);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM receipt_read WHERE group_id = ? AND day = ?').get(groupId, day) as { n: number };
    if (n >= cap) return false;
    if (globalCap > 0) {
      const total = db.prepare('SELECT COUNT(*) AS n FROM receipt_read WHERE day = ?').get(day) as { n: number };
      if (total.n >= globalCap) return false;
    }
    db.prepare('INSERT INTO receipt_read (group_id, day, created_at) VALUES (?, ?, ?)').run(groupId, day, nowIso());
    return true;
  }).immediate();
}

/** How many receipt reads the group has reserved on the Singapore day of `now`. Throws `NotFoundError` when the group does not exist. */
export function countReceiptReads(db: Db, groupId: number, now: Date): number {
  if (!isId(groupId) || !readGroup(db, groupId)) throw new NotFoundError('group', String(groupId));
  const row = db.prepare('SELECT COUNT(*) AS n FROM receipt_read WHERE group_id = ? AND day = ?').get(groupId, singaporeDate(now)) as { n: number };
  return row.n;
}
