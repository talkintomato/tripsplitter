import type { Hono } from 'hono';
import { DEFAULT_HOME_CURRENCY, encodeLaunch, launchUrl } from '../../core/index.js';
import {
  addManualMember,
  claimMember,
  getActiveTrip,
  getExpense,
  getGroup,
  listActivity,
  listMembers,
  listTrips,
  getSettlement,
  resetLink,
  ValidationError,
  type Activity,
  type Db,
  type ExpenseDetail,
  type Scope,
  type Settlement,
} from '../../db/index.js';
import { idParam, type ApiEnv, type Services } from '../context.js';
import { notify } from '../notices.js';
import { addMemberBody, readBody } from '../schemas.js';
import type {
  ActivityEntry,
  ActivityResponse,
  ClaimResponse,
  Destination,
  GroupResponse,
  MemberResponse,
  ResetLinkResponse,
  RestoreTarget,
} from '../types.js';
import { toGroupInfo } from '../views.js';

export const ACTIVITY_PAGE_SIZE = 50;

/** The record an entry is about, when restoring it from that entry makes sense now. */
function restoreTarget(db: Db, scope: Scope, entry: Activity, seen: Set<string>): RestoreTarget | null {
  const removal =
    (entry.entityType === 'expense' && (entry.action === 'expense.delete' || entry.action === 'expense.discard')) ||
    (entry.entityType === 'settlement' && entry.action === 'settlement.undo');
  if (!removal) return null;
  const key = `${entry.entityType}:${entry.entityId}`;
  if (seen.has(key)) return null;
  seen.add(key);
  try {
    if (entry.entityType === 'expense') {
      const expense: ExpenseDetail = getExpense(db, scope, entry.entityId);
      if (expense.status !== 'deleted' && expense.status !== 'discarded') return null;
      return { kind: 'expense', id: expense.id, version: expense.version };
    }
    const settlement: Settlement = getSettlement(db, scope, entry.entityId);
    if (settlement.status !== 'undone') return null;
    return { kind: 'settlement', id: settlement.id, version: settlement.version };
  } catch {
    return null;
  }
}

function positiveQuery(value: string | undefined, what: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^[1-9]\d{0,14}$/.test(value)) throw new ValidationError('invalid_input', `"${what}" must be a whole number above zero.`);
  return Number(value);
}

export function registerGroupRoutes(app: Hono<ApiEnv>, { config, db, deps }: Services): void {
  app.get('/api/group', (c) => {
    const { scope, member, launch } = c.get('caller');
    const group = getGroup(db, scope);

    const destination: Destination = { view: launch.view };
    if (launch.view === 'expense' && launch.expenseId !== undefined) {
      // Refused as not found when the expense belongs to another group.
      const expense = getExpense(db, scope, launch.expenseId);
      destination.expenseId = expense.id;
      destination.tripId = expense.tripId;
    }
    const response: GroupResponse = {
      group: toGroupInfo(group),
      me: member,
      members: listMembers(db, scope),
      access: 'write',
      activeTrip: getActiveTrip(db, scope) ?? null,
      newTripCurrency: listTrips(db, scope)[0]?.homeCurrency ?? DEFAULT_HOME_CURRENCY,
      destination,
      link: launchUrl(config, { groupId: group.id, linkVersion: group.linkVersion, view: 'home' }),
    };
    return c.json(response);
  });

  app.post('/api/group/reset-link', async (c) => {
    const caller = c.get('caller');
    const group = resetLink(db, caller.scope);
    await notify('linkReset', () =>
      deps.notifier.linkReset({ chatId: group.chatId, groupId: group.id, actorName: caller.member.displayName }),
    );
    const home = { groupId: group.id, linkVersion: group.linkVersion, view: 'home' as const };
    const response: ResetLinkResponse = {
      group: toGroupInfo(group),
      launch: encodeLaunch(home, config.linkSecret),
      link: launchUrl(config, home),
    };
    return c.json(response);
  });

  app.post('/api/members', async (c) => {
    const { scope } = c.get('caller');
    const body = await readBody(c, addMemberBody);
    const response: MemberResponse = { member: addManualMember(db, scope, body.displayName) };
    return c.json(response, 201);
  });

  app.post('/api/members/:id/claim', (c) => {
    const { scope } = c.get('caller');
    const result = claimMember(db, scope, idParam(c, 'id', 'member'));
    const response: ClaimResponse = { me: result.survivor, members: listMembers(db, scope) };
    return c.json(response);
  });

  app.get('/api/activity', (c) => {
    const { scope } = c.get('caller');
    const tripId = positiveQuery(c.req.query('tripId'), 'tripId');
    const before = positiveQuery(c.req.query('before'), 'before');
    // One record's history: both are needed, or neither.
    const entityType = c.req.query('entityType');
    const entityId = positiveQuery(c.req.query('entityId'), 'entityId');
    if ((entityType === undefined || entityType === '') !== (entityId === undefined)) {
      throw new ValidationError('invalid_input', 'Give both "entityType" and "entityId", or neither.');
    }
    if (entityType !== undefined && entityType !== '' && entityType !== 'expense' && entityType !== 'settlement') {
      throw new ValidationError('invalid_input', '"entityType" must be expense or settlement.');
    }
    const rows = listActivity(db, scope, {
      ...(tripId !== undefined ? { tripId } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(entityId !== undefined ? { entity: { type: entityType as 'expense' | 'settlement', id: entityId } } : {}),
      limit: ACTIVITY_PAGE_SIZE + 1,
    });
    const page = rows.slice(0, ACTIVITY_PAGE_SIZE);
    const names = new Map(listMembers(db, scope, { includeMerged: true }).map((m) => [m.id, m.displayName]));
    const seen = new Set<string>();
    const entries: ActivityEntry[] = page.map((entry) => ({
      ...entry,
      actorName: entry.actor.kind === 'member' ? (names.get(entry.actor.memberId) ?? 'Someone') : 'TripSplitter',
      restore: restoreTarget(db, scope, entry, seen),
    }));
    const last = page[page.length - 1];
    const response: ActivityResponse = { entries, nextBefore: rows.length > ACTIVITY_PAGE_SIZE && last ? last.id : null };
    return c.json(response);
  });
}
