import { InlineKeyboard, type Bot, type Context } from 'grammy';
import type { Config } from '../config.js';
import type { Notifier, RateSuggester } from '../core/index.js';
import {
  appendTurn, chosenGroup, findGroupByChatId, findMemberByTelegramId, finishProposal, forgetExpiredTurns,
  getGroup, getMember, getProposal, listGroupsForTelegramUser, memberScope, now, rememberChosenGroup, systemScope,
  type Db, type Group, type Member,
} from '../db/index.js';
import { cancelProposal, confirmProposal, proposalVersions, type AgentNotice, type PlannedAction } from '../tools/index.js';
import { agentText, appKeyboard } from '../bot/chat.js';
import { runAgentTurn } from './loop.js';
import { createOpenAIAgentModel } from './openai.js';
import type { AgentModel } from './model.js';

export interface AgentHandlerDeps {
  isAllowedChat: (chatId: number) => boolean;
  notifier: Notifier;
  suggestRate: RateSuggester;
  model?: AgentModel;
}
export const AGENT_TEXT = {
  off: "I can't chat yet. Tap Add expense to use the app.",
  unavailable: "I can't do that right now. You can use the app instead.",
  limit: "I've reached today's limit. You can use the app instead.",
  noGroup: 'Add me to a group, then write something there so I know you are part of it.',
};
export const proposalCallback = (action: 'yes' | 'change' | 'cancel', id: string): string => `ag:${action}:${id}`;
const proposalPattern = /^ag:(yes|change|cancel):([a-f0-9-]{36})$/;
type Membership = { group: Group; member: Member };

/** The disabled fallback has no model and never stores a conversation. Registered after receipts. */
export function registerAgentUnavailableHandlers(bot: Bot, config: Config, db: Db, deps: Pick<AgentHandlerDeps, 'isAllowedChat'>): void {
  bot.on('message', async (ctx, next) => {
    if (agentText(ctx.message, config.botUsername, ctx.me.id) === null) return next();
    const privateChat = ctx.chat.type === 'private';
    if (!privateChat && !deps.isAllowedChat(ctx.chat.id)) return next();
    const group = privateChat ? undefined : findGroupByChatId(db, ctx.chat.id);
    await ctx.reply(AGENT_TEXT.off, { reply_parameters: { message_id: ctx.message.message_id }, reply_markup: appKeyboard(config, group, privateChat) });
  });
}

/** Group middleware and receipt handlers must precede this registration. */
export function registerAgentHandlers(bot: Bot, config: Config, db: Db, deps: AgentHandlerDeps): void {
  const model = config.agentEnabled ? deps.model ?? (config.openaiApiKey ? createOpenAIAgentModel({ apiKey: config.openaiApiKey, model: config.agentModel }) : undefined) : undefined;
  if (!model) { registerAgentUnavailableHandlers(bot, config, db, deps); return; }
  // Only unprocessed addressed messages waiting for a group choice. Purged opportunistically.
  const pending = new Map<string, { text: string; messageId: number; at: number }>();
  const queues = new Map<string, Promise<void>>();
  const keyOf = (ctx: Context) => `${ctx.chat!.id}:${ctx.from!.id}`;
  async function serial(ctx: Context, task: () => Promise<void>): Promise<void> {
    const key = keyOf(ctx);
    const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
    queues.set(key, run);
    try { await run; } finally { if (queues.get(key) === run) queues.delete(key); }
  }
  function housekeeping(): void {
    const at = now();
    forgetExpiredTurns(db, at);
    for (const [key, value] of pending) if (value.at <= at.getTime() - 30 * 60_000) pending.delete(key);
  }
  function memberships(ctx: Context): Membership[] {
    return listGroupsForTelegramUser(db, ctx.from!.id).filter(m => deps.isAllowedChat(m.group.chatId));
  }
  function identify(ctx: Context): Membership | undefined {
    if (ctx.chat!.type === 'private') {
      const groups = memberships(ctx);
      const selected = chosenGroup(db, ctx.from!.id, ctx.chat!.id);
      const who = groups.find(m => m.group.id === selected?.groupId) ?? (groups.length === 1 ? groups[0] : undefined);
      if (who) rememberChosenGroup(db, memberScope(who.group.id, who.member.id), ctx.chat!.id, now());
      return who;
    }
    const group = findGroupByChatId(db, ctx.chat!.id);
    if (!group || !deps.isAllowedChat(group.chatId)) return;
    const member = findMemberByTelegramId(db, systemScope(group.id), ctx.from!.id);
    return member && member.mergedInto === null ? { group, member } : undefined;
  }
  async function choose(ctx: Context): Promise<void> {
    const groups = memberships(ctx);
    if (!groups.length) { pending.delete(keyOf(ctx)); await ctx.reply(AGENT_TEXT.noGroup); return; }
    const keyboard = new InlineKeyboard();
    for (const { group } of groups) keyboard.text(group.title, `ag:g:${group.id}`).row();
    await ctx.reply('Which group do you mean?', { reply_markup: keyboard });
  }
  async function turn(ctx: Context, who: Membership, text: string, messageId: number): Promise<void> {
    housekeeping();
    const typing = () => ctx.api.sendChatAction(ctx.chat!.id, 'typing').catch(() => {});
    await typing();
    const timer = setInterval(() => { void typing(); }, 4000);
    timer.unref();
    try {
      const result = await runAgentTurn(db, config, { model: model!, suggestRate: deps.suggestRate }, {
        groupId: who.group.id, memberId: who.member.id, chatId: ctx.chat!.id, text, now: now(),
      });
      const reply_parameters = { message_id: messageId, allow_sending_without_reply: true };
      if (result.kind === 'proposal') {
        const keyboard = new InlineKeyboard().text(result.confirmLabel, proposalCallback('yes', result.proposalId))
          .text('Change', proposalCallback('change', result.proposalId)).text('Cancel', proposalCallback('cancel', result.proposalId));
        const chunks = messageChunks(result.summary);
        for (const [index, chunk] of chunks.entries()) await ctx.reply(chunk, { reply_parameters,
          ...(index === chunks.length - 1 ? { reply_markup: keyboard } : {}),
        });
      } else {
        for (const chunk of messageChunks(result.kind === 'reply' ? result.text : AGENT_TEXT[result.kind])) await ctx.reply(chunk, {
          reply_parameters, ...(result.kind !== 'reply' ? { reply_markup: appKeyboard(config, who.group, ctx.chat!.type === 'private') } : {}),
        });
      }
    } finally { clearInterval(timer); }
  }
  bot.chatType('private').command('group', async ctx => {
    if (ctx.from?.is_bot) return;
    await serial(ctx, async () => { housekeeping(); pending.delete(keyOf(ctx)); await choose(ctx); });
  });
  bot.callbackQuery(/^ag:g:(\d{1,16})$/, async ctx => {
    if (ctx.from.is_bot || ctx.chat?.type !== 'private') return;
    await serial(ctx, async () => {
      housekeeping();
      const who = memberships(ctx).find(m => m.group.id === Number(ctx.match[1]));
      if (!who) { await ctx.answerCallbackQuery({ text: 'That group is not available.', show_alert: true }); return; }
      rememberChosenGroup(db, memberScope(who.group.id, who.member.id), ctx.chat!.id, now());
      const request = pending.get(keyOf(ctx));
      pending.delete(keyOf(ctx));
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(`Using ${who.group.title}. Use /group to switch.`, { reply_markup: { inline_keyboard: [] } });
      if (request) await turn(ctx, who, request.text, request.messageId);
    });
  });
  bot.on('message', async (ctx, next) => {
    const text = agentText(ctx.message, config.botUsername, ctx.me.id);
    if (text === null) return next();
    if (ctx.chat.type !== 'private' && !deps.isAllowedChat(ctx.chat.id)) return next();
    await serial(ctx, async () => {
      housekeeping();
      const who = identify(ctx);
      if (!who) {
        if (ctx.chat.type === 'private') {
          pending.set(keyOf(ctx), { text, messageId: ctx.message.message_id, at: now().getTime() });
          await choose(ctx);
        }
        return;
      }
      await turn(ctx, who, text, ctx.message.message_id);
    });
  });
  bot.callbackQuery(proposalPattern, async ctx => {
    if (ctx.from.is_bot || !ctx.chat) return;
    await serial(ctx, async () => {
      housekeeping();
      const p = getProposal(db, ctx.match[2]!);
      const alert = (text: string) => ctx.answerCallbackQuery({ text, show_alert: true });
      if (!p || p.chatId !== ctx.chat!.id) { await alert('That offer does not exist.'); return; }
      const group = getGroup(db, systemScope(p.groupId));
      if (!deps.isAllowedChat(group.chatId)) { await alert('That group is not available.'); return; }
      const owner = getMember(db, systemScope(p.groupId), p.memberId);
      if (owner.telegramUserId !== ctx.from.id || owner.mergedInto !== null) { await alert(`Only ${owner.displayName} can confirm this.`); return; }
      if (p.status === 'done') { await alert('Already done.'); return; }
      if (p.status === 'cancelled') { await alert('That offer was cancelled.'); return; }
      const scope = memberScope(p.groupId, p.memberId);
      if (p.status === 'expired' || p.expiresAt <= now().toISOString()) {
        finishProposal(db, scope, p.id, 'expired');
        await alert('That offer expired. Ask me again.'); return;
      }
      if (JSON.stringify(proposalVersions(db, scope)) !== JSON.stringify(p.versions)) { await alert('This changed since I prepared it. Ask me again.'); return; }
      const action = ctx.match[1];
      const result = action === 'yes' ? confirmProposal(db, {}, { proposalId: p.id, memberId: p.memberId, now: now() })
        : cancelProposal(db, {}, { proposalId: p.id, memberId: p.memberId, now: now() });
      if (result.kind !== 'done') { await alert(result.kind === 'refused' ? result.reason : result.text); return; }
      // A failed Telegram edit must not lose the committed notices or reapply the proposal.
      await ctx.answerCallbackQuery().catch(() => {});
      if (action === 'change') {
        if (ctx.chat!.type === 'private') rememberChosenGroup(db, scope, ctx.chat!.id, now());
        appendTurn(db, scope, ctx.chat!.id, 'assistant', p.summary, now());
        await ctx.editMessageText('Ready to change.', { reply_markup: { inline_keyboard: [] } }).catch(() => {});
        await ctx.reply('What should I change?', { reply_markup: { force_reply: true, selective: true }, reply_parameters: { message_id: ('reply_to_message' in ctx.callbackQuery.message! ? ctx.callbackQuery.message.reply_to_message?.message_id : undefined) ?? ctx.callbackQuery.message!.message_id } });
        return;
      }
      const text = action === 'cancel' ? 'Cancelled.' : result.notices.length ? 'Done.' : finalLine(p.actions as PlannedAction[]);
      await ctx.editMessageText(text, { reply_markup: action === 'cancel' ? { inline_keyboard: [] } : appKeyboard(config, group, ctx.chat!.type === 'private', 'View') }).catch(() => {});
      for (const notice of result.notices) await dispatchNotice(deps.notifier, notice).catch(() => {});
    });
  });
}
function finalLine(plans: PlannedAction[]): string {
  if (plans.length !== 1) return 'Done.';
  const action = plans[0]!.action;
  switch (action.kind) {
    case 'add_member': return `Added ${JSON.stringify(action.name)}.`;
    case 'rename_trip': return `Trip renamed to ${JSON.stringify(action.name)}.`;
    case 'discard_draft': return 'Draft discarded.';
    case 'restore_expense': return 'Draft restored.';
    case 'edit_expense': case 'set_expense_rate': return 'Draft updated.';
    default: return 'Done.';
  }
}
async function dispatchNotice(notifier: Notifier, notice: AgentNotice): Promise<void> {
  // The mapped union guarantees the payload matches its method.
  return (notifier[notice.method] as (payload: AgentNotice['payload']) => Promise<void>)(notice.payload);
}

/** Preserve the entire review, with buttons only after the final chunk. Avoid splitting surrogate pairs. */
function messageChunks(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 4000) {
    const boundary = /[\uD800-\uDBFF]/.test(rest[3999]!) ? 3999 : 4000;
    chunks.push(rest.slice(0, boundary));
    rest = rest.slice(boundary);
  }
  chunks.push(rest);
  return chunks;
}
