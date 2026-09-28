import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update, User } from 'grammy/types';
import { buildConfig } from '../../src/config.js';
import { createBot } from '../../src/bot/index.js';
import { registerAgentHandlers } from '../../src/agent/handlers.js';
import { registerReceiptHandlers } from '../../src/receipts/index.js';
import { decodeLaunch } from '../../src/core/index.js';
import * as d from '../../src/db/index.js';
import { proposalSummary, telegramChunks, type PlannedAction } from '../../src/tools/index.js';
import { fakeTelegram, BOT_INFO, messageUpdate, type Call } from './helpers.js';
import { fakeNotifier, reading } from '../receipts/harness.js';

const CHAT = -5001;
const BOT = 'trip_splitting_bot';
const ME: User = { id: 101, is_bot: false, first_name: 'Darin', username: 'darin' };
const SAM: User = { id: 102, is_bot: false, first_name: 'Sam', username: 'sam' };
const ANA: User = { id: 103, is_bot: false, first_name: 'Ana', username: 'ana' };
const NOW = new Date('2026-09-28T16:30:00Z'); // Already 29 September in Singapore.
const USAGE = 'Try: /split 24 taxi\nOr: /split 3000 JPY ramen with Sam, Ana';

function buildHarness(options: { groups?: number; ai?: boolean; home?: string } = {}) {
  const db = d.openDatabase(':memory:');
  const config = buildConfig({ botUsername: BOT, agentEnabled: options.ai ?? true, agentDailyCap: 0 });
  const groups = Array.from({ length: options.groups ?? 1 }, (_, i) => {
    const group = d.ensureGroup(db, CHAT - i, `Trip ${i}`, [ME, SAM, ANA].map(u => ({ telegramUserId: u.id, displayName: u.first_name, username: u.username })));
    d.setIntroMessage(db, d.systemScope(group.group.id), 400);
    if (options.home) d.changeHomeCurrency(db, d.memberScope(group.group.id, group.members[0]!.id), group.trip!.id, options.home);
    return group;
  });
  const suggestRate = vi.fn(async () => '112.4' as string | null);
  const errors = vi.fn();
  const created = createBot(config, db, { botInfo: { ...BOT_INFO, username: BOT }, suggestRate, logger: { error: errors } });
  const calls: Call[] = [], failing = new Set<string>();
  fakeTelegram(created.bot, { calls, failing, administrators: [] });
  const model = { respond: vi.fn(async (): Promise<never> => { throw new Error('Commands must not call the model'); }) };
  const notifier = fakeNotifier();
  const readReceipt = vi.fn(async () => reading());
  registerReceiptHandlers(created.bot, config, db, { ...created, suggestRate, notifier, readReceipt, downloadPhoto: async () => new Uint8Array([1]), logError: () => {} });
  registerAgentHandlers(created.bot, config, db, { ...created, suggestRate, notifier, model });
  const passed = vi.fn();
  created.bot.use(ctx => { passed(ctx.update); });
  const chat = (id: number) => id > 0 ? { id, type: 'private', first_name: ME.first_name } : { id, type: 'group', title: `Trip ${CHAT - id}` };
  async function send(text: string, chatId = CHAT, from = ME, extra: Record<string, unknown> = {}) {
    const update = messageUpdate(chatId, from, { text, chat: chat(chatId), entities: [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0]!.length }], ...extra });
    await created.bot.handleUpdate(update);
    return update.message!.message_id;
  }
  async function tap(data: string, from = ME, chatId = CHAT) {
    await created.bot.handleUpdate({ update_id: 500, callback_query: { id: 'cb', from, chat_instance: 'test', data, message: { message_id: 999, date: 1, chat: chat(chatId), from: { ...BOT_INFO, username: BOT }, text: 'Proposal' } } } as unknown as Update);
  }
  const sent = (method = 'sendMessage') => calls.filter(c => c.method === method).map(c => c.payload);
  const text = () => String(sent().at(-1)?.text);
  const buttons = () => ((sent().at(-1)?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> })?.inline_keyboard ?? []).flat();
  const data = (label: string) => buttons().find(b => b.text === label)!.callback_data!;
  const proposals = () => (db.prepare('SELECT id FROM agent_proposal ORDER BY rowid').all() as { id: string }[]).map(p => d.getProposal(db, p.id)!);
  const scope = groups[0] ? d.memberScope(groups[0].group.id, groups[0].members[0]!.id) : undefined!;
  const h = { ...created, db, config, groups, scope, suggestRate, model, errors, calls, failing, send, tap, sent, text, buttons, data, proposals, readReceipt, passed };
  return h;
}
type Harness = ReturnType<typeof buildHarness>;
const opened: Harness[] = [];
function make(options: Parameters<typeof buildHarness>[0] = {}): Harness {
  const h = buildHarness(options);
  opened.push(h);
  return h;
}
const expense = (h: Harness, extra: Partial<d.CreateExpenseInput> = {}) => d.createExpense(h.db, h.scope, {
  tripId: h.groups[0]!.trip!.id, payerId: h.groups[0]!.members[1]!.id, description: 'Taxi', expenseDate: '2026-09-29',
  total: 2400, currency: 'SGD', splitType: 'even', shares: h.groups[0]!.members.map(m => ({ memberId: m.id })), status: 'confirmed', ...extra,
});
const plan = (h: Harness) => (h.proposals().at(-1)!.actions as PlannedAction[]).find(p => p.action.kind === 'add_expense')!.action;
const launch = (h: Harness) => decodeLaunch(new URL(h.buttons()[0]!.url!).searchParams.get('startapp')!, h.config.linkSecret);
beforeEach(() => {
  d.setClockForTests(() => NOW);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No network in command tests'); }));
});
afterEach(() => {
  for (const h of opened.splice(0)) {
    try {
      expect(h.model.respond).not.toHaveBeenCalled();
      expect(h.db.prepare('SELECT * FROM agent_usage').all()).toEqual([]);
      expect(h.db.prepare("SELECT * FROM agent_turn WHERE role != 'chosen_group'").all()).toEqual([]);
      expect(h.errors).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  }
  d.setClockForTests(null);
  vi.unstubAllGlobals();
});

describe('/split', () => {
  it.each([
    ['/split 24 taxi', 2400, 'SGD', 'Taxi'],
    ['/split taxi 24', 2400, 'SGD', 'Taxi'],
    ['/split 24.50 SGD dinner', 2450, 'SGD', 'Dinner'],
    ['/split 3000 jpy ramen', 3000, 'JPY', 'Ramen'],
    ['/split dinner €42', 4200, 'EUR', 'Dinner'],
    ['/split@trip_splitting_bot 24 taxi', 2400, 'SGD', 'Taxi'],
    ['/SPLIT@TRIP_SPLITTING_BOT taxi 24,50', 2450, 'SGD', 'Taxi'],
    ['/split 1,234.56 taxi', 123456, 'SGD', 'Taxi'],
    ['/split taxi 1.234,56', 123456, 'SGD', 'Taxi'],
    ['/split taxi 3,000 JPY', 3000, 'JPY', 'Taxi'],
    ['/split taxi £42', 4200, 'GBP', 'Taxi'],
    ['/split taxi ₩3000', 3000, 'KRW', 'Taxi'],
    ['/split taxi Rp3000', 3000, 'IDR', 'Taxi'],
    ['/split taxi RM42', 4200, 'MYR', 'Taxi'],
    ['/split taxi S$42', 4200, 'SGD', 'Taxi'],
    ['/split taxi $42', 4200, 'SGD', 'Taxi'],
  ])('prepares %s through add_expense', async (input, total, currency, description) => {
    const h = make();
    const messageId = await h.send(input as string);
    const action = plan(h);
    expect(action).toMatchObject({ kind: 'add_expense', input: { total, currency, description, payerId: h.scope.actor.kind === 'member' ? h.scope.actor.memberId : 0, expenseDate: '2026-09-29', splitType: 'even' } });
    if (action.kind !== 'add_expense') throw new Error('Expected expense');
    expect(action.input.shares).toHaveLength(3);
    expect(d.listExpenses(h.db, h.scope, h.groups[0]!.trip!.id)).toEqual([]);
    expect(h.buttons().map(b => b.text)).toEqual(['Approve', 'Change', 'Cancel']);
    expect(h.sent().at(-1)).toMatchObject({ parse_mode: 'HTML', reply_parameters: { message_id: messageId, allow_sending_without_reply: true } });
    expect(h.text()).toContain('Paid by you');
    expect(h.text()).toContain('• You:');
    expect(h.text()).toBe(telegramChunks(proposalSummary(h.proposals()[0]!.actions as PlannedAction[]))[0]);
    for (const b of h.buttons()) expect(Buffer.byteLength(b.callback_data!)).toBeLessThanOrEqual(64);
  });
  it.each(['/split', '/split taxi', '/split 24', '/split SGD 24', '/split with Sam', '/split 24 taxi with'])('shows two-line usage for %s', async input => {
    const h = make(); await h.send(input);
    expect(h.text()).toBe(USAGE); expect(h.proposals()).toEqual([]); expect(h.suggestRate).not.toHaveBeenCalled();
  });
  it.each(['/split 24.501 dinner', '/split 24,5011 dinner', '/split 30.5 JPY ramen', '/split 30,5 KRW ramen', '/split 1,23,456 dinner'])('rejects invalid precision/grouping: %s', async input => {
    const h = make(); await h.send(input);
    expect(h.text()).toMatch(/decimals|thousands separators/); expect(h.proposals()).toEqual([]); expect(h.suggestRate).not.toHaveBeenCalled();
  });
  it('includes the sender and known with names once, resolved case-insensitively', async () => {
    const h = make(); await h.send('/split 60 dinner WITH sAm, ANA, me, Sam');
    const action = plan(h);
    expect(action).toMatchObject({ kind: 'add_expense', input: { total: 6000, shares: h.groups[0]!.members.map(m => ({ memberId: m.id, weight: 1 })) } });
  });
  it('includes only the sender and Sam, even with another active member', async () => {
    const h = make(); await h.send('/split 3000 jpy ramen with Sam');
    expect(plan(h)).toMatchObject({ input: { shares: h.groups[0]!.members.slice(0, 2).map(m => ({ memberId: m.id, weight: 1 })) } });
  });
  it('excludes inactive members from everyone', async () => {
    const h = make(); d.setMemberActive(h.db, h.scope, h.groups[0]!.members[2]!.id, false);
    await h.send('/split 24 taxi');
    expect(plan(h)).toMatchObject({ input: { shares: h.groups[0]!.members.slice(0, 2).map(m => ({ memberId: m.id, weight: 1 })) } });
  });
  it.each(['Unknown <name>', 'Sa'])('names unresolved people and candidates without proposing: %s', async name => {
    const h = make(); d.addManualMember(h.db, h.scope, 'Sally');
    await h.send(`/split 60 dinner with ${name}`);
    expect(h.text()).toContain(name.replace('<', '&lt;').replace('>', '&gt;'));
    expect(h.text()).toContain('Sam'); expect(h.text()).toContain('Sally');
    expect(h.text()).not.toContain('"'); expect(h.proposals()).toEqual([]);
  });
  it('asks about identical display names; @username can select the correct person', async () => {
    const h = make(); d.upsertTelegramMember(h.db, h.scope, { telegramUserId: 999, displayName: 'Sam', username: 'other_sam' });
    await h.send('/split 24 taxi with Sam');
    expect(h.text()).toContain('Sam (@sam), Sam (@other_sam)'); expect(h.proposals()).toEqual([]);
    await h.send('/split 24 taxi with @other_sam');
    expect(h.proposals()).toHaveLength(1);
  });
  it.each([['JPY', '¥', 'JPY'], ['CNY', '¥', 'CNY'], ['USD', '$', 'USD']])('uses ambiguous symbols only when the %s home currency matches', async (home, symbol, currency) => {
    const h = make({ home }); await h.send(`/split dinner ${symbol}42`);
    expect(plan(h)).toMatchObject({ input: { currency } }); expect(h.suggestRate).not.toHaveBeenCalled();
  });
  it.each([['SGD', '¥'], ['EUR', '$']])('asks for a code for %s home and %s symbol', async (home, symbol) => {
    const h = make({ home }); await h.send(`/split dinner ${symbol}42`);
    expect(h.text()).toContain('Which currency'); expect(h.proposals()).toEqual([]);
  });
  it('looks up a missing trip rate, announces it, and stores it only on approval', async () => {
    const h = make(); await h.send('/split 3000 JPY ramen');
    expect(h.suggestRate).toHaveBeenCalledExactlyOnceWith('SGD', 'JPY');
    expect(h.text()).toContain('1 SGD = 112.4 JPY · looked up today');
    expect(h.text()).toContain('3,000 JPY (≈ 26.69 SGD)');
    expect(d.listTripRates(h.db, h.scope, h.groups[0]!.trip!.id)).toEqual([]);
    await h.tap(h.data('Approve'));
    expect(d.listTripRates(h.db, h.scope, h.groups[0]!.trip!.id)[0]).toMatchObject({ rate: '112.4', origin: 'suggested' });
    expect(d.listExpenses(h.db, h.scope, h.groups[0]!.trip!.id)[0]).toMatchObject({ status: 'confirmed', fxRate: '112.4' });
    expect(h.sent('editMessageText').at(-1)?.text).toBe('✅ Completed 2 changes');
  });
  it('uses a saved trip rate without calling the rate service', async () => {
    const h = make(); d.setTripRate(h.db, h.scope, h.groups[0]!.trip!.id, 'JPY', '100', 'member');
    await h.send('/split 3000 JPY ramen');
    expect(h.suggestRate).not.toHaveBeenCalled(); expect(h.text()).toContain('30.00 SGD'); expect(h.text()).toContain('trip rate');
  });
  it('does not propose when a live rate is unavailable', async () => {
    const h = make(); h.suggestRate.mockResolvedValue(null);
    await h.send('/split 3000 JPY ramen');
    expect(h.text()).toContain("couldn't look it up"); expect(h.proposals()).toEqual([]);
  });
  it.each(['Approve', 'Cancel', 'Change'])('allows only the sender to use %s', async action => {
    const h = make({ ai: false }); await h.send('/split 24 taxi'); const data = h.data(action);
    await h.tap(data, SAM);
    expect(h.sent('answerCallbackQuery').at(-1)).toMatchObject({ text: 'Only Darin can confirm this.', show_alert: true });
    expect(h.proposals()[0]!.status).toBe('pending');
    await h.tap(data);
    expect(h.proposals()[0]!.status).toBe(action === 'Approve' ? 'done' : 'cancelled');
    expect(d.listExpenses(h.db, h.scope, h.groups[0]!.trip!.id)).toHaveLength(action === 'Approve' ? 1 : 0);
    if (action === 'Approve') expect(h.sent('editMessageText').at(-1)?.text).toBe('✅ Added Taxi · 24.00 SGD');
    if (action === 'Cancel') expect(h.sent('editMessageText').at(-1)).toMatchObject({ text: 'Cancelled.', reply_markup: { inline_keyboard: [] } });
    if (action === 'Change') expect(h.text()).toBe(`Send /split again with the changes, or tell me what to change: @${BOT} …`);
    await h.tap(data);
    expect(h.sent('answerCallbackQuery').at(-1)?.text).toBe(action === 'Approve' ? 'Already done.' : 'That offer was cancelled.');
  });
  it('survives failed Telegram edits without losing or duplicating confirmed expenses', async () => {
    const h = make(); await h.send('/split 24 taxi'); const data = h.data('Approve');
    h.failing.add('editMessageText'); h.failing.add('answerCallbackQuery'); await h.tap(data);
    h.failing.clear(); await h.tap(data);
    expect(d.listExpenses(h.db, h.scope, h.groups[0]!.trip!.id)).toHaveLength(1);
    expect(h.sent().filter(p => String(p.text).includes('Darin added Taxi'))).toHaveLength(1);
  });
  it.each(['Approve', 'Cancel', 'Change'])('rejects stale and expired proposals for %s', async action => {
    const h = make(); await h.send('/split 24 taxi'); const data = h.data(action);
    d.renameTrip(h.db, h.scope, h.groups[0]!.trip!.id, 'Changed'); await h.tap(data);
    expect(h.sent('answerCallbackQuery').at(-1)?.text).toContain('This changed');
    d.setClockForTests(() => new Date(NOW.getTime() + 15 * 60_000)); await h.tap(data);
    expect(h.sent('answerCallbackQuery').at(-1)?.text).toContain('expired');
    expect(d.listExpenses(h.db, h.scope, h.groups[0]!.trip!.id)).toEqual([]);
  });
  it('starts a new active trip through the tools after the last one ended', async () => {
    const h = make({ home: 'JPY' }); d.endTrip(h.db, h.scope, h.groups[0]!.trip!.id);
    await h.send('/split 3000 ramen');
    const trip = d.getActiveTrip(h.db, h.scope)!;
    expect(trip.id).not.toBe(h.groups[0]!.trip!.id); expect(trip.homeCurrency).toBe('JPY');
    expect(plan(h)).toMatchObject({ tripId: trip.id, input: { currency: 'JPY' } });
    await h.tap(h.data('Approve')); expect(d.listExpenses(h.db, h.scope, trip.id)).toHaveLength(1);
  });
  it('works privately with one group and sends the saved notice to that group', async () => {
    const h = make(); await h.send('/split 24 taxi', ME.id);
    expect(h.proposals()[0]!.chatId).toBe(ME.id);
    expect(d.chosenGroup(h.db, ME.id, ME.id)?.groupId).toBe(h.groups[0]!.group.id);
    const data = h.data('Approve'); await h.tap(data, ME, CHAT);
    expect(h.sent('answerCallbackQuery').at(-1)?.text).toBe('That offer does not exist.');
    await h.tap(data, ME, ME.id);
    expect(h.sent().at(-1)).toMatchObject({ chat_id: CHAT, text: expect.stringContaining('Darin added Taxi') });
  });
  it.each(['/split 24 taxi', '/today', '/wrap'])('resumes %s once after private group selection', async command => {
    const h = make({ groups: 2 }); await h.send(command, ME.id);
    expect(h.text()).toBe('Which group do you mean?');
    const group = h.groups[1]!.group;
    await h.tap(`ag:g:${group.id}`, ME, ME.id);
    expect(d.chosenGroup(h.db, ME.id, ME.id)?.groupId).toBe(group.id);
    if (command.startsWith('/split')) expect(h.proposals()[0]!.groupId).toBe(group.id);
    else expect(launch(h).groupId).toBe(group.id);
    const count = h.sent().length;
    await h.tap(`ag:g:${group.id}`, ME, ME.id); expect(h.sent()).toHaveLength(count);
  });
  it('clears pending commands on /group and rejects a forged selection', async () => {
    const h = make({ groups: 2 }); await h.send('/split 24 taxi', ME.id);
    await h.tap('ag:g:999', ME, ME.id);
    expect(h.sent('answerCallbackQuery').at(-1)?.text).toBe('That group is not available.');
    await h.send('/group', ME.id); await h.tap(`ag:g:${h.groups[0]!.group.id}`, ME, ME.id);
    expect(h.proposals()).toEqual([]);
  });
  it('expires a pending private command', async () => {
    const h = make({ groups: 2 }); await h.send('/split 24 taxi', ME.id);
    d.setClockForTests(() => new Date(NOW.getTime() + 31 * 60_000));
    await h.tap(`ag:g:${h.groups[0]!.group.id}`, ME, ME.id); expect(h.proposals()).toEqual([]);
  });
});

describe('/today', () => {
  it('lists newest confirmed expenses, totals, top payer, drafts and a home button', async () => {
    const h = make(); expense(h); expense(h, { description: 'Lunch', payerId: h.groups[0]!.members[0]!.id, total: 1200 });
    expense(h, { status: 'draft', description: 'Draft', total: 999999 });
    expense(h, { status: 'draft', description: 'Draft two', total: 999999 });
    expense(h, { expenseDate: '2026-09-28', description: 'Earlier' });
    await h.send('/today');
    expect(h.text()).toBe("<b>☀️ Today's damage</b>\n\n🧾 Lunch · 12.00 SGD · you\n🧾 Taxi · 24.00 SGD · Sam\n\n💸 Total: 36.00 SGD across 2 expenses\n👑 Big spender: Sam (24.00 SGD)\n\n🧾 2 receipts waiting for approval");
    expect(h.buttons()[0]!.text).toBe('View in app'); expect(launch(h).view).toBe('home');
  });
  it('uses the stored foreign rate and foundation half-up rounding', async () => {
    const h = make(); expense(h, { payerId: h.groups[0]!.members[0]!.id, description: 'Ramen', total: 3000, currency: 'JPY', rateOverride: '112.36' });
    await h.send('/today');
    expect(h.text()).toContain('🧾 Ramen · 3,000 JPY (≈ 26.70 SGD) · you');
    expect(h.text()).toContain('💸 Total: 26.70 SGD'); expect(h.suggestRate).not.toHaveBeenCalled();
  });
  it('lists active payments on their Singapore date without adding them to spending', async () => {
    const h = make(); expense(h);
    const payment = () => d.createSettlement(h.db, h.scope, { tripId: h.groups[0]!.trip!.id, fromMemberId: h.groups[0]!.members[1]!.id, toMemberId: h.groups[0]!.members[2]!.id, amount: 2000 });
    payment(); const undone = payment(); d.undoSettlement(h.db, h.scope, undone.id, undone.version);
    d.setClockForTests(() => new Date('2026-09-28T15:59:00Z')); payment(); d.setClockForTests(() => NOW);
    await h.send('/today');
    expect(h.text()).toContain('💸 Total: 24.00 SGD'); expect(h.text()).toContain('<b>🤝 Paid back</b>\n• Sam → Ana · 20.00 SGD');
    expect(h.text().match(/Sam → Ana/g)).toHaveLength(1);
  });
  it('shows payments without expenses', async () => {
    const h = make(); d.createSettlement(h.db, h.scope, { tripId: h.groups[0]!.trip!.id, fromMemberId: h.groups[0]!.members[1]!.id, toMemberId: h.groups[0]!.members[2]!.id, amount: 2000 });
    await h.send('/today'); expect(h.text()).not.toContain('Total'); expect(h.text()).toContain('Sam → Ana · 20.00 SGD'); expect(h.text()).not.toContain('Nothing');
  });
  it.each([['', 'A quiet day. Nothing spent yet.'], [' yesterday', 'Wallets rested on Mon 28 Sep.'], [' 25 Sep', 'Wallets rested on Fri 25 Sep.'], [' 2026-09-25', 'Wallets rested on Fri 25 Sep.']])('reports no records for /today%s', async (arg, ending) => {
    const h = make(); await h.send(`/today${arg}`); expect(h.text()).toContain(ending); expect(h.buttons()[0]!.text).toBe('View in app');
  });
  it.each(['yesterday', '28 Sep', '2026-09-28'])('selects the correct date for %s', async arg => {
    const h = make(); expense(h); expense(h, { expenseDate: '2026-09-28', description: 'Yesterday', total: 1234 });
    await h.send(`/today ${arg}`); expect(h.text()).toContain('Yesterday · 12.34 SGD'); expect(h.text()).not.toContain('Taxi');
  });
  it.each(['31 Sep', '2026-02-29', 'tomorrow', '2026-09-31'])('rejects invalid dates: %s', async arg => {
    const h = make(); await h.send(`/today ${arg}`); expect(h.text()).toContain('Try: /today');
  });
  it('mentions drafts when nothing is confirmed', async () => {
    const h = make(); expense(h, { status: 'draft' }); await h.send('/today');
    expect(h.text()).toContain('A quiet day. Nothing spent yet.'); expect(h.text()).toContain('1 receipt waiting for approval');
  });
  it('caps expense bullets at 15 but sums all confirmed expenses', async () => {
    const h = make(); for (let i = 0; i < 19; i++) expense(h, { description: `Expense ${i}`, total: 100 });
    await h.send('/today'); expect(h.text().match(/🧾 Expense/g)).toHaveLength(15); expect(h.text()).toContain('…and 4 more'); expect(h.text()).toContain('💸 Total: 19.00 SGD across 19 expenses'); expect(h.text()).toContain('🏃 Busy day!');
    expect(h.text()).toContain('Expense 18'); expect(h.text()).not.toContain('Expense 0 ·');
  });
  it('does not fall back to an ended trip or create a new trip', async () => {
    const h = make(); expense(h); d.endTrip(h.db, h.scope, h.groups[0]!.trip!.id);
    await h.send('/today'); expect(h.text()).toContain('A quiet day. Nothing spent yet.'); expect(d.getActiveTrip(h.db, h.scope)).toBeUndefined();
  });
});

describe('/wrap', () => {
  it('recaps the active trip using expense dates, spending shares and suggested payments', async () => {
    const h = make(); expense(h, { expenseDate: '2026-09-25', total: 2400 });
    expense(h, { expenseDate: '2026-10-02', total: 6000, description: 'Hotel', payerId: h.groups[0]!.members[2]!.id });
    expense(h, { status: 'draft', expenseDate: '2026-01-01', total: 999999 });
    await h.send('/wrap');
    expect(h.text()).toBe("<b>🏁 Trip 0: that's a wrap!</b>\n\n📅 25 Sep – 2 Oct · 8 days\n💸 84.00 SGD spent across 2 expenses\n📆 About 10.50 SGD a day\n\n<b>🏆 Awards</b>\n👑 Biggest spender: Ana (60.00 SGD paid)\n💎 Priciest moment: 🧾 Hotel · 60.00 SGD\n🔥 Biggest day: 2 Oct · 60.00 SGD\n\n<b>🧮 Each person's share</b>\n• You: 28.00 SGD\n• Sam: 28.00 SGD\n• Ana: 28.00 SGD\n\n<b>💰 Time to settle up</b>\n• You → Ana · 28.00 SGD\n• Sam → Ana · 4.00 SGD\n\nUntil the next trip ✈️");
    expect(h.buttons()[0]!.text).toBe('Settle up in app'); expect(launch(h).view).toBe('balances');
  });
  it('uses the most recently ended trip and creates none', async () => {
    const h = make(); expense(h);
    const first = h.groups[0]!.trip!; d.endTrip(h.db, h.scope, first.id);
    const second = d.getOrCreateActiveTrip(h.db, h.scope).trip;
    d.renameTrip(h.db, h.scope, second.id, 'Newer trip'); d.endTrip(h.db, h.scope, second.id);
    d.reopenTrip(h.db, h.scope, first.id);
    d.setClockForTests(() => new Date(NOW.getTime() + 1000)); d.endTrip(h.db, h.scope, first.id);
    await h.send('/wrap'); expect(h.text()).toContain("<b>🏁 Trip 0: that's a wrap!</b>"); expect(h.text()).toContain('spent across 1 expense');
    expect(d.getActiveTrip(h.db, h.scope)).toBeUndefined();
  });
  it('prefers an active trip to ended history', async () => {
    const h = make(); expense(h); d.endTrip(h.db, h.scope, h.groups[0]!.trip!.id);
    const active = d.getOrCreateActiveTrip(h.db, h.scope).trip; d.renameTrip(h.db, h.scope, active.id, 'Current');
    await h.send('/wrap'); expect(h.text()).toContain('🏁 Current'); expect(h.text()).toContain('No expenses yet'); expect(h.text()).not.toContain('24.00');
  });
  it('reports everyone settled after payments without changing spending or shares', async () => {
    const h = make(); expense(h);
    for (const p of d.getTripBalances(h.db, h.scope, h.groups[0]!.trip!.id).payments) d.createSettlement(h.db, h.scope, { tripId: h.groups[0]!.trip!.id, ...p });
    await h.send('/wrap'); expect(h.text()).toContain('Everyone is settled up. 🎉'); expect(h.text()).toContain('💸 24.00 SGD spent'); expect(h.text()).toContain('You: 8.00 SGD'); expect(h.text()).not.toContain('Time to settle up');
  });
  it('converts foreign expenses, divides days with foundation rounding, and preserves converted shares', async () => {
    const h = make(); expense(h, { total: 3000, currency: 'JPY', rateOverride: '112.36', expenseDate: '2026-09-25' });
    expense(h, { total: 1, expenseDate: '2026-09-26' });
    await h.send('/wrap'); expect(h.text()).toContain('💸 26.71 SGD spent'); expect(h.text()).toContain('📆 About 13.36 SGD a day'); expect(h.text()).toContain('💎 Priciest moment: 🧾 Taxi · 26.70 SGD'); expect(h.text()).toContain('Sam: 8.93 SGD'); expect(h.suggestRate).not.toHaveBeenCalled();
  });
  it('escapes long names and descriptions, chunks safely, and places the button only at the end', async () => {
    const h = make();
    for (let i = 0; i < 45; i++) d.addManualMember(h.db, h.scope, `${i} <&> ${'Long name '.repeat(10)}`);
    d.renameTrip(h.db, h.scope, h.groups[0]!.trip!.id, '<Kyoto & Osaka>');
    expense(h, { description: '<Hotel & dinner>', shares: d.listMembers(h.db, h.scope).map(m => ({ memberId: m.id })) });
    await h.send('/wrap');
    const replies = h.sent(); expect(replies.length).toBeGreaterThan(1);
    const combined = replies.map(p => p.text).join('\n');
    expect(combined).toContain('&lt;Kyoto &amp; Osaka&gt;'); expect(combined).toContain('&lt;Hotel &amp; dinner&gt;'); expect(combined).toContain('&lt;&amp;&gt;'); expect(combined).not.toContain('<Hotel');
    for (const [index, reply] of replies.entries()) {
      expect(String(reply.text).length).toBeLessThanOrEqual(4000); expect(reply.parse_mode).toBe('HTML');
      expect(Boolean(reply.reply_markup)).toBe(index === replies.length - 1);
      expect(String(reply.text).match(/<b>/g)?.length ?? 0).toBe(String(reply.text).match(/<\/b>/g)?.length ?? 0);
    }
  });
});

it('/help lists commands and examples', async () => {
  const h = make(); await h.send('/help');
  expect(h.text()).toContain('/split 24 taxi'); expect(h.text()).toContain('/today yesterday'); expect(h.text()).toContain('/wrap — trip recap');
});
it('leaves other bot commands and receipts to the existing handlers', async () => {
  const h = make(); await h.send('/split@other_bot 24 taxi'); expect(h.passed).toHaveBeenCalledOnce(); expect(h.proposals()).toEqual([]);
  await h.send('', CHAT, ME, { text: undefined, entities: undefined, caption: `@${BOT}`, photo: [{ file_id: 'p', file_unique_id: 'p', width: 10, height: 10 }] });
  expect(h.readReceipt).toHaveBeenCalledOnce();
});
it('does not act for bots, anonymous senders or channels', async () => {
  const h = make(); await h.send('/split 24 taxi', CHAT, { ...ME, is_bot: true });
  await h.send('/split 24 taxi', CHAT, ME, { sender_chat: { id: CHAT, type: 'group', title: 'Trip 0' } });
  await h.send('/split 24 taxi', CHAT, ME, { chat: { id: CHAT, type: 'channel', title: 'Trip 0' } });
  expect(h.proposals()).toEqual([]);
});
