import { ValidationError } from './errors.js';
import { isId, loadTrip, mapActivity, openForRead } from './internal.js';
import type { Activity, Db, Scope } from './types.js';

export interface ListActivityOptions {
  /** Only entries of this trip. Must be a trip of the group. */
  tripId?: number;
  /** Only entries with an ID below this one. Pass the ID of the last entry of the previous page. */
  before?: number;
  /** Page size. Defaults to 50, at most 200. */
  limit?: number;
}

/**
 * Activity entries of the group, newest first. There is no operation that writes, changes or removes an
 * entry: the other operations write them, and the database refuses UPDATE and DELETE on the table.
 */
export function listActivity(db: Db, scope: Scope, options: ListActivityOptions = {}): Activity[] {
  openForRead(db, scope);
  const where = ['group_id = ?'];
  const params: number[] = [scope.groupId];
  if (options.tripId !== undefined) {
    loadTrip(db, scope, options.tripId);
    where.push('trip_id = ?');
    params.push(options.tripId);
  }
  if (options.before !== undefined) {
    if (!isId(options.before)) throw new ValidationError('invalid_input', '"before" must be the ID of an activity entry.');
    where.push('id < ?');
    params.push(options.before);
  }
  const limit = options.limit ?? 50;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
    throw new ValidationError('invalid_input', 'The limit must be a whole number above zero.');
  }
  return db
    .prepare(`SELECT * FROM activity WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .all(...params, Math.min(limit, 200))
    .map(mapActivity);
}
