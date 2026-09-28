import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { Hono } from 'hono';
import { createApi, type ApiDeps } from './api/index.js';
import { createMcpApp } from './mcp/http.js';
import { createDevApp, devLaunch } from './api/dev-server.js';
import { registerHealth } from './api/health.js';
import { ALLOWED_UPDATES, createBot } from './bot/index.js';
import { loadConfig, type Config } from './config.js';
import { openDatabase, type Db } from './db/index.js';
import { createRateSuggester } from './fx/index.js';
import { registerAgentHandlers, registerAgentUnavailableHandlers } from './agent/handlers.js';
import { registerReceiptHandlers } from './receipts/index.js';

/** Assembles HTTP without opening a port or contacting Telegram. */
export function createHttpApp(config: Config, db: Db, deps: ApiDeps, bot: Bot, webRoot = resolve('web/dist')): Hono {
  const app = new Hono();
  registerHealth(app, db);
  if (config.webhookUrl && config.webhookSecret) {
    const secret = Buffer.from(config.webhookSecret);
    app.post(`/telegram/${config.webhookSecret}`, async (c) => {
      const header = Buffer.from(c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '');
      if (header.length !== secret.length || !timingSafeEqual(header, secret)) return c.json({ error: 'Unauthorized' }, 401);
      let update: Update;
      try {
        update = await c.req.json<Update>();
        if (!update || !Number.isSafeInteger(update.update_id)) return c.json({ error: 'Invalid update' }, 400);
      } catch {
        return c.json({ error: 'Invalid update' }, 400);
      }
      console.log(`Telegram update: ${describeUpdate(update, config.botUsername)}`);
      try {
        await bot.handleUpdate(update);
        return c.json({ ok: true });
      } catch (error) {
        // Do not log update bodies or Telegram request URLs (which contain the token).
        const reason = error instanceof Error ? `${error.name}: ${error.message}`.replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '<token>').slice(0, 300) : 'unknown';
        console.error(`Telegram webhook update failed. ${reason}`);
        return c.json({ error: 'Update failed' }, 500);
      }
    });
  }
  app.all('/telegram/*', (c) => c.notFound());
  if (config.mcpEnabled) app.route('/', createMcpApp({ db, config, suggestRate: deps.suggestRate, notifier: deps.notifier }));
  app.route('/', createApi(config, db, deps));
  app.use('/*', serveStatic({ root: webRoot }));
  app.get('/*', serveStatic({ root: webRoot, path: 'index.html' }));
  return app;
}

export async function startApp(config = loadConfig()): Promise<{ close(): Promise<void> }> {
  const db = openDatabase(config.databasePath);
  const { bot, notifier, isAllowedChat } = createBot(config, db);
  const suggestRate = createRateSuggester(config);
  registerReceiptHandlers(bot, config, db, { notifier, isAllowedChat, suggestRate });
  if (config.agentEnabled) registerAgentHandlers(bot, config, db, { notifier, isAllowedChat, suggestRate });
  else registerAgentUnavailableHandlers(bot, config, db, { isAllowedChat });
  bot.catch(() => console.error('Telegram update failed.'));

  // Explicit development sign-in uses the existing offline fixtures, with no external calls.
  const offline = config.nodeEnv === 'development' && config.devFakeUser !== undefined;
  const app = offline ? createDevApp(config, db) : createHttpApp(config, db, { notifier, suggestRate }, bot);
  try {
    if (!offline && config.webhookUrl) {
      await bot.init();
      await bot.api.setWebhook(new URL(`/telegram/${config.webhookSecret}`, config.webhookUrl).href, {
        secret_token: config.webhookSecret!, allowed_updates: [...ALLOWED_UPDATES],
      });
    } else if (!offline) {
      await bot.api.deleteWebhook();
    }
  } catch {
    db.close();
    throw new Error('Could not start Telegram. Check the bot settings and connection.');
  }

  const server = serve({ fetch: app.fetch, port: config.port }, () => {
    console.log(`TripSplitter listening on port ${config.port}`);
    if (offline) console.log(`Open http://localhost:${config.port}/?startapp=${devLaunch(config, db)}`);
  });
  let polling: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      const httpClosed = new Promise<void>((done) => server.close(() => done()));
      if (bot.isRunning()) await bot.stop();
      await polling;
      await httpClosed;
      db.close();
    })();
    return closing;
  };
  const onSignal = (): void => { void close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  server.on('error', () => {
    console.error('HTTP server failed. Check PORT and whether it is already in use.');
    process.exitCode = 1;
    void close();
  });
  if (!offline && !config.webhookUrl) {
    polling = bot.start({ allowed_updates: [...ALLOWED_UPDATES] }).catch(() => {
      console.error('Telegram polling stopped unexpectedly.');
      process.exitCode = 1;
      // Queue shutdown after this promise settles, so close can await it.
      queueMicrotask(() => { void close(); });
    });
  }
  return { close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startApp().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Startup failed.');
    process.exitCode = 1;
  });
}

/**
 * One line describing an update for the log: its kind, the chat type, what the message holds and whether it
 * mentions the bot. Never any text, caption, name or id, so nothing a person wrote reaches the log.
 */
export function describeUpdate(update: Update, botUsername: string): string {
  const kind = Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown';
  const message = update.message ?? update.edited_message ?? update.channel_post;
  if (!message) return kind;
  const parts = [kind, message.chat.type];
  if (message.photo) parts.push('photo');
  if (message.document) parts.push(`document ${message.document.mime_type ?? ''}`.trim());
  if (message.text !== undefined) parts.push(message.text.startsWith('/') ? 'command' : 'text');
  if (message.reply_to_message) parts.push(message.reply_to_message.photo ? 'reply to photo' : 'reply');
  const said = `${message.text ?? ''} ${message.caption ?? ''}`.toLowerCase();
  parts.push(said.includes(`@${botUsername.toLowerCase()}`) ? 'mentions bot' : 'no mention');
  if (message.from?.is_bot) parts.push('from a bot');
  return parts.join(', ');
}
