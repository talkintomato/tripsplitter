import type { MiddlewareHandler } from 'hono';
import { decodeLaunch } from '../core/index.js';
import { memberScope, now } from '../db/index.js';
import { authenticate, resolveAccess } from './auth.js';
import type { ApiEnv, Services } from './context.js';
import { AccessError, LINK_INVALID_MESSAGE, OPEN_FROM_GROUP_MESSAGE } from './errors.js';
import { notify } from './notices.js';

/**
 * Runs before every route. Works out who is calling from Telegram's sign-in data and which group from the
 * signed start parameter, and stores both as the caller. Nothing else decides who acts.
 */
export function accessMiddleware({ config, db, deps }: Services): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const authorization = c.req.header('Authorization') ?? '';
    const initData = /^tma\s+/i.test(authorization) ? authorization.replace(/^tma\s+/i, '') : '';
    const user = authenticate(config, initData, now());

    const param = (c.req.header('X-Launch') ?? '').trim();
    if (param === '') throw new AccessError(401, 'unauthorized', OPEN_FROM_GROUP_MESSAGE);
    const launch = decodeLaunch(param, config.linkSecret);

    const access = resolveAccess(db, user, launch);
    if (access.level === 'none' || !access.member || !access.group) {
      throw new AccessError(403, 'link_invalid', LINK_INVALID_MESSAGE);
    }
    const { member, group } = access;
    c.set('caller', { scope: memberScope(group.id, member.id), member, group, launch });

    if (access.joined) {
      await notify('memberJoinedByLink', () => deps.notifier.memberJoinedByLink({ chatId: group.chatId, groupId: group.id, memberName: member.displayName }));
    }
    await next();
  };
}
