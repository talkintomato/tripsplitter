import { Hono } from 'hono';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { accessMiddleware } from './access.js';
import type { ApiDeps, ApiEnv, Services } from './context.js';
import { handleError } from './errors.js';
import { registerExpenseRoutes } from './routes/expenses.js';
import { registerMyGroupsRoute } from './routes/my-groups.js';
import { registerGroupRoutes } from './routes/group.js';
import { registerTripRoutes } from './routes/trips.js';
import { registerRateRoutes } from './routes/rates.js';

export type { ApiDeps, ApiEnv } from './context.js';
export type * from './types.js';
export { RATE_MISSING_NOTICE } from './types.js';
export { LINK_INVALID_MESSAGE } from './errors.js';

/**
 * The HTTP API of the Mini App. Every route is under `/api` and needs the headers
 * `Authorization: tma <initData>` and `X-Launch: <start parameter>`.
 * Only GET /api/my-groups needs authentication alone.
 * Mount it in a server with `server.route('/', createApi(config, db, deps))`, or serve `app.fetch` directly.
 */
export function createApi(config: Config, db: Db, deps: ApiDeps): Hono<ApiEnv> {
  const services: Services = { config, db, deps };
  const app = new Hono<ApiEnv>();

  app.onError((error, c) => handleError(db, error, c));
  app.use('/api/*', async (c, next) => {
    await next();
    // Answers depend on who asks and change all the time.
    c.header('Cache-Control', 'no-store');
  });
  // Only this terminal GET handler runs before the group launch check.
  registerMyGroupsRoute(app, services);
  app.use('/api/*', accessMiddleware(services));

  registerGroupRoutes(app, services);
  registerTripRoutes(app, services);
  registerRateRoutes(app, services);
  registerExpenseRoutes(app, services);

  app.all('/api/*', (c) => c.json({ error: { code: 'not_found', message: 'That does not exist.' } }, 404));
  return app;
}
