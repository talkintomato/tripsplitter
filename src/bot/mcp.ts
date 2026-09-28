import { InlineKeyboard, type Bot, type Context } from 'grammy';
import type { Config } from '../config.js';
import {
  claimPairing, decidePairing, listConnections, listGroupsForTelegramUser, now, revokeConnection, type Db,
} from '../db/index.js';
import { isAllowedChat } from './support.js';

export const MCP_TEXT = {
  privateOnly: 'Send connection codes only in a private chat with me, where nobody else can see them.',
  paused: 'Too many codes that did not work. Try again in an hour.',
  unknown: 'That code does not work. Check it, or start again in the app you are connecting.',
  expired: 'That code has expired. Start again in the app you are connecting.',
  used: 'That code has already been used. Start again in the app you are connecting.',
  noCode: 'Send the code shown in the app you are connecting, like this: /connect K7QF-2M9D',
};

/**
 * Connecting an AI client (MCP). The person opens the link the client shows, which sends /start mcp_<code> here,
 * or sends /connect <code>. Only in a private chat. Register before the plain /start handler.
 */
export function registerMcpBotHandlers(bot: Bot, config: Config, db: Db): void {
  const groupsOf = (telegramUserId: number) => listGroupsForTelegramUser(db, telegramUserId).filter((m) => isAllowedChat(config, db, m.group.chatId));

  async function claim(ctx: Context, code: string): Promise<void> {
    if (ctx.chat?.type !== 'private') { await ctx.reply(MCP_TEXT.privateOnly); return; }
    if (!code.trim()) { await ctx.reply(MCP_TEXT.noCode); return; }
    const result = claimPairing(db, { code, telegramUserId: ctx.from!.id, now: now() });
    if (result.kind !== 'claimed') { await ctx.reply(MCP_TEXT[result.kind]); return; }
    const groups = groupsOf(ctx.from!.id);
    const where = groups.length === 0 ? 'You are not in any TripSplitter group yet, so it will see nothing until you are.'
      : `It will be able to read and change expenses as you, in all your groups: ${groups.map((g) => g.group.title).join(', ')}.`;
    const keyboard = new InlineKeyboard().text('Allow', `mcp:allow:${result.pairing.id}`).text('Deny', `mcp:deny:${result.pairing.id}`);
    await ctx.reply(
      `Connect ${result.pairing.clientName} to TripSplitter?\n\n${where}\n\nOnly tap Allow if you started this yourself, just now.`,
      { reply_markup: keyboard },
    );
  }

  bot.chatType('private').command('start', async (ctx, next) => {
    const payload = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (!payload.startsWith('mcp_')) return next();
    if (ctx.from?.is_bot) return;
    await claim(ctx, payload.slice(4));
  });

  bot.command('connect', async (ctx) => {
    if (ctx.from?.is_bot) return;
    await claim(ctx, typeof ctx.match === 'string' ? ctx.match : '');
  });

  bot.callbackQuery(/^mcp:(allow|deny):([a-f0-9-]{36})$/, async (ctx) => {
    if (ctx.from.is_bot || ctx.chat?.type !== 'private') return;
    const allow = ctx.match[1] === 'allow';
    const result = decidePairing(db, { pairingId: ctx.match[2]!, telegramUserId: ctx.from.id, allow, now: now() });
    const done = (text: string) => ctx.editMessageText(text, { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    await ctx.answerCallbackQuery().catch(() => undefined);
    switch (result.kind) {
      case 'approved': await done(`Connected ${result.connection.clientName}. Go back to it to finish. Send /connections to see or revoke it.`); break;
      case 'denied': await done('Not connected.'); break;
      case 'expired': await done(MCP_TEXT.expired); break;
      default: await done('That request is no longer open.'); break;
    }
  });

  bot.command('connections', async (ctx) => {
    if (ctx.from?.is_bot) return;
    if (ctx.chat.type !== 'private') { await ctx.reply('Send /connections in a private chat with me.'); return; }
    const connections = listConnections(db, ctx.from!.id);
    if (connections.length === 0) { await ctx.reply('No AI clients are connected.'); return; }
    const keyboard = new InlineKeyboard();
    for (const c of connections) keyboard.text(`Revoke ${c.clientName}`, `mcp:revoke:${c.id}`).row();
    const lines = connections.map((c) => `• ${c.clientName}, connected ${c.createdAt.slice(0, 10)}${c.lastUsedAt ? `, last used ${c.lastUsedAt.slice(0, 10)}` : ''}`);
    await ctx.reply(`Connected AI clients:\n${lines.join('\n')}`, { reply_markup: keyboard });
  });

  bot.callbackQuery(/^mcp:revoke:([a-f0-9-]{36})$/, async (ctx) => {
    if (ctx.from.is_bot || ctx.chat?.type !== 'private') return;
    const revoked = revokeConnection(db, { connectionId: ctx.match[1]!, telegramUserId: ctx.from.id, now: now() });
    await ctx.answerCallbackQuery({ text: revoked ? 'Revoked. It can no longer reach your groups.' : 'Already revoked.' }).catch(() => undefined);
    const left = listConnections(db, ctx.from.id);
    await ctx.editMessageText(left.length ? `Connected AI clients:\n${left.map((c) => `• ${c.clientName}`).join('\n')}` : 'No AI clients are connected.', {
      reply_markup: left.length ? { inline_keyboard: left.map((c) => [{ text: `Revoke ${c.clientName}`, callback_data: `mcp:revoke:${c.id}` }]) } : { inline_keyboard: [] },
    }).catch(() => undefined);
  });
}
