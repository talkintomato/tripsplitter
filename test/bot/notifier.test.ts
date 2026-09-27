import { describe, expect, it } from 'vitest';
import { decodeLaunch, type ExpenseNotice, type SettlementNotice } from '../../src/core/index.js';
import { findGroupByChatId, memberScope, resetLink, systemScope, listMembers, type Group } from '../../src/db/index.js';
import { ANA, CHAT, SAM, buttons, harness, textUpdate, type Harness } from './helpers.js';

async function ready(): Promise<{ h: Harness; group: Group }> {
  const h = harness();
  await h.bot.handleUpdate(textUpdate(CHAT, SAM));
  const group = findGroupByChatId(h.db, CHAT)!;
  h.calls.length = 0;
  return { h, group };
}

function expense(group: Group, extra: Partial<ExpenseNotice> = {}): ExpenseNotice {
  return {
    chatId: CHAT,
    actorName: 'Ana',
    expenseId: 42,
    groupId: group.id,
    description: 'Casa Pepe',
    total: 8450,
    currency: 'SGD',
    splitType: 'items',
    shares: [
      { name: 'Sam', amount: 3120 },
      { name: 'Leo', amount: 2280n },
      { name: 'Ana', amount: 3050 },
    ],
    ...extra,
  };
}

const settlement: SettlementNotice = { chatId: CHAT, actorName: 'Leo', fromName: 'Sam', toName: 'Ana', amount: 3120, currency: 'SGD' };

function launchOf(h: Harness, url: string | undefined): unknown {
  return decodeLaunch(new URL(url ?? '').searchParams.get('startapp') ?? '', h.config.linkSecret);
}

describe('notice text', () => {
  it('expenseSaved, with a View button', async () => {
    const { h, group } = await ready();
    await h.notifier.expenseSaved(expense(group));
    expect(h.texts()).toEqual(['Ana added Casa Pepe, 84.50 SGD, split by item. Sam 31.20 · Leo 22.80 · Ana 30.50']);
    expect(h.sent()[0]?.payload.chat_id).toBe(CHAT);
    const [view] = buttons(h.sent()[0]);
    expect(view?.text).toBe('View');
    expect(launchOf(h, view?.url)).toEqual({ groupId: group.id, linkVersion: group.linkVersion, view: 'expense', expenseId: 42 });
  });

  it('expenseSaved in a zero-decimal currency, split evenly and by portions', async () => {
    const { h, group } = await ready();
    const shares = [
      { name: 'Sam', amount: 6200 },
      { name: 'Ana', amount: 6200 },
    ];
    await h.notifier.expenseSaved(expense(group, { description: 'Ichiran', total: 12400, currency: 'JPY', splitType: 'even', shares }));
    await h.notifier.expenseSaved(expense(group, { description: 'Taxi', total: 50000, currency: 'KRW', splitType: 'portions', shares: [{ name: 'Sam', amount: 50000 }] }));
    expect(h.texts()).toEqual([
      'Ana added Ichiran, 12400 JPY, split evenly. Sam 6200 · Ana 6200',
      'Ana added Taxi, 50000 KRW, split by portions. Sam 50000',
    ]);
  });

  it('expenseEdited, with a View button', async () => {
    const { h, group } = await ready();
    await h.notifier.expenseEdited({ ...expense(group, { actorName: 'Sam', total: 8850 }), changes: ['total 84.50 to 88.50 SGD'] });
    await h.notifier.expenseEdited({ ...expense(group, { actorName: 'Sam' }), changes: ['total 84.50 to 88.50 SGD', 'payer Ana to Leo'] });
    expect(h.texts()).toEqual([
      'Sam edited Casa Pepe: total 84.50 to 88.50 SGD',
      'Sam edited Casa Pepe: total 84.50 to 88.50 SGD, payer Ana to Leo',
    ]);
    expect(launchOf(h, buttons(h.sent()[0])[0]?.url)).toMatchObject({ view: 'expense', expenseId: 42 });
  });

  it('expenseDeleted and expenseRestored', async () => {
    const { h, group } = await ready();
    await h.notifier.expenseDeleted(expense(group, { actorName: 'Leo' }));
    await h.notifier.expenseRestored(expense(group, { actorName: 'Leo', total: 1200, currency: 'JPY' }));
    expect(h.texts()).toEqual(['Leo deleted Casa Pepe (84.50 SGD)', 'Leo restored Casa Pepe (1200 JPY)']);
    expect(buttons(h.sent()[0])).toEqual([]);
  });

  it('settlementRecorded, settlementUndone and settlementRestored', async () => {
    const { h } = await ready();
    await h.notifier.settlementRecorded(settlement);
    await h.notifier.settlementUndone(settlement);
    await h.notifier.settlementRestored({ ...settlement, amount: 3500, currency: 'JPY' });
    expect(h.texts()).toEqual([
      'Sam paid Ana 31.20 SGD, recorded by Leo',
      'Leo undid the payment: Sam paid Ana 31.20 SGD',
      'Leo restored the payment: Sam paid Ana 3500 JPY',
    ]);
  });

  it('tripRateChanged, by a member and suggested', async () => {
    const { h } = await ready();
    const rate = { chatId: CHAT, actorName: 'Ana', homeCurrency: 'SGD', currency: 'JPY' };
    await h.notifier.tripRateChanged({ ...rate, rate: '110', origin: 'member', expensesChanged: 7 });
    await h.notifier.tripRateChanged({ ...rate, rate: '110', origin: 'member', expensesChanged: 1 });
    await h.notifier.tripRateChanged({ ...rate, rate: '112.4', origin: 'suggested', expensesChanged: 1 });
    expect(h.texts()).toEqual([
      'Ana changed the trip rate: 1 SGD = 110 JPY. 7 expenses updated.',
      'Ana changed the trip rate: 1 SGD = 110 JPY. 1 expense updated.',
      'Trip rate for JPY set to 1 SGD = 112.4 JPY. Change it in trip settings.',
    ]);
  });

  it('memberJoinedByLink, tripEnded and tripReopened', async () => {
    const { h } = await ready();
    await h.notifier.memberJoinedByLink({ chatId: CHAT, memberName: 'Priya' });
    await h.notifier.tripEnded({ chatId: CHAT, actorName: 'Ana', tripName: 'Japan 2026' });
    await h.notifier.tripReopened({ chatId: CHAT, actorName: 'Ana', tripName: 'Japan 2026' });
    expect(h.texts()).toEqual([
      'Priya joined the trip through the link.',
      'Ana ended the trip. Balances can still be settled.',
      'Ana reopened the trip.',
    ]);
  });
});

describe('link reset', () => {
  it('posts the line, then a new pinned intro with buttons of the new link version', async () => {
    const { h, group } = await ready();
    const ana = listMembers(h.db, systemScope(group.id)).find((m) => m.telegramUserId === ANA.id)!;
    const reset = resetLink(h.db, memberScope(group.id, ana.id));
    expect(reset.linkVersion).toBe(group.linkVersion + 1);

    await h.notifier.linkReset({ chatId: CHAT, groupId: group.id, actorName: 'Ana' });

    expect(h.texts()[0]).toBe("Ana reset the group's link. Old links no longer work.");
    expect(h.sent()).toHaveLength(2);
    const intro = h.sent()[1]!;
    expect(String(intro.payload.text)).toContain('Hi, I track shared expenses for this group.');
    const [add, balances] = buttons(intro);
    expect(launchOf(h, add?.url)).toEqual({ groupId: group.id, linkVersion: reset.linkVersion, view: 'add' });
    expect(launchOf(h, balances?.url)).toEqual({ groupId: group.id, linkVersion: reset.linkVersion, view: 'balances' });

    const after = findGroupByChatId(h.db, CHAT)!;
    expect(after.introMessageId).not.toBe(group.introMessageId);
    expect(h.sent('pinChatMessage').map((call) => call.payload.message_id)).toEqual([after.introMessageId]);
    expect(h.sent('unpinChatMessage').map((call) => call.payload.message_id)).toEqual([group.introMessageId]);

    // A View button posted from now on carries the new version too.
    await h.notifier.expenseSaved(expense(after));
    expect(launchOf(h, buttons(h.sent()[2])[0]?.url)).toMatchObject({ linkVersion: reset.linkVersion });
  });
});

describe('a notice that fails', () => {
  it('does not throw when Telegram refuses the message, and is logged', async () => {
    const { h, group } = await ready();
    h.failing.add('sendMessage');
    h.failing.add('pinChatMessage');
    h.failing.add('unpinChatMessage');
    const n = h.notifier;
    const rate = { chatId: CHAT, actorName: 'Ana', homeCurrency: 'SGD', currency: 'JPY', rate: '110', origin: 'member' as const, expensesChanged: 2 };
    const trip = { chatId: CHAT, actorName: 'Ana', tripName: 'Japan 2026' };
    const all = [
      n.expenseSaved(expense(group)),
      n.expenseEdited({ ...expense(group), changes: [] }),
      n.expenseDeleted(expense(group)),
      n.expenseRestored(expense(group)),
      n.settlementRecorded(settlement),
      n.settlementUndone(settlement),
      n.settlementRestored(settlement),
      n.tripRateChanged(rate),
      n.tripEnded(trip),
      n.tripReopened(trip),
      n.memberJoinedByLink({ chatId: CHAT, memberName: 'Priya' }),
      n.linkReset({ chatId: CHAT, groupId: group.id, actorName: 'Ana' }),
    ];
    for (const notice of all) await expect(notice).resolves.toBeUndefined();
    expect(h.errors.length).toBeGreaterThanOrEqual(all.length);
    expect(findGroupByChatId(h.db, CHAT)?.introMessageId).toBe(group.introMessageId);
  });

  it('does not throw for a notice that cannot be built', async () => {
    const { h, group } = await ready();
    await expect(h.notifier.expenseSaved(expense(group, { groupId: 9999 }))).resolves.toBeUndefined();
    await expect(h.notifier.expenseDeleted(expense(group, { currency: 'CHF' }))).resolves.toBeUndefined();
    await expect(h.notifier.linkReset({ chatId: CHAT, groupId: 9999, actorName: 'Ana' })).resolves.toBeUndefined();
    expect(h.errors).toHaveLength(3);
    // The line about the reset is still posted; only the intro could not be.
    expect(h.texts()).toEqual(["Ana reset the group's link. Old links no longer work."]);
  });
});
