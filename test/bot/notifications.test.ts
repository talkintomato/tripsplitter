import { afterEach, expect, it } from 'vitest';
import { createExpense, setGroupNotification, setMyNotification, memberScope, upsertTelegramMember, PERSONAL_NOTICE_TYPES, GROUP_NOTICE_TYPES, type Db } from '../../src/db/index.js';
import type { ExpenseNotice, Notifier, RateNotice, SettlementNotice } from '../../src/core/index.js';
import { decodeLaunch } from '../../src/core/index.js';
import { expenseNoticeContext } from '../../src/tools/notice-context.js';
import { sendDraftWaiting } from '../../src/bot/personal-notices.js';
import { seed, dinner } from '../db/helpers.js';
import { harness } from './helpers.js';
const databases: Db[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function setup() {
  const s = seed(); databases.push(s.db);
  const h = harness({ db: s.db });
  const e = createExpense(s.db, s.asAna, dinner(s));
  const expense: ExpenseNotice = { chatId: s.group.chatId, groupId: s.group.id, actorName: 'Ana', expenseId: e.id,
    description: e.description, total: e.total, currency: e.currency, splitType: e.splitType, shares: [], personal: expenseNoticeContext(s.db, s.asAna, e) };
  const payment: SettlementNotice = { chatId: s.group.chatId, groupId: s.group.id, actorMemberId: s.ana.id, actorName: 'Ana',
    tripId: s.trip.id, tripName: s.trip.name, fromMemberId: s.sam.id, toMemberId: s.leo.id, fromName: 'Sam', toName: 'Leo', amount: 2000, currency: 'SGD' };
  const rate: RateNotice = { chatId: s.group.chatId, groupId: s.group.id, actorMemberId: s.ana.id, actorName: 'Ana', tripId: s.trip.id,
    tripName: s.trip.name, currency: 'JPY', homeCurrency: 'SGD', rate: '110', origin: 'member', expensesChanged: 1, affectedMemberIds: [s.ana.id, s.sam.id] };
  const trip = { chatId: s.group.chatId, groupId: s.group.id, actorName: 'Ana', tripName: s.trip.name };
  const all: Array<{ type: typeof GROUP_NOTICE_TYPES[number]; method: keyof Notifier; send(): Promise<void> }> = [
    { type: 'expense_added', method: 'expenseSaved', send: () => h.notifier.expenseSaved(expense) },
    { type: 'expense_changed', method: 'expenseEdited', send: () => h.notifier.expenseEdited({ ...expense, changes: ['People changed'] }) },
    { type: 'expense_removed', method: 'expenseDeleted', send: () => h.notifier.expenseDeleted(expense) },
    { type: 'expense_removed', method: 'expenseRestored', send: () => h.notifier.expenseRestored(expense) },
    { type: 'payment', method: 'settlementRecorded', send: () => h.notifier.settlementRecorded(payment) },
    { type: 'payment', method: 'settlementUndone', send: () => h.notifier.settlementUndone(payment) },
    { type: 'payment', method: 'settlementRestored', send: () => h.notifier.settlementRestored(payment) },
    { type: 'exchange_rate', method: 'tripRateChanged', send: () => h.notifier.tripRateChanged(rate) },
    { type: 'trip', method: 'tripEnded', send: () => h.notifier.tripEnded(trip) },
    { type: 'trip', method: 'tripReopened', send: () => h.notifier.tripReopened(trip) },
    { type: 'member_joined', method: 'memberJoinedByLink', send: () => h.notifier.memberJoinedByLink({ chatId: s.group.chatId, groupId: s.group.id, memberName: 'Sam' }) },
  ];
  const privateCalls = () => h.sent().filter(c => Number(c.payload.chat_id) > 0);
  return { ...s, h, expense, payment, rate, all, privateCalls };
}
it.each(GROUP_NOTICE_TYPES)('switching off %s suppresses exactly its group notices', async type => {
  const s = setup();
  setGroupNotification(s.db, s.asSam, type, false);
  for (const n of s.all) {
    s.h.calls.length = 0;
    await n.send();
    expect(s.h.sent(), n.method).toHaveLength(n.type === type ? 0 : 1);
  }
});
it('link reset always posts with every group notice off', async () => {
  const s = setup();
  for (const type of GROUP_NOTICE_TYPES) setGroupNotification(s.db, s.asAna, type, false);
  await s.h.notifier.linkReset({ chatId: s.group.chatId, groupId: s.group.id, actorName: 'Ana' });
  expect(s.h.sent()).toHaveLength(2);
  expect(s.h.texts()[0]).toContain('reset');
  expect(s.h.texts()[1]).toContain('Hi, I track');
});
it.each(PERSONAL_NOTICE_TYPES)('%s excludes the actor and non-opted-in people even with the group notices off', async type => {
  const s = setup();
  const outsider = upsertTelegramMember(s.db, s.asSystem, { telegramUserId: 104, displayName: 'Kai' }).member;
  const send = () => type === 'added_me' ? s.h.notifier.expenseSaved(s.expense)
    : type === 'changed_mine' ? s.h.notifier.expenseEdited({ ...s.expense, changes: ['Total changed'] })
    : type === 'payments_me' ? s.h.notifier.settlementRecorded(s.payment)
    : type === 'exchange_rate' ? s.h.notifier.tripRateChanged(s.rate)
    : sendDraftWaiting(s.h.bot.api, s.h.config, s.db, { error: () => {} }, { groupId: s.group.id, actorMemberId: s.ana.id, actorName: 'Ana', tripName: s.trip.name, expenseId: s.expense.expenseId });
  for (const t of GROUP_NOTICE_TYPES) setGroupNotification(s.db, s.asAna, t, false);
  await send();
  expect(s.h.sent()).toHaveLength(0);
  for (const m of [s.ana, s.sam, s.leo, outsider]) setMyNotification(s.db, memberScope(s.group.id, m.id), type, true);
  await send();
  expect(s.privateCalls().map(c => c.payload.chat_id)).toEqual(type === 'draft_waiting' ? [102, 104] : [102]);
  expect(s.h.sent().every(c => Number(c.payload.chat_id) > 0)).toBe(true);
});
it.each(['expenseEdited', 'expenseDeleted', 'expenseRestored'] as const)('%s reaches a payer outside the split and former participants after edits', async method => {
  const s = setup();
  setMyNotification(s.db, s.asSam, 'changed_mine', true);
  const personal = { ...s.expense.personal!, payerId: s.sam.id, memberIds: [s.ana.id] };
  await s.h.notifier[method]({ ...s.expense, personal, changes: [] });
  expect(s.privateCalls()).toHaveLength(1);
  s.h.calls.length = 0;
  if (method === 'expenseEdited') {
    await s.h.notifier.expenseEdited({ ...s.expense, personal: { ...personal, payerId: s.ana.id }, beforePersonal: personal, changes: ['Paid by changed'] });
    expect(s.privateCalls()).toHaveLength(1);
  }
});
it.each(['settlementRecorded', 'settlementUndone', 'settlementRestored'] as const)('%s reaches both parties but never the actor', async method => {
  const s = setup();
  const actor = upsertTelegramMember(s.db, s.asSystem, { telegramUserId: 104, displayName: 'Kai' }).member;
  for (const m of [s.ana, s.sam, actor]) setMyNotification(s.db, memberScope(s.group.id, m.id), 'payments_me', true);
  await s.h.notifier[method]({ ...s.payment, actorMemberId: actor.id, actorName: 'Kai', toMemberId: s.ana.id, toName: 'Ana' });
  expect(s.privateCalls().map(c => c.payload.chat_id)).toEqual([101, 102]);
  expect(s.privateCalls()[0]!.payload.text).toContain('Sam paid you 20.00 SGD');
  expect(s.privateCalls()[1]!.payload.text).toContain('you paid Ana 20.00 SGD');
});
it('a private failure logs only a reason, does not retry, and continues to the next person', async () => {
  const s = setup();
  const extra = upsertTelegramMember(s.db, s.asSystem, { telegramUserId: 104, displayName: 'Kai' }).member;
  for (const m of [s.sam, extra]) setMyNotification(s.db, memberScope(s.group.id, m.id), 'added_me', true);
  s.h.bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === 'sendMessage' && (payload as Record<string, unknown>).chat_id === 102) {
      s.h.calls.push({ method, payload });
      return { ok: false, error_code: 403, description: 'Forbidden private secret text Ana' };
    }
    return prev(method, payload, signal);
  });
  await expect(s.h.notifier.expenseSaved({ ...s.expense, personal: { ...s.expense.personal!, memberIds: [s.sam.id, extra.id] } })).resolves.toBeUndefined();
  expect(s.privateCalls().map(c => c.payload.chat_id)).toEqual([102, 104]);
  expect(s.h.errors).toEqual([{ message: 'Could not send personal notice', details: { type: 'added_me', reason: 'private_chat_unavailable', code: 403 } }]);
});
it.each([false, true])('private Open uses the signed expense launch and web_app only with a public address (%s)', async webApp => {
  const s = setup();
  s.h.config.webhookUrl = webApp ? 'https://trip.example/app' : undefined;
  setMyNotification(s.db, s.asSam, 'added_me', true);
  await s.h.notifier.expenseSaved(s.expense);
  const markup = s.privateCalls()[0]!.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; url?: string; web_app?: { url: string } }>> };
  const button = markup.inline_keyboard[0]![0]!;
  expect(button.text).toBe('Open');
  expect(Boolean(button.web_app)).toBe(webApp);
  const url = new URL(button.web_app?.url ?? button.url!);
  expect(decodeLaunch(url.searchParams.get('startapp')!, s.h.config.linkSecret)).toMatchObject({ groupId: s.group.id, view: 'expense', expenseId: s.expense.expenseId });
  expect(s.privateCalls()[0]!.payload.text).toBe('➕ Ana added Dinner in Japan 2026 · you owe 3.33 SGD');
});

it('a failed group post does not suppress the personal delivery', async () => {
  const s = setup();
  setMyNotification(s.db, s.asSam, 'added_me', true);
  s.h.bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === 'sendMessage' && (payload as Record<string, unknown>).chat_id === s.group.chatId) return { ok: false, error_code: 403, description: 'Group unavailable' };
    return prev(method, payload, signal);
  });
  await s.h.notifier.expenseSaved(s.expense);
  expect(s.privateCalls().map(c => c.payload.chat_id)).toEqual([102]);
});
