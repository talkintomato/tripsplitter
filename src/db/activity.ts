import { ValidationError } from './errors.js';
import { isId, loadExpense, loadSettlement, loadTrip, mapActivity, openForRead } from './internal.js';
import type { Activity, Db, Scope } from './types.js';

export interface ListActivityOptions {
  /** Only entries of this trip. Must be a trip of the group. */
  tripId?: number;
  /** Only entries with an ID below this one. Pass the ID of the last entry of the previous page. */
  before?: number;
  /** Page size. Defaults to 50, at most 200. */
  limit?: number;
  /**
   * Only entries about this one expense or settlement, which must be of the group. That includes entries written
   * by other operations that changed it, such as a trip rate change or a member merge.
   */
  entity?: { type: 'expense' | 'settlement'; id: number };
  /** Only one kind of entry: expenses, payments, people, or the trip and group themselves (names, rates, ending). */
  kind?: ActivityKind;
  /** Only entries made by this member. Entries made by TripSplitter itself are left out. */
  actorMemberId?: number;
}

export const ACTIVITY_KINDS = ['expenses', 'payments', 'people', 'trip'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** The action prefixes of each kind. Every action is named `<thing>.<what happened>`. */
const KIND_PREFIXES: Record<ActivityKind, string[]> = {
  expenses: ['expense.'],
  payments: ['settlement.'],
  people: ['member.'],
  trip: ['trip.', 'trip_rate.', 'group.'],
};

/**
 * Activity entries of the group, newest first. There is no operation that writes, changes or removes an
 * entry: the other operations write them, and the database refuses UPDATE and DELETE on the table.
 */
export function listActivity(db: Db, scope: Scope, options: ListActivityOptions = {}): Activity[] {
  openForRead(db, scope);
  const where = ['group_id = ?'];
  const params: Array<number | string> = [scope.groupId];
  if (options.tripId !== undefined) {
    loadTrip(db, scope, options.tripId);
    where.push('trip_id = ?');
    params.push(options.tripId);
  }
  if (options.entity !== undefined) {
    const { type, id } = options.entity;
    if (type !== 'expense' && type !== 'settlement') throw new ValidationError('invalid_input', 'The entity type must be expense or settlement.');
    if (!isId(id)) throw new ValidationError('invalid_input', 'The entity must be given by its ID.');
    // Refused, as not found, for a record of another group.
    if (type === 'expense') loadExpense(db, scope, id);
    else loadSettlement(db, scope, id);
    where.push('entity_type = ?', 'entity_id = ?');
    params.push(type, id);
  }
  if (options.kind !== undefined) {
    const prefixes = KIND_PREFIXES[options.kind];
    if (!prefixes) throw new ValidationError('invalid_input', `The kind must be one of: ${ACTIVITY_KINDS.join(', ')}.`);
    // The prefixes contain "_", which LIKE treats as any character, so it is escaped.
    where.push(`(${prefixes.map(() => "action LIKE ? ESCAPE '\\'").join(' OR ')})`);
    params.push(...prefixes.map((prefix) => `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`));
  }
  if (options.actorMemberId !== undefined) {
    if (!isId(options.actorMemberId)) throw new ValidationError('invalid_input', 'The member must be given by its ID.');
    where.push("actor_kind = 'member'", 'actor_id = ?');
    params.push(options.actorMemberId);
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
