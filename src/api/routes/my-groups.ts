import type { Hono } from 'hono';
import { encodeLaunch } from '../../core/index.js';
import { getActiveTrip, getTripBalances, listExpenses, listGroupsForTelegramUser, memberScope, now } from '../../db/index.js';
import { authenticate } from '../auth.js';
import type { ApiEnv, Services } from '../context.js';
import type { MyGroupsResponse } from '../types.js';

/** Terminal, exact GET route: authenticates identity without resolving or creating membership. */
export function registerMyGroupsRoute(app: Hono<ApiEnv>, { config, db }: Services): void {
  app.get('/api/my-groups', async (c, next) => {
    // Hono also matches GET handlers for HEAD; keep the exception GET-only.
    if (c.req.method !== 'GET') return next();
    const authorization = c.req.header('Authorization') ?? '';
    const initData = /^tma\s+/i.test(authorization) ? authorization.replace(/^tma\s+/i, '') : '';
    const user = authenticate(config, initData, now());
    const response: MyGroupsResponse = {
      botUsername: config.botUsername,
      groups: listGroupsForTelegramUser(db, user.id).map(({ group, member }) => {
        const scope = memberScope(group.id, member.id);
        const trip = getActiveTrip(db, scope);
        return {
          id: group.id,
          title: group.title,
          tripName: trip?.name ?? null,
          balance: trip ? { amount: getTripBalances(db, scope, trip.id).balances[member.id] ?? 0, currency: trip.homeCurrency } : null,
          draftsCount: trip ? listExpenses(db, scope, trip.id, { status: ['draft'] }).length : 0,
          launch: encodeLaunch({ groupId: group.id, linkVersion: group.linkVersion, view: 'home' }, config.linkSecret),
        };
      }),
    };
    return c.json(response);
  });
}
