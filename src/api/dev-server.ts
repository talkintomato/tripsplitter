// A local server for working on the Mini App without Telegram. Development only.
//
//   pnpm web:build
//   DATABASE_PATH=./data/dev.db pnpm tsx src/api/dev-server.ts
//
// It serves the API and the built Mini App on PORT (default 3000), signs every request in as DEV_FAKE_USER,
// creates a group to play with when the database has none, and prints the address to open.
// The real entry point, with the bot, is src/main.ts (PRD 5).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { loadConfig, type Config } from '../config.js';
import { encodeLaunch, type Notifier, type RateSuggester } from '../core/index.js';
import { ensureGroup, openDatabase, type Db } from '../db/index.js';
import { createApi } from './index.js';
import { registerHealth } from './health.js';

const DEV_CHAT_ID = -1000000000001;

const DEV_DEFAULTS: Record<string, string> = {
  BOT_TOKEN: '000000:DEV-ONLY',
  BOT_USERNAME: 'tripsplitter_dev_bot',
  MINI_APP_NAME: 'app',
  LINK_SECRET: 'dev-only-link-secret-0123456789abcdef',
  DEV_FAKE_USER: '{"id":1,"first_name":"Dev"}',
  DATABASE_PATH: './data/dev.db',
};

/** Prints each notice instead of posting it to a chat. */
export function createConsoleNotifier(log: (line: string) => void = console.log): Notifier {
  const print = (name: string) => async (notice: object) => {
    log(`[notice] ${name} ${JSON.stringify(notice, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))}`);
  };
  return {
    expenseSaved: print('expenseSaved'),
    expenseEdited: print('expenseEdited'),
    expenseDeleted: print('expenseDeleted'),
    expenseRestored: print('expenseRestored'),
    settlementRecorded: print('settlementRecorded'),
    settlementUndone: print('settlementUndone'),
    settlementRestored: print('settlementRestored'),
    tripRateChanged: print('tripRateChanged'),
    tripEnded: print('tripEnded'),
    tripReopened: print('tripReopened'),
    linkReset: print('linkReset'),
    memberJoinedByLink: print('memberJoinedByLink'),
  };
}

// Rough values of 1 USD, good enough to try the screens. Not real rates.
const DEV_PER_USD: Record<string, number> = {
  USD: 1, SGD: 1.3, MYR: 4.4, THB: 34, CNY: 7.1, GBP: 0.76, AUD: 1.5, NZD: 1.65, IDR: 16000, JPY: 146, KRW: 1350,
};

/** Made-up rates. Set DEV_NO_RATES=1 to see what happens when the lookup finds nothing. */
export const devRateSuggester: RateSuggester = async (from, to) => {
  if (process.env.DEV_NO_RATES === '1') return null;
  const a = DEV_PER_USD[from];
  const b = DEV_PER_USD[to];
  if (!a || !b) return null;
  return String(Number((b / a).toFixed(6)));
};

export function loadDevConfig(env: Record<string, string | undefined> = process.env): Config {
  const given = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''));
  const config = loadConfig({ ...DEV_DEFAULTS, ...given, NODE_ENV: given.NODE_ENV ?? 'development' });
  if (config.nodeEnv !== 'development') throw new Error('The dev server only runs with NODE_ENV=development.');
  return config;
}

/** The start parameter of the group to play with, which is created when the database has none. */
export function devLaunch(config: Config, db: Db): string {
  const user = config.devFakeUser ?? { id: 1, firstName: 'Dev' };
  const { group } = ensureGroup(db, DEV_CHAT_ID, 'Dev trip', [
    { telegramUserId: user.id, displayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Dev', username: user.username ?? null },
    { telegramUserId: user.id + 1000001, displayName: 'Sam' },
    { telegramUserId: user.id + 1000002, displayName: 'Priya' },
  ]);
  return encodeLaunch({ groupId: group.id, linkVersion: group.linkVersion, view: 'home' }, config.linkSecret);
}

export function createDevApp(config: Config, db: Db, webRoot = resolve('web/dist')): Hono {
  const app = new Hono();
  registerHealth(app, db);
  app.get('/dev/launch', (c) => {
    const launch = devLaunch(config, db);
    return c.json({ launch, url: `http://localhost:${config.port}/?startapp=${launch}` });
  });
  app.route('/', createApi(config, db, { notifier: createConsoleNotifier(), suggestRate: devRateSuggester }));
  if (existsSync(webRoot)) {
    app.use('/*', serveStatic({ root: webRoot }));
    app.get('/*', serveStatic({ root: webRoot, path: 'index.html' }));
  } else {
    app.get('/', (c) => c.text('The Mini App is not built. Run: pnpm web:build', 503));
  }
  return app;
}

export function startDevServer(env: Record<string, string | undefined> = process.env): { close: () => void; config: Config } {
  const config = loadDevConfig(env);
  const db = openDatabase(config.databasePath);
  const launch = devLaunch(config, db);
  const server = serve({ fetch: createDevApp(config, db).fetch, port: config.port }, () => {
    console.log(`TripSplitter dev server, signed in as ${config.devFakeUser?.firstName ?? 'nobody'}`);
    console.log(`Open http://localhost:${config.port}/?startapp=${launch}`);
  });
  return {
    config,
    close: () => {
      server.close();
      db.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDevServer();
}
