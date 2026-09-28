import { InlineKeyboard, type Bot, type Context } from 'grammy';
import type { Config } from '../config.js';
import {
  CURRENCIES, computeShares, convertExpense, convertToHome, isSupportedCurrency, launchUrl, toMinorUnits,
  type Notifier, type RateSuggester,
} from '../core/index.js';
import * as d from '../db/index.js';
import {
  cancelProposal, confirmProposal, createAgentProposal, displayAmount, displayDate, escapeHtml,
  proposalSummary, proposalVersions, runTool, telegramChunks,
  type AgentNotice, type PlannedAction, type Summary, type ToolContext,
} from '../tools/index.js';
import { appKeyboard } from './chat.js';
import { groupChoiceKeyboard, privateChatKey, privateGroupChoice, type Membership } from './group-choice.js';

const USAGE = 'Try: /split 24 taxi\nOr: /split 3000 JPY ramen with Sam, Ana';
const DAY_MS = 86_400_000;
const SYMBOLS: Record<string, string> = { '€': 'EUR', '£': 'GBP', '₩': 'KRW', rp: 'IDR', rm: 'MYR', 's$': 'SGD' };
type Request = { command: 'split' | 'today' | 'wrap'; args: string; messageId: number; at: number };
type ResolvedName = { query: string } & (
  { status: 'exact'; members: d.Member[] } | { status: 'unknown' | 'ambiguous'; candidates: d.Member[] }
);

/** Single dots are decimal points. Commas support both 24,50 and grouped 1,234.
 * With both separators, the last is decimal and the other must form groups of three. */
function decimalAmount(raw: string): string {
  if (raw.includes('.') && raw.includes(',')) {
    const decimal = raw.lastIndexOf('.') > raw.lastIndexOf(',') ? '.' : ',';
    const grouping = decimal === '.' ? ',' : '.';
    const [whole, fraction, extra] = raw.split(decimal);
    if (extra !== undefined || !fraction || !new RegExp(`^\\d{1,3}(?:\\${grouping}\\d{3})+$`).test(whole!)) {
      throw new RangeError('Check the amount and its thousands separators.');
    }
    return `${whole!.split(grouping).join('')}.${fraction}`;
  }
  if (/^\d{1,3}(?:,\d{3})+$/.test(raw) || /^\d{1,3}(?:\.\d{3}){2,}$/.test(raw)) return raw.replace(/[.,]/g, '');
  if ((raw.match(/[.,]/g) ?? []).length > 1) throw new RangeError('Check the amount and its thousands separators.');
  return raw.replace(',', '.');
}

function parseSplit(text: string, home: string) {
  const withAt = /\s+with(?:\s+|$)/i.exec(text);
  const names = withAt ? text.slice(withAt.index + withAt[0].length).split(',').map(n => n.trim()) : undefined;
  if (names?.some(n => !n)) throw new RangeError(USAGE);
  let body = (withAt ? text.slice(0, withAt.index) : text).trim();
  const currencies: string[] = [];
  body = body.replace(/S\$|[€£₩$¥]|\b(?:Rp|RM)(?=\s|\d|$)/gi, symbol => {
    const key = symbol.toLowerCase();
    if (key === '$' || key === '¥') {
      const matches = key === '$' ? ['SGD', 'USD', 'AUD', 'NZD'] : ['JPY', 'CNY'];
      if (!matches.includes(home)) throw new RangeError(`Which currency is ${symbol}? Use a code such as ${key === '$' ? 'USD' : 'JPY'}.`);
      currencies.push(home);
    } else currencies.push(SYMBOLS[key]!);
    return ' ';
  });
  body = body.replace(new RegExp(`\\b(${CURRENCIES.map(c => c.code).join('|')})\\b`, 'gi'), code => {
    currencies.push(code.toUpperCase()); return ' ';
  });
  if (new Set(currencies).size > 1) throw new RangeError('Use one currency for this expense.');
  const currency = currencies[0] ?? home;
  if (!isSupportedCurrency(currency)) throw new RangeError('Choose a supported currency.');
  const amounts = [...body.matchAll(/(?<![\w.,+\-])\d+(?:[.,]\d+)*(?![\w.,])/g)];
  if (amounts.length !== 1) throw new RangeError(USAGE);
  const found = amounts[0]!;
  const description = `${body.slice(0, found.index)} ${body.slice(found.index! + found[0].length)}`.replace(/\s+/g, ' ').trim();
  if (!description) throw new RangeError(USAGE);
  const capitalised = description.charAt(0).toLocaleUpperCase('en') + description.slice(1);
  if (description.length > 500) throw new RangeError('Keep the description to 500 characters.');
  const amount = decimalAmount(found[0]);
  toMinorUnits(amount, currency);
  return { amount, currency, description: capitalised, names };
}

function requestedDate(arg: string, at: Date): string {
  const today = d.singaporeDate(at);
  if (!arg) return today;
  if (arg.toLowerCase() === 'yesterday') return new Date(Date.parse(today) - DAY_MS).toISOString().slice(0, 10);
  let date = arg;
  const short = /^(\d{1,2})\s+([a-z]{3,4})$/i.exec(arg);
  if (short) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(short[2]!.toLowerCase().replace('sept', 'sep')) + 1;
    date = `${today.slice(0, 4)}-${String(month).padStart(2, '0')}-${short[1]!.padStart(2, '0')}`;
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new RangeError('Try: /today, /today yesterday, or /today 25 Sep');
  }
  return date;
}

/** Exactly the foundation conversion used by the app views, including remainder allocation. */
function expenseAmounts(expense: d.ExpenseDetail, trip: d.Trip) {
  return convertExpense(expense, computeShares(expense, expense.items, expense.shares), trip.homeCurrency);
}
const add = (map: Map<number, bigint>, id: number, amount: bigint) => map.set(id, (map.get(id) ?? 0n) + amount);
const most = (map: Map<number, bigint>) => [...map].sort(([a, av], [b, bv]) => av === bv ? a - b : av > bv ? -1 : 1)[0];
const memberLabel = (db: d.Db, scope: d.Scope, id: number) => scope.actor.kind === 'member' && scope.actor.memberId === id ? 'you' : d.getMember(db, scope, id).displayName;

function todaySummary(db: d.Db, scope: d.Scope, trip: d.Trip | undefined, date: string, at: Date): Summary {
  const isToday = date === d.singaporeDate(at);
  const summary: Summary = { icon: '', title: isToday ? 'Today' : displayDate(date, at), blocks: [] };
  const expenses = trip ? d.listExpenses(db, scope, trip.id, { status: 'confirmed' }).filter(e => e.expenseDate === date) : [];
  const payments = trip ? d.listSettlements(db, scope, trip.id, { status: 'active' }).filter(p => d.singaporeDate(new Date(p.createdAt)) === date) : [];
  const drafts = trip ? d.listExpenses(db, scope, trip.id, { status: 'draft' }).filter(e => e.expenseDate === date).length : 0;
  const name = (id: number) => memberLabel(db, scope, id);
  if (!expenses.length && !payments.length) summary.blocks.push({ lines: [`Nothing recorded ${isToday ? 'today' : `on ${displayDate(date, at)}`}.`] });
  if (trip && (expenses.length || payments.length)) {
    let total = 0n;
    const paid = new Map<number, bigint>();
    const lines: Summary['blocks'][number]['lines'] = [];
    for (const [index, e] of expenses.entries()) {
      const converted = expenseAmounts(e, trip);
      total += converted.total;
      add(paid, e.payerId, converted.total);
      if (index < 15) lines.push({ bullet: `${e.description || e.merchant || 'Expense'} · ${displayAmount(e.total, e.currency)}${e.currency !== trip.homeCurrency ? ` (≈ ${displayAmount(converted.total, trip.homeCurrency)})` : ''} · paid by ${name(e.payerId)}` });
    }
    if (expenses.length > 15) lines.push(`and ${expenses.length - 15} more`);
    if (lines.length) summary.blocks.push({ lines });
    const top = most(paid);
    summary.blocks.push({ lines: [
      `Total: ${displayAmount(total, trip.homeCurrency)}`,
      ...(top ? [`Spent most: ${name(top[0])}, ${displayAmount(top[1], trip.homeCurrency)}`] : []),
    ] });
    if (payments.length) summary.blocks.push({ heading: 'Payments', lines: payments.map(p => ({ bullet: `${name(p.fromMemberId)} paid ${name(p.toMemberId)} ${displayAmount(p.amount, trip.homeCurrency)}` })) });
  }
  if (drafts) summary.blocks.push({ lines: [`${drafts} ${drafts === 1 ? 'draft' : 'drafts'} waiting for approval`] });
  return summary;
}

function wrapSummary(db: d.Db, scope: d.Scope, trip: d.Trip): Summary {
  const expenses = d.listExpenses(db, scope, trip.id, { status: 'confirmed' });
  const name = (id: number) => memberLabel(db, scope, id);
  const money = (amount: bigint | number) => displayAmount(amount, trip.homeCurrency);
  let total = 0n;
  const paid = new Map<number, bigint>(), shares = new Map<number, bigint>();
  let biggest: { expense: d.ExpenseDetail; total: bigint } | undefined;
  for (const expense of expenses) {
    const converted = expenseAmounts(expense, trip);
    total += converted.total;
    add(paid, expense.payerId, converted.total);
    for (const [id, amount] of converted.shares) add(shares, id, amount);
    if (!biggest || converted.total > biggest.total) biggest = { expense, total: converted.total };
  }
  const dates = expenses.map(e => e.expenseDate).sort();
  const first = dates[0], last = dates.at(-1);
  const days = first && last ? (Date.parse(last) - Date.parse(first)) / DAY_MS + 1 : 0;
  const shortDate = (date: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', ...(first?.slice(0, 4) !== last?.slice(0, 4) ? { year: 'numeric' as const } : {}) }).format(new Date(date)).replace('Sept', 'Sep');
  // Foundation half-up division: identical currencies cancel their minor-unit factors.
  const perDay = days ? convertToHome(total, String(days), trip.homeCurrency, trip.homeCurrency, 'half-up') : 0n;
  const summary: Summary = { icon: '🏁', title: trip.name, blocks: [{ lines: [
    ...(first && last ? [`${first === last ? shortDate(first) : `${shortDate(first)} – ${shortDate(last)}`} · ${days} ${days === 1 ? 'day' : 'days'}`] : ['No expenses yet.']),
    `Total spent: ${money(total)}`, `Per day: ${money(perDay)}`, `Expenses: ${expenses.length}`,
  ] }] };
  const top = most(paid);
  if (biggest && top) summary.blocks.push({ lines: [
    `Biggest expense: ${biggest.expense.description || biggest.expense.merchant || 'Expense'} · ${money(biggest.total)}, paid by ${name(biggest.expense.payerId)}`,
    `Paid the most: ${name(top[0])}, ${money(top[1])}`,
  ] });
  if (shares.size) summary.blocks.push({ heading: "Each person's share", lines: [...shares].sort(([a], [b]) => a - b).map(([id, amount]) => ({ bullet: `${name(id)}: ${money(amount)}` })) });
  const { payments } = d.getTripBalances(db, scope, trip.id);
  summary.blocks.push(payments.length ? { heading: 'To settle up', lines: payments.map(p => ({ bullet: `${name(p.fromMemberId)} ${name(p.fromMemberId) === 'you' ? 'pay' : 'pays'} ${name(p.toMemberId)} ${money(p.amount)}` })) } : { lines: ['Everyone is settled up. 🎉'] });
  return summary;
}

export function registerCommands(bot: Bot, config: Config, db: d.Db, deps: {
  notifier: Notifier; suggestRate: RateSuggester; isAllowedChat: (chatId: number) => boolean;
}): void {
  const selection = privateGroupChoice(bot, db, deps.isAllowedChat);
  const pending = new Map<string, Request>();
  function prune() { for (const [key, request] of pending) if (request.at <= d.now().getTime() - 30 * 60_000) pending.delete(key); }
  async function post(ctx: Context, summary: Summary, keyboard: InlineKeyboard, messageId?: number) {
    const chunks = telegramChunks(summary);
    for (const [index, chunk] of chunks.entries()) await ctx.reply(chunk, { parse_mode: 'HTML',
      ...(messageId ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } : {}),
      ...(index === chunks.length - 1 ? { reply_markup: keyboard } : {}),
    });
  }
  async function execute(ctx: Context, who: Membership, request: Request) {
    const scope = d.memberScope(who.group.id, who.member.id);
    const context: ToolContext = { db, scope, now: d.now(), suggestRate: deps.suggestRate, personalNames: true };
    try {
      if (request.command === 'split') {
        const home = d.getActiveTrip(db, scope)?.homeCurrency ?? d.listTrips(db, scope)[0]?.homeCurrency ?? 'SGD';
        const parsed = parseSplit(request.args, home);
        let people = [{ name: 'everyone' }];
        if (parsed.names) {
          const resolved = await runTool(context, 'resolve_members', { names: parsed.names });
          if (resolved.kind !== 'read') throw new Error('Expected member lookup');
          const results = resolved.data as ResolvedName[];
          const uncertain = results.find(r => r.status !== 'exact');
          if (uncertain) {
            await post(ctx, { icon: '', title: 'Choose a person', blocks: [{ lines: [
              `Which person do you mean by ${uncertain.query}?`,
              `Members: ${uncertain.candidates.map(m => `${m.id === who.member.id ? 'you' : m.displayName}${m.username ? ` (@${m.username})` : ''}`).join(', ')}`,
            ] }] }, new InlineKeyboard());
            return;
          }
          const seen = new Set([who.member.id]);
          people = [{ name: 'me' }];
          for (const result of results) if (result.status === 'exact') {
            // Expand everyone once; retain exact user queries so duplicate display names can use @username.
            if (result.members.length > 1) { people = [{ name: 'everyone' }]; break; }
            const member = result.members[0]!;
            if (!seen.has(member.id)) { people.push({ name: result.query }); seen.add(member.id); }
          }
        }
        // Explicit creation goes through the tools; a read-only recap never creates a trip.
        await runTool({ ...context, startTripIfMissing: true }, 'get_trip', {});
        const versions = proposalVersions(db, scope);
        const result = await runTool(context, 'add_expense', {
          description: parsed.description, amount: parsed.amount, currency: parsed.currency,
          payer: 'me', people, splitType: 'even', date: d.singaporeDate(context.now),
        });
        if (result.kind !== 'proposal') throw new Error('Expected expense proposal');
        const proposal = createAgentProposal(db, scope, { chatId: ctx.chat!.id, plans: result.plans, versions, now: context.now, personalNames: true });
        const keyboard = new InlineKeyboard().text('Approve', `cmd:yes:${proposal.id}`).text('Change', `cmd:change:${proposal.id}`).text('Cancel', `cmd:cancel:${proposal.id}`);
        await post(ctx, proposalSummary(proposal.actions as PlannedAction[]), keyboard, request.messageId);
      } else {
        const trip = d.getActiveTrip(db, scope) ?? (request.command === 'wrap' ? d.listTrips(db, scope, { status: 'ended' }).sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? '') || b.id - a.id)[0] : undefined);
        const summary = request.command === 'today' ? todaySummary(db, scope, trip, requestedDate(request.args, context.now), context.now)
          : trip ? wrapSummary(db, scope, trip) : { icon: '🏁', title: who.group.title, blocks: [{ lines: ['No trip to recap yet.'] }] };
        const keyboard = new InlineKeyboard().url(request.command === 'today' ? 'View in app' : 'Settle up in app', launchUrl(config, {
          groupId: who.group.id, linkVersion: who.group.linkVersion, view: request.command === 'today' ? 'home' : 'balances',
        }));
        await post(ctx, summary, keyboard, request.messageId);
      }
    } catch (error) {
      const text = error instanceof d.DomainError || error instanceof RangeError ? error.message : 'That request could not be prepared. Check the command and try again.';
      for (const chunk of telegramChunks({ icon: '', title: '', blocks: [{ lines: [text] }] })) await ctx.reply(chunk, { parse_mode: 'HTML' });
    }
  }
  selection.onReset.push(ctx => { prune(); pending.delete(privateChatKey(ctx)); });
  selection.onChoose.push(async (ctx, who) => {
    prune();
    const request = pending.get(privateChatKey(ctx));
    pending.delete(privateChatKey(ctx));
    if (request) await execute(ctx, who, request);
  });
  // Match command text ourselves to support case-insensitive commands and Telegram's username suffix.
  bot.on('message:text', async (ctx, next) => {
    const match = /^\/(split|today|wrap)(?:@([\w]+))?(?:\s+([\s\S]*))?$/i.exec(ctx.message.text);
    if (!match || (match[2] && match[2].toLowerCase() !== config.botUsername.toLowerCase())) return next();
    if (!ctx.from || ctx.from.is_bot || ctx.message.sender_chat || !['private', 'group', 'supergroup'].includes(ctx.chat.type)) return;
    await selection.serial(ctx, async () => {
      prune();
      const request: Request = { command: match[1]!.toLowerCase() as Request['command'], args: (match[3] ?? '').trim(), messageId: ctx.message.message_id, at: d.now().getTime() };
      let who: Membership | undefined;
      if (ctx.chat.type === 'private') who = selection.identify(ctx);
      else {
        const group = d.findGroupByChatId(db, ctx.chat.id);
        const member = group && d.findMemberByTelegramId(db, d.systemScope(group.id), ctx.from.id);
        if (group && member && member.mergedInto === null && deps.isAllowedChat(group.chatId)) who = { group, member };
      }
      if (who) { pending.delete(privateChatKey(ctx)); await execute(ctx, who, request); }
      else if (ctx.chat.type === 'private') {
        const groups = selection.memberships(ctx);
        if (groups.length) {
          pending.set(privateChatKey(ctx), request);
          await ctx.reply('Which group do you mean?', { reply_markup: groupChoiceKeyboard(groups, group => `ag:g:${group.id}`) });
        } else await ctx.reply('Add me to a group, then write something there so I know you are part of it.');
      }
    });
  });
  bot.callbackQuery(/^cmd:(yes|change|cancel):([a-f0-9-]{36})$/, async ctx => {
    if (ctx.from.is_bot || !ctx.chat) return;
    await selection.serial(ctx, async () => {
      const p = d.getProposal(db, ctx.match[2]!);
      const alert = (text: string) => ctx.answerCallbackQuery({ text, show_alert: true });
      if (!p || p.chatId !== ctx.chat!.id) { await alert('That offer does not exist.'); return; }
      const scope = d.memberScope(p.groupId, p.memberId);
      const group = d.getGroup(db, scope), owner = d.getMember(db, scope, p.memberId);
      if (!deps.isAllowedChat(group.chatId)) { await alert('That group is not available.'); return; }
      if (owner.telegramUserId !== ctx.from.id || owner.mergedInto !== null) { await alert(`Only ${owner.displayName} can confirm this.`); return; }
      if (p.status === 'done') { await alert('Already done.'); return; }
      if (p.status === 'cancelled') { await alert('That offer was cancelled.'); return; }
      if (p.status === 'expired' || p.expiresAt <= d.now().toISOString()) {
        d.finishProposal(db, scope, p.id, 'expired'); await alert('That offer expired. Ask me again.'); return;
      }
      if (JSON.stringify(proposalVersions(db, scope)) !== JSON.stringify(p.versions)) { await alert('This changed since I prepared it. Ask me again.'); return; }
      const action = ctx.match[1];
      const result = (action === 'yes' ? confirmProposal : cancelProposal)(db, {}, { proposalId: p.id, memberId: p.memberId, now: d.now() });
      if (result.kind !== 'done') { await alert(result.kind === 'refused' ? result.reason : result.text); return; }
      await ctx.answerCallbackQuery().catch(() => {});
      const plans = p.actions as PlannedAction[];
      const expense = plans.find(plan => plan.action.kind === 'add_expense')?.action;
      const text = action === 'yes' ? (plans.length === 1 && expense?.kind === 'add_expense' ? `✅ Added ${expense.input.description || expense.input.merchant || 'Expense'} · ${displayAmount(expense.input.total, expense.input.currency!)}` : `✅ Completed ${plans.length} changes`)
        : action === 'change' ? 'Ready to change.' : 'Cancelled.';
      await ctx.editMessageText(escapeHtml(text), { parse_mode: 'HTML', reply_markup: action === 'yes' ? appKeyboard(config, group, ctx.chat!.type === 'private', 'View') : { inline_keyboard: [] } }).catch(() => {});
      for (const notice of result.notices) await (deps.notifier[notice.method] as (payload: AgentNotice['payload']) => Promise<void>)(notice.payload).catch(() => {});
      if (action === 'change') await ctx.reply(`Send /split again with the changes, or tell me what to change: @${config.botUsername} …`);
    });
  });
}
