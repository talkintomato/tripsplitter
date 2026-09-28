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
    expect(h.texts()).toEqual(['<b>➕ Ana added Casa Pepe</b>\nTotal: 84.50 SGD\nSplit by item\n• Sam: 31.20 SGD\n• Leo: 22.80 SGD\n• Ana: 30.50 SGD']);
    expect(h.sent()[0]?.payload.chat_id).toBe(CHAT);
    expect(h.sent()[0]?.payload.parse_mode).toBe('HTML');
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
      '<b>➕ Ana added Ichiran</b>\nTotal: 12,400 JPY\nSplit equally between 2\n• Sam: 6,200 JPY\n• Ana: 6,200 JPY',
      '<b>➕ Ana added Taxi</b>\nTotal: 50,000 KRW\nSplit by portions\n• Sam: 50,000 KRW',
    ]);
  });

  it('expenseEdited, with a View button', async () => {
    const { h, group } = await ready();
    await h.notifier.expenseEdited({ ...expense(group, { actorName: 'Sam', total: 8850 }), changes: ['total 84.50 to 88.50 SGD'] });
    await h.notifier.expenseEdited({ ...expense(group, { actorName: 'Sam' }), changes: ['total 84.50 to 88.50 SGD', 'payer Ana to Leo'] });
    expect(h.texts()).toEqual([
      '<b>✏️ Sam changed Casa Pepe</b>\nTotal: 84.50 → 88.50 SGD',
      '<b>✏️ Sam changed Casa Pepe</b>\nTotal: 84.50 → 88.50 SGD\nPaid by: Ana → Leo',
    ]);
    expect(launchOf(h, buttons(h.sent()[0])[0]?.url)).toMatchObject({ view: 'expense', expenseId: 42 });
  });

  it('expenseDeleted and expenseRestored', async () => {
    const { h, group } = await ready();
    await h.notifier.expenseDeleted(expense(group, { actorName: 'Leo' }));
    await h.notifier.expenseRestored(expense(group, { actorName: 'Leo', total: 1200, currency: 'JPY' }));
    expect(h.texts()).toEqual(['<b>🗑️ Leo deleted Casa Pepe · 84.50 SGD</b>', '<b>♻️ Leo restored Casa Pepe · 1,200 JPY</b>']);
    expect(buttons(h.sent()[0])).toEqual([]);
  });

  it('settlementRecorded, settlementUndone and settlementRestored', async () => {
    const { h } = await ready();
    await h.notifier.settlementRecorded(settlement);
    await h.notifier.settlementUndone(settlement);
    await h.notifier.settlementRestored({ ...settlement, amount: 3500, currency: 'JPY' });
    expect(h.texts()).toEqual([
      '<b>💸 Leo recorded payment</b>\nSam → Ana · 31.20 SGD',
      '<b>↩️ Leo undid payment</b>\nSam → Ana · 31.20 SGD',
      '<b>♻️ Leo restored payment</b>\nSam → Ana · 3,500 JPY',
    ]);
  });

  it('tripRateChanged, by a member and suggested', async () => {
    const { h } = await ready();
    const rate = { chatId: CHAT, actorName: 'Ana', homeCurrency: 'SGD', currency: 'JPY' };
    await h.notifier.tripRateChanged({ ...rate, rate: '110', origin: 'member', expensesChanged: 7 });
    await h.notifier.tripRateChanged({ ...rate, rate: '110', origin: 'member', expensesChanged: 1 });
    await h.notifier.tripRateChanged({ ...rate, rate: '112.4', origin: 'suggested', expensesChanged: 1 });
    expect(h.texts()).toEqual([
      '<b>💱 Ana changed the exchange rate</b>\nRate: 1 SGD = 110 JPY · trip rate\n7 expenses updated',
      '<b>💱 Ana changed the exchange rate</b>\nRate: 1 SGD = 110 JPY · trip rate\n1 expense updated',
      '<b>💱 Ana changed the exchange rate</b>\nRate: 1 SGD = 112.4 JPY · looked up today\n1 expense updated',
    ]);
  });

  it('memberJoinedByLink, tripEnded and tripReopened', async () => {
    const { h } = await ready();
    await h.notifier.memberJoinedByLink({ chatId: CHAT, memberName: 'Priya' });
    await h.notifier.tripEnded({ chatId: CHAT, actorName: 'Ana', tripName: 'Japan 2026' });
    await h.notifier.tripReopened({ chatId: CHAT, actorName: 'Ana', tripName: 'Japan 2026' });
    expect(h.texts()).toEqual([
      'Priya joined the trip through the link.',
      '<b>🏁 Ana ended Japan 2026</b>\nBalances can still be settled.',
      '<b>🔓 Ana reopened Japan 2026</b>',
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

it('escapes notices, bounds them to six lines and reports omitted changes',async()=>{
  const {h,group}=await ready();
  await h.notifier.expenseEdited({...expense(group,{description:'<b>Tom & Jerry</b>',actorName:'<Sam>'}),changes:['Total: 84.50 → 88.50 SGD','Paid by: Sam → Ana','Date: Mon 28 Sep → Tue 29 Sep','Split: equally → by item','Items changed','Tax changed','Tip changed']});
  const sent=h.sent()[0]!.payload;
  expect(sent.parse_mode).toBe('HTML');
  expect(sent.text).toBe('<b>✏️ &lt;Sam&gt; changed &lt;b&gt;Tom &amp; Jerry&lt;/b&gt;</b>\nTotal: 84.50 → 88.50 SGD\nPaid by: Sam → Ana\nDate: Mon 28 Sep → Tue 29 Sep\nSplit: equally → by item\nand 3 more changes');
  await h.notifier.expenseEdited({...expense(group,{description:'&'.repeat(500)}),changes:Array(10).fill('Items: '+ '<&🍜>'.repeat(1000))});
  const html=String(h.sent()[1]!.payload.text);
  expect(html.length).toBeLessThan(4096);
  expect(html.split('\n')).toHaveLength(6);
  expect(html.replace(/<\/?b>|&(amp|lt|gt);/g,'')).not.toMatch(/[<>&]/);
});
