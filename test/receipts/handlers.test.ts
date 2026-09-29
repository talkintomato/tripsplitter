import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeLaunch } from '../../src/core/index.js';
import {
  changeHomeCurrency,
  confirmExpense,
  countReceiptReads,
  createExpense,
  deleteExpense,
  discardExpense,
  endTrip,
  getExpense,
  getTrip,
  listExpenses,
  listTripRates,
  listTrips,
  openDatabase,
  reserveReceiptRead,
  saveExpense,
  setClockForTests,
  setMemberActive,
  setTripRate,
  type Db,
  type ExpenseDetail,
} from '../../src/db/index.js';
import { ReceiptReadError, TEXT } from '../../src/receipts/index.js';
import { dinner, fingerprint, seedGroup, seedTwo, type Seed } from '../db/helpers.js';
import { ANA, CHAT_A, CHAT_B, harness, NOW, OTHER_BOT, reading, SAM, splitEvenlyData, TODAY } from './harness.js';

let db: Db;
let s: Seed;

beforeEach(() => {
  setClockForTests(() => NOW);
  db = openDatabase(':memory:');
  s = seedGroup(db);
});

afterEach(() => {
  setClockForTests(null);
});

const expenseCount = (database: Db = db) => (database.prepare('SELECT COUNT(*) AS n FROM expense').get() as { n: number }).n;
const allExpenses = (): ExpenseDetail[] =>
  listTrips(db, s.asAna).flatMap((trip) => listExpenses(db, s.asAna, trip.id, { status: ['draft', 'confirmed', 'discarded', 'deleted'] }));
const onlyExpense = (): ExpenseDetail => {
  const all = allExpenses();
  expect(all).toHaveLength(1);
  return all[0]!;
};
const jpy = (over = {}) =>
  reading({ merchant: 'Ichiran', currency: 'JPY', total: '1200', items: [{ label: 'Ramen', quantity: 1, amount: '1200' }], ...over });

describe('outcomes', () => {
  it('total found and items add up: a draft with items', async () => {
    const h = harness({ db });
    await h.sendPhoto('@tripsplitter_test_bot dinner with everyone');

    const draft = onlyExpense();
    expect(draft).toMatchObject({
      status: 'draft',
      splitType: 'even',
      payerId: s.ana.id,
      createdBy: s.ana.id,
      merchant: 'Casa Pepe',
      description: 'dinner with everyone',
      expenseDate: '2026-09-26',
      total: 8450,
      currency: 'SGD',
      currencyNeedsReview: false,
      fxRateSource: 'home',
      taxIncluded: false,
      receiptFileId: 'photo-large',
    });
    expect(draft.items.map((i) => [i.label, i.quantity, i.amount])).toEqual([
      ['Paella', 1, 6000],
      ['Beer', 2, 1600],
      ['Water', 1, 850],
    ]);
    expect(draft.shares.filter((x) => x.itemId === null).map((x) => x.memberId).sort()).toEqual([s.ana.id, s.sam.id, s.leo.id].sort());

    expect(h.sent().map((c) => c.payload.text)).toEqual([TEXT.reading]);
    expect(h.finalText()).toBe('<b>✅ Approve Casa Pepe</b>\n\nTotal: 84.50 SGD\nPaid by Ana\n3 items');
    expect(h.edits()).toHaveLength(1);
    expect(h.edits()[0]!.payload.parse_mode).toBe('HTML');
    expect(h.edits()[0]!.payload.message_id).toBe(h.sentIds[0]);
    expect(h.sent()[0]!.payload.reply_parameters).toMatchObject({ message_id: expect.any(Number) });

    const [split, open] = h.buttons();
    expect(split).toMatchObject({ text: 'Split evenly', callback_data: `rcpt:${draft.id}:${draft.version}` });
    expect(Buffer.byteLength(split!.callback_data!, 'utf8')).toBeLessThanOrEqual(64);
    expect(open!.text).toBe('Open to split');
    const param = new URL(open!.url!).searchParams.get('startapp')!;
    expect(decodeLaunch(param, h.config.linkSecret)).toEqual({ groupId: s.group.id, linkVersion: s.group.linkVersion, view: 'expense', expenseId: draft.id });
  });

  it('total found and items do not add up: a draft with the total and no items', async () => {
    const h = harness({ db, reader: async () => reading({ total: '90.00' }) });
    await h.sendPhoto('@tripsplitter_test_bot');

    const draft = onlyExpense();
    expect(draft).toMatchObject({ status: 'draft', total: 9000, splitType: 'even' });
    expect(draft.items).toEqual([]);
    expect(h.finalText()).toBe(`<b>✅ Approve Casa Pepe</b>\n\nTotal: 90.00 SGD\nPaid by Ana\n⚠️ ${TEXT.itemsDropped}`);
    expect(h.buttons().map((b) => b.text)).toEqual(['Split evenly', 'Open to split']);
  });

  it('no total found: a message, no expense and no file ID stored', async () => {
    const h = harness({ db, reader: async () => reading({ total: null }) });
    await h.sendPhoto('@tripsplitter_test_bot');

    expect(h.finalText()).toBe(TEXT.unreadable);
    expect(h.buttons()).toEqual([]);
    expect(expenseCount()).toBe(0);
    expect(fingerprint(db)).not.toContain('photo-large');
  });

  it('not a receipt: a message, no expense and no file ID stored', async () => {
    const h = harness({ db, reader: async () => reading({ is_receipt: false }) });
    await h.sendPhoto('@tripsplitter_test_bot');

    expect(h.finalText()).toBe(TEXT.unreadable);
    expect(expenseCount()).toBe(0);
    expect(fingerprint(db)).not.toContain('photo-large');
  });

  it('network error after the retry: a message, no expense and no file ID stored', async () => {
    const h = harness({
      db,
      reader: async () => {
        throw new ReceiptReadError('network', 'down');
      },
    });
    await h.sendPhoto('@tripsplitter_test_bot');

    expect(h.readReceipt).toHaveBeenCalledTimes(2);
    expect(h.finalText()).toBe(TEXT.unavailable);
    expect(expenseCount()).toBe(0);
    expect(fingerprint(db)).not.toContain('photo-large');
  });

  it('a model error that is not a network or rate limit error is not retried', async () => {
    const h = harness({
      db,
      reader: async () => {
        throw new ReceiptReadError('invalid_response', 'bad');
      },
    });
    await h.sendPhoto('@tripsplitter_test_bot');

    expect(h.readReceipt).toHaveBeenCalledTimes(1);
    expect(countReceiptReads(db, s.group.id, NOW)).toBe(1);
    expect(h.finalText()).toBe(TEXT.unavailable);
    expect(expenseCount()).toBe(0);
  });

  it('a failed download gives the error message without a model call', async () => {
    const h = harness({ db });
    h.downloadPhoto.mockRejectedValueOnce(new Error('no'));
    await h.sendPhoto('@tripsplitter_test_bot');

    expect(h.readReceipt).not.toHaveBeenCalled();
    expect(h.finalText()).toBe(TEXT.unavailable);
    expect(expenseCount()).toBe(0);
  });

  it('uses the Singapore date of the message when the receipt has none', async () => {
    const h = harness({ db, reader: async () => reading({ date: null }) });
    await h.sendPhoto('@tripsplitter_test_bot');
    expect(onlyExpense().expenseDate).toBe(TODAY);
  });

  it('takes tax_included from the model', async () => {
    const h = harness({
      db,
      reader: async () => reading({ tax: '5.53', tax_included: true }),
    });
    await h.sendPhoto('@tripsplitter_test_bot');
    const draft = onlyExpense();
    expect(draft).toMatchObject({ tax: 553, taxIncluded: true, total: 8450 });
    expect(draft.items).toHaveLength(3);
  });

  it('leaves inactive members out of the split', async () => {
    setMemberActive(db, s.asAna, s.leo.id, false);
    const h = harness({ db });
    await h.sendPhoto('@tripsplitter_test_bot');
    expect(onlyExpense().shares.map((x) => x.memberId).sort()).toEqual([s.ana.id, s.sam.id].sort());
  });

  it('a trip ended while the model was reading: the draft goes to a new trip', async () => {
    const h = harness({
      db,
      reader: async () => {
        endTrip(db, s.asSam, s.trip.id);
        return reading();
      },
    });
    await h.sendPhoto('@tripsplitter_test_bot');

    const draft = onlyExpense();
    expect(draft.tripId).not.toBe(s.trip.id);
    expect(getTrip(db, s.asAna, draft.tripId).status).toBe('active');
    expect(h.finalText()).toContain('<b>✅ Approve Casa Pepe</b>\n\nTotal: 84.50 SGD');
  });
});

describe('trigger', () => {
  it('a photo whose caption mentions the bot', async () => {
    const h = harness({ db });
    await h.sendPhoto('Lunch @TripSplitter_Test_Bot at the beach');

    expect(h.downloadPhoto).toHaveBeenCalledExactlyOnceWith('photo-large');
    expect(h.readReceipt).toHaveBeenCalledTimes(1);
    expect(h.readReceipt.mock.calls[0]![0].mediaType).toBe('image/jpeg');
    expect(onlyExpense().description).toBe('Lunch at the beach');
    expect(h.passedOn).toHaveLength(0);
  });

  it('a message mentioning the bot in reply to a photo', async () => {
    const h = harness({ db });
    await h.sendReplyToPhoto('@tripsplitter_test_bot taxi to the airport', SAM);

    expect(h.downloadPhoto).toHaveBeenCalledExactlyOnceWith('photo-large');
    const draft = onlyExpense();
    expect(draft).toMatchObject({ description: 'taxi to the airport', payerId: s.sam.id, createdBy: s.sam.id, receiptFileId: 'photo-large' });
    expect(h.finalText()).toContain('Paid by Sam');
  });

  it('an untagged photo is ignored without a download', async () => {
    const h = harness({ db });
    const before = fingerprint(db);
    await h.sendPhoto(undefined);
    await h.sendPhoto('look at this view');
    await h.sendPhoto('thanks @someone_else and @tripsplitter_test_bot_2');
    await h.sendReplyToPhoto('nice one');

    expect(h.downloadPhoto).not.toHaveBeenCalled();
    expect(h.readReceipt).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    expect(fingerprint(db)).toBe(before);
    expect(h.passedOn).toHaveLength(4);
  });

  it('a mention without any photo is left to other handlers', async () => {
    const h = harness({ db });
    await h.sendText('@tripsplitter_test_bot hello');
    expect(h.calls).toEqual([]);
    expect(h.passedOn).toHaveLength(1);
  });

  it('a chat that is not allowed is ignored', async () => {
    const h = harness({ db, allowed: [CHAT_B] });
    const before = fingerprint(db);
    await h.sendPhoto('@tripsplitter_test_bot');

    expect(h.downloadPhoto).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    expect(fingerprint(db)).toBe(before);
  });

  it('a photo tagged by a bot is ignored', async () => {
    const h = harness({ db });
    const before = fingerprint(db);
    await h.sendPhoto('@tripsplitter_test_bot', OTHER_BOT);

    expect(h.downloadPhoto).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    expect(fingerprint(db)).toBe(before);
  });
});

describe('daily cap', () => {
  it('refused at the limit', async () => {
    const h = harness({ db, config: { receiptDailyCap: 2 } });
    expect(reserveReceiptRead(db, s.group.id, 2, NOW)).toBe(true);
    expect(reserveReceiptRead(db, s.group.id, 2, NOW)).toBe(true);
    await h.sendPhoto('@tripsplitter_test_bot');

    expect(h.sent().map((c) => c.payload.text)).toEqual([TEXT.limitReached]);
    expect(h.edits()).toEqual([]);
    expect(h.downloadPhoto).not.toHaveBeenCalled();
    expect(h.readReceipt).not.toHaveBeenCalled();
    expect(countReceiptReads(db, s.group.id, NOW)).toBe(2);
    expect(expenseCount()).toBe(0);
  });

  it('one read uses one reservation, kept whatever the outcome', async () => {
    const h = harness({ db, reader: async () => reading({ is_receipt: false }) });
    await h.sendPhoto('@tripsplitter_test_bot');
    expect(countReceiptReads(db, s.group.id, NOW)).toBe(1);
  });

  it('a retry uses a second reservation', async () => {
    let attempt = 0;
    const h = harness({
      db,
      reader: async () => {
        attempt += 1;
        if (attempt === 1) throw new ReceiptReadError('rate_limit', 'slow down');
        return reading();
      },
    });
    await h.sendPhoto('@tripsplitter_test_bot');

    expect(h.readReceipt).toHaveBeenCalledTimes(2);
    expect(h.downloadPhoto).toHaveBeenCalledTimes(1);
    expect(countReceiptReads(db, s.group.id, NOW)).toBe(2);
    expect(onlyExpense().total).toBe(8450);
    expect(h.finalText()).toContain('<b>✅ Approve Casa Pepe</b>\n\nTotal: 84.50 SGD');
  });

  it('a retry refused at the limit is the error outcome', async () => {
    const h = harness({
      db,
      config: { receiptDailyCap: 1 },
      reader: async () => {
        throw new ReceiptReadError('network', 'down');
      },
    });
    await h.sendPhoto('@tripsplitter_test_bot');

    expect(h.readReceipt).toHaveBeenCalledTimes(1);
    expect(countReceiptReads(db, s.group.id, NOW)).toBe(1);
    expect(h.finalText()).toBe(TEXT.unavailable);
    expect(expenseCount()).toBe(0);
  });
});

describe('no key configured', () => {
  it('replies that receipt reading is not set up', async () => {
    const h = harness({ db, reader: null, config: { openaiApiKey: undefined } });
    await h.sendPhoto('@tripsplitter_test_bot');

    expect(h.sent().map((c) => c.payload.text)).toEqual([TEXT.notSetUp]);
    expect(TEXT.notSetUp).toBe("Receipt reading isn't set up. Tap Add expense to enter it by hand.");
    expect(h.downloadPhoto).not.toHaveBeenCalled();
    expect(countReceiptReads(db, s.group.id, NOW)).toBe(0);
    expect(expenseCount()).toBe(0);
  });
});

describe('amounts', () => {
  it('an item with quantity 2 keeps its line total', async () => {
    const h = harness({
      db,
      reader: async () => reading({ items: [{ label: 'Beer', quantity: 2, amount: '16.00' }], total: '16.00' }),
    });
    await h.sendPhoto('@tripsplitter_test_bot');

    const draft = onlyExpense();
    expect(draft.total).toBe(1600);
    expect(draft.items.map((i) => [i.label, i.quantity, i.amount])).toEqual([['Beer', 2, 1600]]);
    expect(h.finalText()).toContain('Total: 16.00 SGD\nPaid by Ana\n1 item');
  });

  it('a negative line is moved into the discount', async () => {
    const h = harness({
      db,
      reader: async () =>
        reading({
          items: [
            { label: 'Paella', quantity: 1, amount: '60.00' },
            { label: 'Voucher', quantity: 1, amount: '-10.00' },
            { label: 'Beer', quantity: 2, amount: '16.00' },
          ],
          discount: '2.00',
          total: '64.00',
        }),
    });
    await h.sendPhoto('@tripsplitter_test_bot');

    const draft = onlyExpense();
    expect(draft.discount).toBe(1200);
    expect(draft.items.map((i) => [i.label, i.amount])).toEqual([
      ['Paella', 6000],
      ['Beer', 1600],
    ]);
    expect(h.finalText()).toContain('Total: 64.00 SGD\nPaid by Ana\n2 items');
    expect(h.finalText()).not.toContain(TEXT.itemsDropped);
  });

  it('minor units for SGD', async () => {
    const h = harness({ db });
    await h.sendPhoto('@tripsplitter_test_bot');
    expect(onlyExpense()).toMatchObject({ currency: 'SGD', total: 8450 });
  });

  it('minor units for JPY', async () => {
    const h = harness({ db, reader: async () => jpy() });
    await h.sendPhoto('@tripsplitter_test_bot');
    const draft = onlyExpense();
    expect(draft).toMatchObject({ currency: 'JPY', total: 1200 });
    expect(draft.items.map((i) => i.amount)).toEqual([1200]);
    expect(h.finalText()).toContain('<b>✅ Approve Ichiran</b>\n\nTotal: 1,200 JPY\nPaid by Ana\n1 item');
  });
});

describe('currency', () => {
  it('supported and certain: that currency', async () => {
    const h = harness({ db, reader: async () => reading({ currency: 'MYR', currency_certain: true }), suggestRate: async () => '3.3' });
    await h.sendPhoto('@tripsplitter_test_bot');
    expect(onlyExpense()).toMatchObject({ currency: 'MYR', currencyNeedsReview: false, total: 8450 });
    expect(h.finalText()).not.toContain(TEXT.checkCurrency);
  });

  it('supported and not certain: that currency, to be reviewed', async () => {
    const h = harness({ db, reader: async () => reading({ currency: 'USD', currency_certain: false }), suggestRate: async () => '0.78' });
    await h.sendPhoto('@tripsplitter_test_bot');
    expect(onlyExpense()).toMatchObject({ currency: 'USD', currencyNeedsReview: true, total: 8450 });
    expect(h.finalText().split('\n')).toContain(TEXT.checkCurrency);
  });

  it('not shown: home currency, to be reviewed', async () => {
    const h = harness({ db, reader: async () => reading({ currency: null, currency_certain: false }) });
    await h.sendPhoto('@tripsplitter_test_bot');
    expect(onlyExpense()).toMatchObject({ currency: 'SGD', currencyNeedsReview: true, total: 8450, fxRateSource: 'home' });
    expect(h.finalText().split('\n')).toContain(TEXT.checkCurrency);
  });

  it('not supported: home currency, to be reviewed, and the message names what was printed', async () => {
    const h = harness({ db, reader: async () => reading({ currency: 'CHF', currency_certain: true }) });
    await h.sendPhoto('@tripsplitter_test_bot');
    const draft = onlyExpense();
    expect(draft).toMatchObject({ currency: 'SGD', currencyNeedsReview: true, total: 8450, fxRateSource: 'home' });
    expect(draft.items).toHaveLength(3);
    expect(h.finalText().split('\n')).toContain("⚠️ The receipt shows CHF, which isn't supported, so SGD is used. Change it if it’s wrong.");
  });

  it('not supported, with decimals, in a trip whose home currency has none', async () => {
    changeHomeCurrency(db, s.asAna, s.trip.id, 'JPY');
    const h = harness({
      db,
      reader: async () =>
        reading({
          currency: 'CHF',
          items: [
            { label: 'Paella', quantity: 1, amount: '60.00' },
            { label: 'Beer', quantity: 2, amount: '24.50' },
          ],
          total: '84.50',
        }),
    });
    await h.sendPhoto('@tripsplitter_test_bot');

    const draft = onlyExpense();
    expect(draft).toMatchObject({ currency: 'JPY', currencyNeedsReview: true, total: 85, fxRateSource: 'home' });
    expect(draft.items.map((i) => i.amount)).toEqual([60, 25]);
    expect(h.finalText()).toContain('<b>✅ Approve Casa Pepe</b>\n\nTotal: 85 JPY\nPaid by Ana\n2 items');
    expect(h.finalText()).toContain('The receipt shows CHF');
  });
});

describe('rate', () => {
  it('a foreign receipt with no trip rate gives a draft with source missing that Split evenly refuses', async () => {
    const h = harness({ db, reader: async () => jpy(), suggestRate: async () => null });
    await h.sendPhoto('@tripsplitter_test_bot');

    const draft = onlyExpense();
    expect(draft).toMatchObject({ status: 'draft', currency: 'JPY', fxRateSource: 'missing', fxRate: null });
    expect(h.suggestRate).toHaveBeenCalledExactlyOnceWith('SGD', 'JPY');
    expect(h.finalText().split('\n')).toContain(`⚠️ ${TEXT.rateMissing}`);
    expect(listTripRates(db, s.asAna, s.trip.id)).toEqual([]);

    const before = fingerprint(db);
    await h.tap(splitEvenlyData(h));
    expect(h.suggestRate).toHaveBeenCalledTimes(2);
    expect(h.answers().at(-1)!.payload.text).toBe(TEXT.tapRateMissing);
    expect(fingerprint(db)).toBe(before);
    expect(h.notifier.expenseSaved).not.toHaveBeenCalled();
    expect(h.notifier.tripRateChanged).not.toHaveBeenCalled();
  });

  it('a foreign receipt with a trip rate gives a draft that Split evenly confirms', async () => {
    setTripRate(db, s.asSam, s.trip.id, 'JPY', '112.4', 'member');
    const h = harness({ db, reader: async () => jpy() });
    await h.sendPhoto('@tripsplitter_test_bot');

    const draft = onlyExpense();
    expect(draft).toMatchObject({ fxRateSource: 'trip', fxRate: '112.4' });
    expect(h.suggestRate).not.toHaveBeenCalled();
    expect(h.finalText()).not.toContain(`⚠️ ${TEXT.rateMissing}`);

    await h.tap(splitEvenlyData(h));
    expect(getExpense(db, s.asAna, draft.id).status).toBe('confirmed');
    expect(h.notifier.expenseSaved).toHaveBeenCalledTimes(1);
    expect(h.notifier.tripRateChanged).not.toHaveBeenCalled();
  });

  it('a suggested rate creates the trip rate and posts the notice', async () => {
    const h = harness({ db, reader: async () => jpy(), suggestRate: async () => '112.4' });
    await h.sendPhoto('@tripsplitter_test_bot');

    expect(h.suggestRate).toHaveBeenCalledExactlyOnceWith('SGD', 'JPY');
    expect(listTripRates(db, s.asAna, s.trip.id)).toMatchObject([{ currency: 'JPY', rate: '112.4', origin: 'suggested' }]);
    const draft = onlyExpense();
    expect(draft).toMatchObject({ status: 'draft', fxRateSource: 'trip', fxRate: '112.4' });
    expect(h.notifier.tripRateChanged).toHaveBeenCalledExactlyOnceWith({
      groupId: s.group.id, actorMemberId: s.ana.id, tripId: s.trip.id, tripName: s.trip.name, affectedMemberIds: [],
      chatId: CHAT_A,
      actorName: 'Ana',
      homeCurrency: 'SGD',
      currency: 'JPY',
      rate: '112.4',
      origin: 'suggested',
      expensesChanged: 1,
    });
    expect(h.finalText()).not.toContain(`⚠️ ${TEXT.rateMissing}`);
    // The button holds the version after the rate was set, so it still works.
    expect(splitEvenlyData(h)).toBe(`rcpt:${draft.id}:${draft.version}`);
    await h.tap(splitEvenlyData(h));
    expect(getExpense(db, s.asAna, draft.id).status).toBe('confirmed');
  });

  it('a lookup that throws leaves the draft missing a rate', async () => {
    const h = harness({
      db,
      reader: async () => jpy(),
      suggestRate: async () => {
        throw new Error('boom');
      },
    });
    await h.sendPhoto('@tripsplitter_test_bot');
    expect(onlyExpense().fxRateSource).toBe('missing');
    expect(h.finalText().split('\n')).toContain(`⚠️ ${TEXT.rateMissing}`);
  });
});

describe('Split evenly', () => {
  it('confirmed: the message is replaced and the notice is posted', async () => {
    const h = harness({ db });
    await h.sendPhoto('@tripsplitter_test_bot dinner');
    const draft = onlyExpense();
    await h.tap(splitEvenlyData(h), SAM);

    const saved = getExpense(db, s.asAna, draft.id);
    expect(saved).toMatchObject({ status: 'confirmed', payerId: s.ana.id, splitType: 'even' });
    expect(getTrip(db, s.asAna, s.trip.id).homeCurrencyLocked).toBe(true);
    expect(h.finalText()).toBe('<b>✅ Added Casa Pepe · 84.50 SGD</b>');
    expect(h.edits().at(-1)!.payload.parse_mode).toBe('HTML');
    const buttons = h.buttons();
    expect(buttons.map((b) => b.text)).toEqual(['Edit']);
    expect(decodeLaunch(new URL(buttons[0]!.url!).searchParams.get('startapp')!, h.config.linkSecret)).toMatchObject({ view: 'expense', expenseId: draft.id });
    expect(h.answers()).toHaveLength(1);
    expect(h.answers()[0]!.payload.text).toBeUndefined();

    expect(h.notifier.expenseSaved).toHaveBeenCalledTimes(1);
    const notice = (h.notifier.expenseSaved as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls[0]![0];
    expect(notice).toMatchObject({ chatId: CHAT_A, actorName: 'Sam', expenseId: draft.id, groupId: s.group.id, description: 'dinner', total: 8450, currency: 'SGD', splitType: 'even' });
    const shares = notice.shares as Array<{ name: string; amount: bigint }>;
    expect(shares.map((x) => x.name).sort()).toEqual(['Ana', 'Leo', 'Sam']);
    expect(shares.reduce((sum, x) => sum + BigInt(x.amount), 0n)).toBe(8450n);
  });

  it('version out of date: a draft edited after the message was posted', async () => {
    const h = harness({ db });
    await h.sendPhoto('@tripsplitter_test_bot');
    const draft = onlyExpense();
    const data = splitEvenlyData(h);
    saveExpense(db, s.asSam, draft.id, draft.version, {
      payerId: s.sam.id,
      expenseDate: draft.expenseDate,
      total: 9000,
      splitType: 'even',
      shares: [{ memberId: s.ana.id }, { memberId: s.sam.id }],
      merchant: draft.merchant,
    });
    const before = fingerprint(db);
    const editsBefore = h.edits().length;
    await h.tap(data);

    expect(h.answers().at(-1)!.payload.text).toBe('This draft was changed. Open it to see the latest.');
    expect(fingerprint(db)).toBe(before);
    expect(getExpense(db, s.asAna, draft.id).status).toBe('draft');
    expect(h.edits()).toHaveLength(editsBefore);
    expect(h.notifier.expenseSaved).not.toHaveBeenCalled();
  });

  it('already confirmed: a second tap', async () => {
    const h = harness({ db });
    await h.sendPhoto('@tripsplitter_test_bot');
    const data = splitEvenlyData(h);
    await h.tap(data);
    const before = fingerprint(db);
    const editsBefore = h.edits().length;
    await h.tap(data, SAM);

    expect(h.answers().at(-1)!.payload.text).toBe('Already handled.');
    expect(fingerprint(db)).toBe(before);
    expect(h.edits()).toHaveLength(editsBefore);
    expect(h.notifier.expenseSaved).toHaveBeenCalledTimes(1);
  });

  it('already discarded', async () => {
    const h = harness({ db });
    await h.sendPhoto('@tripsplitter_test_bot');
    const draft = onlyExpense();
    discardExpense(db, s.asSam, draft.id, draft.version);
    const before = fingerprint(db);
    await h.tap(splitEvenlyData(h));

    expect(h.answers().at(-1)!.payload.text).toBe('Already handled.');
    expect(fingerprint(db)).toBe(before);
    expect(h.notifier.expenseSaved).not.toHaveBeenCalled();
  });

  it('already deleted', async () => {
    const h = harness({ db });
    await h.sendPhoto('@tripsplitter_test_bot');
    const draft = onlyExpense();
    const confirmed = confirmExpense(db, s.asSam, draft.id, draft.version);
    deleteExpense(db, s.asSam, draft.id, confirmed.version);
    const before = fingerprint(db);
    await h.tap(splitEvenlyData(h));

    expect(h.answers().at(-1)!.payload.text).toBe('Already handled.');
    expect(fingerprint(db)).toBe(before);
  });

  it('a guessed currency does not hold back Split evenly: confirming accepts it', async () => {
    const h = harness({ db, reader: async () => reading({ currency: null, currency_certain: false }) });
    await h.sendPhoto('@tripsplitter_test_bot');
    await h.tap(splitEvenlyData(h));

    expect(onlyExpense()).toMatchObject({ status: 'confirmed', currencyNeedsReview: false });
  });

  it('rate missing, and the lookup now succeeds: the expense is confirmed', async () => {
    let rate: string | null = null;
    const h = harness({ db, reader: async () => jpy(), suggestRate: async () => rate });
    await h.sendPhoto('@tripsplitter_test_bot');
    const draft = onlyExpense();
    expect(draft.fxRateSource).toBe('missing');

    rate = '112.4';
    await h.tap(splitEvenlyData(h), SAM);

    expect(getExpense(db, s.asAna, draft.id)).toMatchObject({ status: 'confirmed', fxRateSource: 'trip', fxRate: '112.4' });
    expect(listTripRates(db, s.asAna, s.trip.id)).toMatchObject([{ currency: 'JPY', rate: '112.4', origin: 'suggested' }]);
    expect(h.notifier.tripRateChanged).toHaveBeenCalledExactlyOnceWith({
      groupId: s.group.id, actorMemberId: s.sam.id, tripId: s.trip.id, tripName: s.trip.name, affectedMemberIds: [],
      chatId: CHAT_A,
      actorName: 'Sam',
      homeCurrency: 'SGD',
      currency: 'JPY',
      rate: '112.4',
      origin: 'suggested',
      expensesChanged: 1,
    });
    expect(h.notifier.expenseSaved).toHaveBeenCalledTimes(1);
    expect(h.finalText()).toBe('<b>✅ Added Ichiran · 1,200 JPY</b>');
  });

  it('rate missing, and the lookup fails again', async () => {
    const h = harness({ db, reader: async () => jpy(), suggestRate: async () => null });
    await h.sendPhoto('@tripsplitter_test_bot');
    const before = fingerprint(db);
    await h.tap(splitEvenlyData(h));

    expect(h.answers().at(-1)!.payload.text).toBe("Couldn't look up an exchange rate. Tap Open to split to enter one.");
    expect(fingerprint(db)).toBe(before);
  });

  it('rate missing, and the draft changes during the lookup: nothing is stored', async () => {
    let draftId = 0;
    let calls = 0;
    const h = harness({
      db,
      reader: async () => jpy(),
      suggestRate: async () => {
        calls += 1;
        if (calls === 1) return null;
        const current = getExpense(db, s.asSam, draftId);
        saveExpense(db, s.asSam, draftId, current.version, {
          payerId: s.sam.id,
          expenseDate: current.expenseDate,
          total: 1300,
          splitType: 'even',
          shares: [{ memberId: s.sam.id }],
        });
        return '112.4';
      },
    });
    await h.sendPhoto('@tripsplitter_test_bot');
    draftId = onlyExpense().id;
    await h.tap(splitEvenlyData(h));

    expect(h.answers().at(-1)!.payload.text).toBe('This draft was changed. Open it to see the latest.');
    expect(getExpense(db, s.asAna, draftId)).toMatchObject({ status: 'draft', total: 1300, fxRateSource: 'missing' });
    expect(listTripRates(db, s.asAna, s.trip.id)).toEqual([]);
    expect(h.notifier.tripRateChanged).not.toHaveBeenCalled();
    expect(h.notifier.expenseSaved).not.toHaveBeenCalled();
  });

  it('trip ended', async () => {
    const h = harness({ db });
    await h.sendPhoto('@tripsplitter_test_bot');
    endTrip(db, s.asSam, s.trip.id);
    const before = fingerprint(db);
    await h.tap(splitEvenlyData(h));

    expect(h.answers().at(-1)!.payload.text).toBe('That trip has ended. Reopen it or add this to the new trip.');
    expect(fingerprint(db)).toBe(before);
    expect(onlyExpense().status).toBe('draft');
  });

  it('a tap by a bot is ignored', async () => {
    const h = harness({ db });
    await h.sendPhoto('@tripsplitter_test_bot');
    const before = fingerprint(db);
    const callsBefore = h.calls.length;
    await h.tap(splitEvenlyData(h), OTHER_BOT);

    expect(h.calls).toHaveLength(callsBefore);
    expect(fingerprint(db)).toBe(before);
    expect(onlyExpense().status).toBe('draft');
    expect(h.notifier.expenseSaved).not.toHaveBeenCalled();
  });

  it('a tap in a chat that is not allowed is ignored', async () => {
    const h = harness({ db, allowed: [CHAT_A] });
    await h.sendPhoto('@tripsplitter_test_bot');
    const before = fingerprint(db);
    const callsBefore = h.calls.length;
    await h.tap(splitEvenlyData(h), ANA, CHAT_B);

    expect(h.calls).toHaveLength(callsBefore);
    expect(fingerprint(db)).toBe(before);
  });

  it('button data that is not ours is left alone', async () => {
    const h = harness({ db });
    await h.tap('rcpt:1:2:3');
    await h.tap('other:1:1');
    expect(h.calls).toEqual([]);
    expect(h.passedOn).toHaveLength(2);
  });
});

describe('another group', () => {
  it('a button for an expense of another group changes nothing', async () => {
    const two = seedTwo();
    const theirs = createExpense(two.db, two.b.asAna, { ...dinner(two.b), status: 'draft' });
    const h = harness({ db: two.db });
    const before = fingerprint(two.db);

    // Ana of group A (Telegram user 101) taps in chat A a button that names the draft of group B.
    await h.tap(`rcpt:${theirs.id}:${theirs.version}`, ANA, CHAT_A);

    expect(fingerprint(two.db)).toBe(before);
    expect(getExpense(two.db, two.b.asAna, theirs.id).status).toBe('draft');
    expect(h.answers().at(-1)!.payload.text).toBe(TEXT.tapNotFound);
    expect(h.edits()).toEqual([]);
    expect(h.notifier.expenseSaved).not.toHaveBeenCalled();

    // The same button tapped in its own chat by a member of that group works.
    await h.tap(`rcpt:${theirs.id}:${theirs.version}`, { id: 201, is_bot: false, first_name: 'Ana' }, CHAT_B);
    expect(getExpense(two.db, two.b.asAna, theirs.id).status).toBe('confirmed');
  });
});

describe('duplicate warning', () => {
  it('names the expense already added, and still creates the draft', async () => {
    createExpense(db, s.asSam, dinner(s, { merchant: 'casa  PEPE', total: 8450, expenseDate: '2026-09-26', payerId: s.sam.id }));
    const h = harness({ db });
    await h.sendPhoto('@tripsplitter_test_bot');

    expect(allExpenses()).toHaveLength(2);
    expect(allExpenses().filter((e) => e.status === 'draft')).toHaveLength(1);
    expect(h.finalText().split('\n')).toContain('⚠️ This looks like one already added: casa  PEPE, 84.50 SGD, by Sam.');
  });

  it('says nothing when the date differs', async () => {
    createExpense(db, s.asSam, dinner(s, { merchant: 'Casa Pepe', total: 8450, expenseDate: '2026-09-20' }));
    const h = harness({ db });
    await h.sendPhoto('@tripsplitter_test_bot');
    expect(h.finalText()).not.toContain('already added');
  });
});

describe('what is kept', () => {
  it('nothing about the failure reaches the log but the kind of error', async () => {
    const h = harness({
      db,
      reader: async () => {
        throw new ReceiptReadError('network', 'secret detail');
      },
    });
    await h.sendPhoto('@tripsplitter_test_bot private words');
    expect(h.errors.join('\n')).not.toContain('private words');
    expect(h.errors.join('\n')).not.toContain(h.config.botToken);
  });
});
