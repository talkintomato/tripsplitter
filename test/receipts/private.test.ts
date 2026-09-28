import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeLaunch } from '../../src/core/index.js';
import {
  chosenGroup, countReceiptReads, createExpense, getExpense, listExpenses, openDatabase,
  rememberChosenGroup, reserveReceiptRead, setClockForTests, type Db,
} from '../../src/db/index.js';
import { TEXT } from '../../src/receipts/index.js';
import { dinner, seedGroup, type Seed } from '../db/helpers.js';
import { ANA, CHAT_A, CHAT_B, harness, NOW, OTHER_BOT, reading, splitEvenlyData, type Button, type Harness } from './harness.js';

let db: Db;
let s: Seed;
beforeEach(() => { db = openDatabase(':memory:'); setClockForTests(() => NOW); });
afterEach(() => { db.close(); setClockForTests(null); });
const seed = () => { s = seedGroup(db, CHAT_A, 'Test group'); };
const drafts = () => listExpenses(db, s.asAna, s.trip.id, { status: ['draft', 'confirmed'] });
const choices = (h: Harness): Button[] => (h.sent().at(-1)!.payload.reply_markup as { inline_keyboard: Button[][] }).inline_keyboard.flat();
const privatePhoto = (h: Harness, caption?: string) => h.sendPhoto(caption, ANA, ANA.id);
const choice = (h: Harness, groupId: number) => choices(h).find(b => b.callback_data!.endsWith(`:${groupId}`))!.callback_data!;
const privateReply = (h: Harness) => String([...h.calls].reverse().find(c => c.payload.chat_id === ANA.id && ['sendMessage', 'editMessageText'].includes(c.method))?.payload.text);
const notices = (h: Harness) => h.sent().filter(c => c.payload.chat_id === CHAT_A);

it('no groups: one reply and no download, reservation or read', async () => {
  const h = harness({ db }); await privatePhoto(h);
  expect(h.sent().map(c => c.payload.text)).toEqual(["Add me to your trip's Telegram group first, then send receipts here or there."]);
  expect(h.downloadPhoto).not.toHaveBeenCalled(); expect(h.readReceipt).not.toHaveBeenCalled();
  expect(db.prepare('SELECT * FROM receipt_read').all()).toEqual([]);
});

it.each([undefined, 'https://trip.example/app?existing=1'])('one group: private draft and expense-specific link with webhook %s', async webhookUrl => {
  seed(); const h = harness({ db, config: { webhookUrl, webhookSecret: 'test-secret' } });
  h.downloadPhoto.mockImplementationOnce(async () => {
    expect(countReceiptReads(db, s.group.id, NOW)).toBe(1);
    return new Uint8Array([0xff, 0xd8]);
  });
  await privatePhoto(h, 'Dinner @tripsplitter_test_bot');
  expect(drafts()).toHaveLength(1);
  const draft = drafts()[0]!;
  expect(draft).toMatchObject({ status: 'draft', tripId: s.trip.id, payerId: s.ana.id, createdBy: s.ana.id, description: 'Dinner @tripsplitter_test_bot', receiptFileId: 'photo-large' });
  expect(privateReply(h)).toBe('For Test group\n<b>✅ Approve Casa Pepe</b>\n\nTotal: 84.50 SGD\nPaid by Ana\n3 items\nUse /group to switch.');
  expect(chosenGroup(db, ANA.id, ANA.id)?.groupId).toBe(s.group.id);
  expect(h.edits().at(-1)!.payload.chat_id).toBe(ANA.id);
  const open = h.buttons().find(b => b.text === 'Open to split')!;
  const url = new URL(webhookUrl ? open.web_app!.url : open.url!);
  expect(decodeLaunch(url.searchParams.get('startapp')!, h.config.linkSecret)).toEqual({ groupId: s.group.id, linkVersion: s.group.linkVersion, view: 'expense', expenseId: draft.id });
  if (webhookUrl) { expect(url.origin).toBe('https://trip.example'); expect(url.searchParams.get('existing')).toBe('1'); }
  expect(notices(h)).toHaveLength(1);
  expect(notices(h)[0]!.payload.text).toBe('Ana added a receipt to approve: Casa Pepe, 84.50 SGD');
  const groupButton = (notices(h)[0]!.payload.reply_markup as { inline_keyboard: Button[][] }).inline_keyboard[0]![0]!;
  expect(groupButton.text).toBe('Open'); expect(groupButton.url).toContain('https://t.me/');
  expect(decodeLaunch(new URL(groupButton.url!).searchParams.get('startapp')!, h.config.linkSecret).expenseId).toBe(draft.id);
  expect(h.notifier.expenseSaved).not.toHaveBeenCalled();
});

it('uses an existing agent group choice among several memberships', async () => {
  seed(); seedGroup(db, CHAT_B, 'Other trip'); rememberChosenGroup(db, s.asAna, ANA.id, NOW);
  const h = harness({ db }); await privatePhoto(h);
  expect(drafts()).toHaveLength(1); expect(privateReply(h)).toContain('For Test group');
  expect(h.readReceipt).toHaveBeenCalledOnce();
});

it('several groups: waits for selection, then consumes once and remembers the choice', async () => {
  seed(); seedGroup(db, CHAT_B, 'Other trip'); const h = harness({ db });
  await privatePhoto(h, 'Lunch');
  expect(h.sent().map(c => c.payload.text)).toEqual(['Which trip is this receipt for?']);
  expect(choices(h).map(b => b.text).sort()).toEqual(['Other trip', 'Test group']);
  expect(h.downloadPhoto).not.toHaveBeenCalled(); expect(h.readReceipt).not.toHaveBeenCalled();
  expect(countReceiptReads(db, s.group.id, NOW)).toBe(0);
  const data = choice(h, s.group.id);
  await Promise.all([h.tap(data, ANA, ANA.id), h.tap(data, ANA, ANA.id)]);
  expect(h.downloadPhoto).toHaveBeenCalledExactlyOnceWith('photo-large');
  expect(h.readReceipt).toHaveBeenCalledOnce(); expect(drafts()).toHaveLength(1); expect(notices(h)).toHaveLength(1);
  expect(drafts()[0]!.description).toBe('Lunch');
  expect(chosenGroup(db, ANA.id, ANA.id)?.groupId).toBe(s.group.id);
  await privatePhoto(h); expect(h.readReceipt).toHaveBeenCalledTimes(2);
});

it('expires pending receipts at ten minutes without reading or remembering', async () => {
  seed(); seedGroup(db, CHAT_B); const h = harness({ db }); await privatePhoto(h); const data = choice(h, s.group.id);
  setClockForTests(() => new Date(NOW.getTime() + 10 * 60_000));
  await h.tap(data, ANA, ANA.id);
  expect(h.answers().at(-1)!.payload).toMatchObject({ text: TEXT.pendingExpired, show_alert: true });
  expect(h.downloadPhoto).not.toHaveBeenCalled(); expect(chosenGroup(db, ANA.id, ANA.id)).toBeUndefined();
});

it('a stale button cannot consume a newer photo', async () => {
  seed(); seedGroup(db, CHAT_B); const h = harness({ db }); await privatePhoto(h, 'Old'); const old = choice(h, s.group.id);
  await privatePhoto(h, 'New'); const current = choice(h, s.group.id);
  await h.tap(old, ANA, ANA.id); expect(h.downloadPhoto).not.toHaveBeenCalled();
  await h.tap(current, ANA, ANA.id); expect(drafts()[0]!.description).toBe('New');
});

it.each(['outsider', 'merged', 'disallowed'])('rejects a %s group at selection time without reading', async kind => {
  seed(); seedGroup(db, CHAT_B); const h = harness({ db, allowed: [CHAT_A, CHAT_B] }); await privatePhoto(h);
  let data = choice(h, s.group.id);
  if (kind === 'outsider') { const other = seedGroup(db, -123, 'Not yours', 201); data = data.replace(/:\d+$/, `:${other.group.id}`); }
  // No operation merges a Telegram identity; model the stale membership state directly for the access check.
  if (kind === 'merged') db.prepare('UPDATE member SET active = 0, merged_into = ? WHERE id = ?').run(s.sam.id, s.ana.id);
  if (kind === 'disallowed') { const other = seedGroup(db, -123, 'Disabled'); data = data.replace(/:\d+$/, `:${other.group.id}`); }
  await h.tap(data, ANA, ANA.id);
  expect(h.answers().at(-1)!.payload.text).toBe('That group is not available.');
  expect(h.downloadPhoto).not.toHaveBeenCalled(); expect(h.readReceipt).not.toHaveBeenCalled();
});

it('a merged member is not offered a private group', async () => {
  seed(); db.prepare('UPDATE member SET active = 0, merged_into = ? WHERE id = ?').run(s.sam.id, s.ana.id);
  const h = harness({ db }); await privatePhoto(h);
  expect(privateReply(h)).toBe(TEXT.noGroup); expect(h.downloadPhoto).not.toHaveBeenCalled();
});

it('private /group works with receipts alone and clears a waiting photo', async () => {
  seed(); const other = seedGroup(db, CHAT_B, 'Other trip'); const h = harness({ db });
  await privatePhoto(h); const stale = choice(h, s.group.id);
  await h.command('/group'); expect(privateReply(h)).toBe('Which group do you mean?');
  await h.tap(`ag:g:${other.group.id}`, ANA, ANA.id);
  await h.tap(stale, ANA, ANA.id); expect(h.readReceipt).not.toHaveBeenCalled();
  await privatePhoto(h); expect(privateReply(h)).toContain('For Other trip');
});

it.each([ANA.id, CHAT_A])('approval from chat %s saves and sends the group notice exactly once', async chatId => {
  seed(); const h = harness({ db }); await privatePhoto(h); const data = splitEvenlyData(h);
  const other = seedGroup(db, CHAT_B, 'Other trip');
  rememberChosenGroup(db, other.asAna, ANA.id, NOW);
  await Promise.all([h.tap(data, ANA, chatId), h.tap(data, ANA, chatId)]);
  expect(drafts()[0]!.status).toBe('confirmed'); expect(notices(h)).toHaveLength(1);
  expect(h.notifier.expenseSaved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: CHAT_A, groupId: s.group.id, actorName: 'Ana', expenseId: drafts()[0]!.id, total: 8450 }));
  expect(h.edits().at(-1)!.payload.chat_id).toBe(chatId);
});

it('a private approval requires membership in the expense group', async () => {
  seed(); const other = seedGroup(db, CHAT_B, 'Not yours', 201);
  const draft = createExpense(db, other.asAna, dinner(other, { status: 'draft' }));
  const h = harness({ db }); await h.tap(`rcpt:${draft.id}:${draft.version}`, ANA, ANA.id);
  expect(h.answers().at(-1)!.payload.text).toBe(TEXT.tapNotFound);
  expect(getExpense(db, other.asAna, draft.id).status).toBe('draft'); expect(h.notifier.expenseSaved).not.toHaveBeenCalled();
});

it('cap reached: no private download or read', async () => {
  seed(); reserveReceiptRead(db, s.group.id, 1, NOW); const h = harness({ db, config: { receiptDailyCap: 1 } });
  await privatePhoto(h); expect(privateReply(h)).toBe(TEXT.limitReached);
  expect(h.downloadPhoto).not.toHaveBeenCalled(); expect(h.readReceipt).not.toHaveBeenCalled(); expect(notices(h)).toEqual([]);
});

it('bot senders and bot group-choice callbacks are ignored', async () => {
  seed(); const h = harness({ db }); await h.sendPhoto(undefined, OTHER_BOT, OTHER_BOT.id);
  await h.tap(`rcpt:g:1:${s.group.id}`, OTHER_BOT, OTHER_BOT.id);
  expect(h.calls).toEqual([]); expect(h.downloadPhoto).not.toHaveBeenCalled();
});

it('private duplicates, currency review and suggested rates use the existing pipeline', async () => {
  seed(); createExpense(db, s.asAna, dinner(s, { total: 8450, expenseDate: '2026-09-26' }));
  const h = harness({ db }); await privatePhoto(h); expect(privateReply(h)).toContain('This looks like one already added:');
  const foreign = harness({ db, reader: async () => reading({ currency: 'JPY', currency_certain: false }), suggestRate: async () => '112' });
  await privatePhoto(foreign);
  expect(privateReply(foreign)).toContain(TEXT.checkCurrency);
  expect(foreign.notifier.tripRateChanged).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: CHAT_A }));
  await foreign.tap(splitEvenlyData(foreign), ANA, ANA.id);
  expect(foreign.answers().at(-1)!.payload.text).toBe(TEXT.tapCurrency);
});

describe('image documents', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp'])('accepts a private %s file', async mime => {
    seed(); const h = harness({ db }); await h.sendDocument(mime, 'File receipt', ANA, ANA.id);
    expect(h.downloadPhoto).toHaveBeenCalledExactlyOnceWith('document');
    expect(drafts()[0]).toMatchObject({ receiptFileId: 'document', description: 'File receipt' });
  });
  it.each([undefined, 'Lunch', '@tripsplitter_test_bot Lunch'])('group document with caption %s uses mention gating', async caption => {
    seed(); const h = harness({ db }); await h.sendDocument('image/png', caption);
    if (caption?.startsWith('@')) { expect(h.readReceipt).toHaveBeenCalledOnce(); expect(drafts()[0]!.description).toBe('Lunch'); }
    else { expect(h.downloadPhoto).not.toHaveBeenCalled(); expect(h.calls).toEqual([]); }
  });
  it('uses the Telegram JPEG preview for HEIC and retains the original receipt reference', async () => {
    seed(); const h = harness({ db });
    await h.sendDocument('image/heic', undefined, ANA, ANA.id, { thumbnail: { file_id: 'jpeg-preview', file_unique_id: 'thumb', width: 320, height: 320 } });
    expect(h.downloadPhoto).toHaveBeenCalledExactlyOnceWith('jpeg-preview');
    expect(h.readReceipt).toHaveBeenCalledOnce(); expect(drafts()[0]!.receiptFileId).toBe('document');
  });
  it('asks for a readable HEIC upload when Telegram supplies no preview', async () => {
    seed(); const h = harness({ db }); await h.sendDocument('image/heic', undefined, ANA, ANA.id);
    expect(privateReply(h)).toBe(TEXT.heicPreviewMissing); expect(h.downloadPhoto).not.toHaveBeenCalled(); expect(h.readReceipt).not.toHaveBeenCalled();
  });
  it('keeps the 20 MiB limit for image documents', async () => {
    seed(); const h = harness({ db }); await h.sendDocument('image/png', undefined, ANA, ANA.id, { file_size: 20 * 1024 * 1024 + 1 });
    expect(privateReply(h)).toBe(TEXT.unavailable); expect(h.downloadPhoto).not.toHaveBeenCalled(); expect(h.readReceipt).not.toHaveBeenCalled();
  });
  it('ignores non-image documents', async () => {
    seed(); const h = harness({ db }); await h.sendDocument('application/pdf', undefined, ANA, ANA.id);
    expect(h.calls).toEqual([]); expect(h.downloadPhoto).not.toHaveBeenCalled();
  });
});

it('selection and approval continue if Telegram cannot acknowledge or edit their messages', async () => {
  seed(); seedGroup(db, CHAT_B); const h = harness({ db }); await privatePhoto(h);
  const data = choice(h, s.group.id);
  h.failing.add('answerCallbackQuery'); h.failing.add('editMessageText');
  await h.tap(data, ANA, ANA.id);
  expect(h.readReceipt).toHaveBeenCalledOnce(); expect(notices(h)).toHaveLength(1);
  const draft = drafts()[0]!;
  await h.tap(`rcpt:${draft.id}:${draft.version}`, ANA, ANA.id);
  expect(drafts()[0]!.status).toBe('confirmed');
  expect(h.notifier.expenseSaved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: CHAT_A }));
  expect(h.errors.join(' ')).not.toContain('Ana');
});
it('pending selection is bound to the sender and private chat', async () => {
  seed(); seedGroup(db, CHAT_B); const h = harness({ db }); await privatePhoto(h);
  const data = choice(h, s.group.id);
  await h.tap(data, { id: 102, is_bot: false, first_name: 'Sam' }, 102);
  await h.tap(data, ANA, CHAT_A);
  expect(h.readReceipt).not.toHaveBeenCalled();
  await h.tap(data, ANA, ANA.id); expect(h.readReceipt).toHaveBeenCalledOnce();
});
