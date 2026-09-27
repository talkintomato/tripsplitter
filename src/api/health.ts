import type { Hono } from 'hono';
import type { Db } from '../db/index.js';

export function registerHealth(app: Hono, db: Db): void {
  app.get('/health', (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      db.prepare('SELECT COUNT(*) FROM migration').get();
      return c.json({ status: 'ok', database: 'ok' });
    } catch {
      return c.json({ status: 'unavailable', database: 'unavailable' }, 503);
    }
  });
}
