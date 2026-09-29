import type { Hono } from 'hono';
import { z } from 'zod';
import { getGroupNotificationSettings, getMyNotificationSettings, setGroupNotification, setMyNotification } from '../../db/index.js';
import type { ApiEnv, Services } from '../context.js';
import { readBody } from '../schemas.js';

export function registerNotificationRoutes(app: Hono<ApiEnv>, { db, config }: Services): void {
  app.get('/api/notifications', c => {
    const { scope } = c.get('caller');
    return c.json({ group: getGroupNotificationSettings(db, scope), personal: getMyNotificationSettings(db, scope), canMessageMe: null, botUsername: config.botUsername });
  });
  for (const kind of ['group', 'personal'] as const) {
    app.put(`/api/notifications/${kind}/:type`, async c => {
      const { enabled } = await readBody(c, z.object({ enabled: z.boolean() }).strict());
      const { scope } = c.get('caller');
      (kind === 'group' ? setGroupNotification : setMyNotification)(db, scope, c.req.param('type'), enabled);
      return c.json({ enabled });
    });
  }
}
