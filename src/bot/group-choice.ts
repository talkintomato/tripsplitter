import { InlineKeyboard, type Bot, type Context } from 'grammy';
import {
  chosenGroup, listGroupsForTelegramUser, memberScope, now, rememberChosenGroup,
  type Db, type Group, type Member,
} from '../db/index.js';

export type Membership = { group: Group; member: Member };
export const privateChatKey = (ctx: Context): string => `${ctx.chat!.id}:${ctx.from!.id}`;
export const GROUP_UNAVAILABLE = 'That group is not available.';

export function groupChoiceKeyboard(groups: Membership[], data: (group: Group) => string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const { group } of groups) keyboard.text(group.title, data(group)).row();
  return keyboard;
}

/** One selection and /group handler per bot, shared by receipts and the chat agent. */
const choices = new WeakMap<Bot, ReturnType<typeof createChoice>>();
export function privateGroupChoice(bot: Bot, db: Db, isAllowedChat: (chatId: number) => boolean) {
  let choice = choices.get(bot);
  if (!choice) {
    choice = createChoice(bot, db, isAllowedChat);
    choices.set(bot, choice);
  }
  return choice;
}

function createChoice(bot: Bot, db: Db, isAllowedChat: (chatId: number) => boolean) {
  const queues = new Map<string, Promise<void>>();
  async function serial(ctx: Context, task: () => Promise<void>): Promise<void> {
    const key = privateChatKey(ctx);
    const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
    queues.set(key, run);
    try { await run; } finally { if (queues.get(key) === run) queues.delete(key); }
  }
  const memberships = (ctx: Context): Membership[] =>
    listGroupsForTelegramUser(db, ctx.from!.id).filter(m => isAllowedChat(m.group.chatId));
  const remember = (ctx: Context, who: Membership): void =>
    rememberChosenGroup(db, memberScope(who.group.id, who.member.id), ctx.chat!.id, now());
  function identify(ctx: Context): Membership | undefined {
    const groups = memberships(ctx);
    const selected = chosenGroup(db, ctx.from!.id, ctx.chat!.id);
    const who = groups.find(m => m.group.id === selected?.groupId) ?? (groups.length === 1 ? groups[0] : undefined);
    if (who) remember(ctx, who);
    return who;
  }
  const onReset: Array<(ctx: Context) => void> = [];
  const onChoose: Array<(ctx: Context, who: Membership) => Promise<void>> = [];
  bot.chatType('private').command('group', async ctx => {
    if (ctx.from?.is_bot) return;
    await serial(ctx, async () => {
      for (const reset of onReset) reset(ctx);
      const groups = memberships(ctx);
      await ctx.reply(groups.length ? 'Which group do you mean?' : 'Add me to a group, then write something there so I know you are part of it.', {
        ...(groups.length ? { reply_markup: groupChoiceKeyboard(groups, group => `ag:g:${group.id}`) } : {}),
      });
    });
  });
  bot.callbackQuery(/^ag:g:(\d{1,16})$/, async ctx => {
    if (ctx.from.is_bot || ctx.chat?.type !== 'private') return;
    await serial(ctx, async () => {
      const who = memberships(ctx).find(m => m.group.id === Number(ctx.match[1]));
      if (!who) { await ctx.answerCallbackQuery({ text: GROUP_UNAVAILABLE, show_alert: true }); return; }
      remember(ctx, who);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(`Using ${who.group.title}. Use /group to switch.`, { reply_markup: { inline_keyboard: [] } });
      for (const choose of onChoose) await choose(ctx, who);
    });
  });
  return { memberships, remember, identify, serial, onReset, onChoose };
}
