import { Bot, InlineKeyboard } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Config } from '../config.js';
import type { Notifier } from '../core/index.js';
import { findGroupByChatId, type Db } from '../db/index.js';
import { appKeyboard, helpText } from './chat.js';
import { groupMiddleware } from './middleware.js';
import { registerMcpBotHandlers } from './mcp.js';
import { createNotifier } from './notifier.js';
import { consoleLogger, isAllowedChat, type BotLogger } from './support.js';

export { isAllowedChat, type BotLogger } from './support.js';
export { introKeyboard, introText } from './intro.js';
export { REFUSAL_INTERVAL_MS } from './middleware.js';

export interface CreateBotOptions {
  /** The bot's own account. Without it grammY asks Telegram when the bot is started. Tests pass it. */
  botInfo?: UserFromGetMe;
  /** Where errors go. `console` by default. */
  logger?: BotLogger;
}

export interface CreatedBot {
  /** Not started. PRD 5 starts it, after the receipt handlers are registered. */
  bot: Bot;
  /** The rule of step 1, for the receipt handlers. */
  isAllowedChat: (chatId: number) => boolean;
  notifier: Notifier;
}

/**
 * Update kinds the bot needs. `chat_member` is not sent by Telegram unless it is asked for, so pass this list
 * to `bot.start({ allowed_updates })` or to `setWebhook`.
 */
export const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'my_chat_member', 'chat_member'] as const;

export function createBot(config: Config, db: Db, options: CreateBotOptions = {}): CreatedBot {
  const logger = options.logger ?? consoleLogger;
  const bot = new Bot(config.botToken, options.botInfo !== undefined ? { botInfo: options.botInfo } : {});
  bot.use(groupMiddleware({ api: bot.api, config, db, logger }));
  bot.command('help', async ctx => {
    if (ctx.from?.is_bot) return;
    await ctx.reply(helpText(config), { reply_parameters: { message_id: ctx.msg.message_id }, reply_markup: appKeyboard(config, findGroupByChatId(db, ctx.chat.id), ctx.chat.type === 'private') });
  });
  // Connecting an AI client uses /start mcp_<code>, so it must come before the plain /start.
  if (config.mcpEnabled) registerMcpBotHandlers(bot, config, db);
  bot.chatType('private').command('start', async (ctx) => {
    if (config.webhookUrl) {
      await ctx.reply('Send me a photo of a receipt. Open Trip Split to see your groups.', {
        reply_markup: new InlineKeyboard().webApp('Open Trip Split', config.webhookUrl),
      });
    } else {
      await ctx.reply("Send me a photo of a receipt. Open Trip Split from your group's pinned message.");
    }
  });
  return {
    bot,
    isAllowedChat: (chatId) => isAllowedChat(config, db, chatId),
    notifier: createNotifier(bot.api, config, db, logger),
  };
}
