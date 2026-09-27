import { describe, expect, it } from 'vitest';
import { RATE_MISSING_NOTICE } from '../../src/api/index.js';
import { createExpense, getExpense, getTrip, listTripRates, saveExpense, setTripRate } from '../../src/db/index.js';
import { countActivity, dinner, fingerprint, ramen } from '../db/helpers.js';
import { dinnerBody, harness } from './helpers.js';

describe('expenses', () => {
  it('creates a confirmed expense and returns each person\'s amount as plain numbers', async () => {
    const h = harness();
    const reply = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, dinnerBody(h.a));
    expect(reply.status).toBe(201);
    const { expense } = reply.body;
    expect(expense).toMatchObject({ status: 'confirmed', total: 1000, currency: 'SGD', homeCurrency: 'SGD', fxRateSource: 'home', version: 1, problems: [], notice: null });
    // The cent left over goes to the payer.
    expect(expense.amounts).toEqual({ [h.a.ana.id]: 334, [h.a.sam.id]: 333, [h.a.leo.id]: 333 });
    expect(expense.homeAmounts).toEqual(expense.amounts);
    expect(expense.homeTotal).toBe(1000);
    expect(reply.body).toMatchObject({ rateSet: null, keptAsDraft: false });

    const read = await h.sam.get(`/api/expenses/${expense.id}`);
    expect(read.status).toBe(200);
    expect(read.body.expense).toEqual(expense);
    expect(read.body.expense.shares).toHaveLength(3);
  });

  it('splits by portions', async () => {
    const h = harness();
    const reply = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, dinnerBody(h.a, {
      total: 900,
      splitType: 'portions',
      shares: [{ memberId: h.a.ana.id, weight: 2 }, { memberId: h.a.sam.id, weight: 1 }],
    }));
    expect(reply.status).toBe(201);
    expect(reply.body.expense.amounts).toEqual({ [h.a.ana.id]: 600, [h.a.sam.id]: 300 });
  });

  it('accepts items with their shares and the adjustment figures', async () => {
    const h = harness();
    const reply = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, dinnerBody(h.a, {
      total: 3300,
      tip: 300,
      splitType: 'items',
      shares: [{ memberId: h.a.ana.id }, { memberId: h.a.sam.id }],
      items: [
        { label: 'Paella', quantity: 2, amount: 2000, shares: [{ memberId: h.a.ana.id }] },
        { label: 'Bread', amount: 1000 },
      ],
    }));
    expect(reply.status).toBe(201);
    expect(reply.body.expense.items.map((i: { label: string }) => i.label)).toEqual(['Paella', 'Bread']);
    const amounts = reply.body.expense.amounts as Record<number, number>;
    expect(amounts[h.a.ana.id]! + amounts[h.a.sam.id]!).toBe(3300);
    expect(amounts[h.a.ana.id]).toBeGreaterThan(amounts[h.a.sam.id]!);
  });

  it('lists drafts and confirmed expenses, and filters by status', async () => {
    const h = harness();
    const c1 = createExpense(h.db, h.a.asAna, dinner(h.a));
    const d1 = createExpense(h.db, h.a.asAna, dinner(h.a, { status: 'draft', total: 0, shares: [] }));
    const all = await h.ana.get(`/api/trips/${h.a.trip.id}/expenses`);
    expect(all.body.expenses.map((e: { id: number }) => e.id).sort()).toEqual([c1.id, d1.id]);
    const drafts = await h.ana.get(`/api/trips/${h.a.trip.id}/expenses?status=draft`);
    expect(drafts.body.expenses.map((e: { id: number }) => e.id)).toEqual([d1.id]);
    expect(drafts.body.expenses[0].amounts).toBeNull();
    expect(drafts.body.expenses[0].problems.length).toBeGreaterThan(0);
    const both = await h.ana.get(`/api/trips/${h.a.trip.id}/expenses?status=deleted,discarded`);
    expect(both.body.expenses).toEqual([]);
    expect((await h.ana.get(`/api/trips/${h.a.trip.id}/expenses?status=nope`)).status).toBe(400);
  });

  it('saves the whole expense and finishes a draft in one step', async () => {
    const h = harness();
    const draft = createExpense(h.db, h.a.asAna, dinner(h.a, { status: 'draft', total: 0, shares: [] }));
    const refused = await h.ana.put(`/api/expenses/${draft.id}`, { ...dinnerBody(h.a, { total: 0 }), version: 1, confirm: true });
    expect(refused.status).toBe(400);
    expect(getExpense(h.db, h.a.asAna, draft.id)).toEqual(draft);

    const reply = await h.ana.put(`/api/expenses/${draft.id}`, { ...dinnerBody(h.a, { total: 1500 }), version: 1, confirm: true });
    expect(reply.status).toBe(200);
    expect(reply.body.expense).toMatchObject({ status: 'confirmed', total: 1500 });
    expect(h.sent()).toEqual(['expenseSaved']);
    expect(getTrip(h.db, h.a.asAna, h.a.trip.id).homeCurrencyLocked).toBe(true);
  });
});

describe('stale versions', () => {
  it('are refused on save, confirm, discard, delete and restore, with the current record', async () => {
    const h = harness();
    const stale = async (path: string, method: 'post' | 'put', body: Record<string, unknown>, id: number) => {
      const before = fingerprint(h.db);
      const reply = await h.ana[method](path, body);
      expect(reply.status).toBe(409);
      expect(reply.body.error).toMatchObject({ code: 'stale', entityType: 'expense' });
      expect(reply.body.error.message).toMatch(/changed by someone else/);
      const current = getExpense(h.db, h.a.asAna, id);
      expect(reply.body.error.current).toMatchObject({ id, version: current.version, total: current.total, status: current.status });
      expect(reply.body.error.current.homeCurrency).toBe('SGD');
      expect(fingerprint(h.db)).toBe(before);
    };

    // Sam changed each of them after Ana loaded version 1.
    const bump = (id: number) => saveExpense(h.db, h.a.asSam, id, 1, { ...dinner(h.a, { total: 2000 }) });
    const confirmed = createExpense(h.db, h.a.asAna, dinner(h.a));
    bump(confirmed.id);
    await stale(`/api/expenses/${confirmed.id}`, 'put', { ...dinnerBody(h.a, { total: 1100 }), version: 1 }, confirmed.id);
    await stale(`/api/expenses/${confirmed.id}/delete`, 'post', { version: 1 }, confirmed.id);

    const draft = createExpense(h.db, h.a.asAna, dinner(h.a, { status: 'draft' }));
    bump(draft.id);
    await stale(`/api/expenses/${draft.id}`, 'put', { ...dinnerBody(h.a), version: 1, confirm: true }, draft.id);
    await stale(`/api/expenses/${draft.id}/confirm`, 'post', { version: 1 }, draft.id);
    await stale(`/api/expenses/${draft.id}/discard`, 'post', { version: 1 }, draft.id);

    const gone = await h.sam.post(`/api/expenses/${confirmed.id}/delete`, { version: 2 });
    expect(gone.body.expense).toMatchObject({ status: 'deleted', version: 3 });
    await stale(`/api/expenses/${confirmed.id}/restore`, 'post', { version: 2 }, confirmed.id);

    h.clear();
    // A second tap on a button whose work is done is a plain refusal, not a stale edit.
    const twice = await h.ana.post(`/api/expenses/${confirmed.id}/delete`, { version: 3 });
    expect(twice.status).toBe(400);
    expect(twice.body.error.code).toBe('invalid_status');
    expect(h.sent()).toEqual([]);
  });

  it('are refused on undo and restore of a settlement', async () => {
    const h = harness();
    const made = await h.ana.post(`/api/trips/${h.a.trip.id}/settlements`, { fromMemberId: h.a.sam.id, toMemberId: h.a.ana.id, amount: 300 });
    const id = made.body.settlement.id;
    const wrong = await h.ana.post(`/api/settlements/${id}/undo`, { version: 7 });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toMatchObject({ code: 'stale', entityType: 'settlement', current: { id, version: 1, status: 'active' } });

    const undone = await h.ana.post(`/api/settlements/${id}/undo`, { version: 1 });
    expect(undone.body.settlement).toMatchObject({ status: 'undone', version: 2 });
    const before = fingerprint(h.db);
    const stale = await h.sam.post(`/api/settlements/${id}/restore`, { version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.current).toMatchObject({ id, version: 2, status: 'undone' });
    expect(fingerprint(h.db)).toBe(before);
    expect(h.sent()).toEqual(['settlementRecorded', 'settlementUndone']);
  });
});

describe('foreign currency', () => {
  it('shows a draft with its own amount, the rate and the converted amount', async () => {
    const h = harness();
    setTripRate(h.db, h.a.asAna, h.a.trip.id, 'JPY', '112.4', 'member');
    const draft = createExpense(h.db, h.a.asSam, ramen(h.a, { status: 'draft' }));
    const reply = await h.ana.get(`/api/expenses/${draft.id}`);
    expect(reply.body.expense).toMatchObject({ currency: 'JPY', total: 11240, fxRate: '112.4', fxRateSource: 'trip', homeCurrency: 'SGD', homeTotal: 10000, notice: null });
    const amounts = reply.body.expense.amounts as Record<number, number>;
    expect(Object.values(amounts).reduce((a, b) => a + b, 0)).toBe(11240);
    expect(Object.values(reply.body.expense.homeAmounts as Record<number, number>).reduce((a, b) => a + b, 0)).toBe(10000);
    expect(h.rateLookups).toEqual([]);
  });

  it('cannot confirm a draft with no rate', async () => {
    const h = harness();
    const created = await h.sam.post(`/api/trips/${h.a.trip.id}/expenses`, { ...dinnerBody(h.a, { currency: 'JPY', total: 11240 }), status: 'draft' });
    expect(created.status).toBe(201);
    expect(h.rateLookups).toEqual([['SGD', 'JPY']]);
    expect(created.body.expense).toMatchObject({ status: 'draft', fxRate: null, fxRateSource: 'missing', notice: RATE_MISSING_NOTICE, homeTotal: null });
    expect(created.body.expense.problems.map((p: { code: string }) => p.code)).toEqual(['rate_missing']);
    expect(created.body.rateSet).toBeNull();

    const before = fingerprint(h.db);
    const refused = await h.sam.post(`/api/expenses/${created.body.expense.id}/confirm`, { version: 1 });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('rate_missing');
    expect(refused.body.error.problems[0]).toMatchObject({ field: 'fxRate', code: 'rate_missing' });
    expect(fingerprint(h.db)).toBe(before);
    expect(h.sent()).toEqual([]);
  });

  it('keeps an expense as a draft when it was to be confirmed and no rate is found', async () => {
    const h = harness();
    const reply = await h.sam.post(`/api/trips/${h.a.trip.id}/expenses`, dinnerBody(h.a, { currency: 'JPY', total: 11240 }));
    expect(reply.status).toBe(201);
    expect(reply.body.keptAsDraft).toBe(true);
    expect(reply.body.expense).toMatchObject({ status: 'draft', fxRateSource: 'missing', notice: RATE_MISSING_NOTICE });
    expect(h.sent()).toEqual([]);
    expect(getTrip(h.db, h.a.asAna, h.a.trip.id).homeCurrencyLocked).toBe(false);

    const again = await h.sam.put(`/api/expenses/${reply.body.expense.id}`, { ...dinnerBody(h.a, { total: 11000 }), version: 1, confirm: true });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ keptAsDraft: true, expense: { status: 'draft', total: 11000, currency: 'JPY', version: 2 } });
    expect(h.sent()).toEqual([]);
  });

  it('looks up a rate, makes it the trip\'s rate and announces it once', async () => {
    const h = harness();
    h.rates.JPY = '112.4';
    const reply = await h.sam.post(`/api/trips/${h.a.trip.id}/expenses`, { ...dinnerBody(h.a, { currency: 'JPY', total: 11240 }), status: 'draft' });
    expect(reply.status).toBe(201);
    expect(reply.body.rateSet).toEqual({ currency: 'JPY', rate: '112.4', origin: 'suggested' });
    expect(reply.body.expense).toMatchObject({ status: 'draft', fxRate: '112.4', fxRateSource: 'trip', homeTotal: 10000, notice: null, problems: [] });
    expect(listTripRates(h.db, h.a.asAna, h.a.trip.id)).toMatchObject([{ currency: 'JPY', rate: '112.4', origin: 'suggested' }]);
    expect(h.notices).toEqual([
      { name: 'tripRateChanged', notice: { chatId: h.a.group.chatId, actorName: 'Sam', homeCurrency: 'SGD', currency: 'JPY', rate: '112.4', origin: 'suggested', expensesChanged: 1 } },
    ]);

    // The next expense in that currency uses the trip's rate without a lookup.
    h.clear();
    const second = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, dinnerBody(h.a, { currency: 'JPY', total: 1124 }));
    expect(second.body.expense).toMatchObject({ status: 'confirmed', fxRateSource: 'trip', homeTotal: 1000 });
    expect(h.rateLookups).toHaveLength(1);
    expect(h.sent()).toEqual(['expenseSaved']);
  });

  it('confirms straight away when the lookup finds a rate', async () => {
    const h = harness();
    h.rates.JPY = '112.4';
    const reply = await h.sam.post(`/api/trips/${h.a.trip.id}/expenses`, dinnerBody(h.a, { currency: 'JPY', total: 11240 }));
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ keptAsDraft: false, rateSet: { rate: '112.4' }, expense: { status: 'confirmed', fxRateSource: 'trip' } });
    expect(h.sent()).toEqual(['tripRateChanged', 'expenseSaved']);

    // A refused expense leaves no rate behind.
    const other = harness();
    other.rates.THB = '26.1';
    const before = fingerprint(other.db);
    const refused = await other.ana.post(`/api/trips/${other.a.trip.id}/expenses`, dinnerBody(other.a, { currency: 'THB', shares: [] }));
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('invalid_expense');
    expect(fingerprint(other.db)).toBe(before);
    expect(other.sent()).toEqual([]);
  });

  it('ignores a rate the lookup should not have returned, and a lookup that fails', async () => {
    const h = harness();
    h.rates.JPY = '-3';
    const bad = await h.sam.post(`/api/trips/${h.a.trip.id}/expenses`, dinnerBody(h.a, { currency: 'JPY' }));
    expect(bad.body).toMatchObject({ keptAsDraft: true, expense: { fxRateSource: 'missing' } });
    expect(listTripRates(h.db, h.a.asAna, h.a.trip.id)).toEqual([]);
    expect((await h.sam.post(`/api/trips/${h.a.trip.id}/expenses`, dinnerBody(h.a, { currency: 'EUR' }))).body.error.code).toBe('unsupported_currency');
  });

  it('never reads the rate or its source from a request', async () => {
    const h = harness();
    const reply = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, { ...dinnerBody(h.a, { currency: 'JPY' }), fxRate: '100', fxRateSource: 'trip', status: 'draft' });
    expect(reply.body.expense).toMatchObject({ fxRate: null, fxRateSource: 'missing' });
  });
});

describe('notices for expenses', () => {
  it('are sent once per change, and not for changes that have none', async () => {
    const h = harness();
    const path = `/api/trips/${h.a.trip.id}/expenses`;

    const draft = await h.ana.post(path, { ...dinnerBody(h.a), status: 'draft' });
    expect(h.sent()).toEqual([]);
    const savedDraft = await h.ana.put(`/api/expenses/${draft.body.expense.id}`, { ...dinnerBody(h.a, { total: 1200 }), version: 1 });
    expect(savedDraft.body.expense.version).toBe(2);
    expect(h.sent()).toEqual([]);
    const discarded = await h.ana.post(`/api/expenses/${draft.body.expense.id}/discard`, { version: 2 });
    const back = await h.ana.post(`/api/expenses/${draft.body.expense.id}/restore`, { version: discarded.body.expense.version });
    expect(back.body.expense.status).toBe('draft');
    expect(h.sent()).toEqual([]);

    await h.ana.post(`/api/expenses/${draft.body.expense.id}/confirm`, { version: back.body.expense.version });
    expect(h.sent()).toEqual(['expenseSaved']);
    expect(h.notices[0]!.notice).toMatchObject({
      chatId: h.a.group.chatId,
      groupId: h.a.group.id,
      actorName: 'Ana',
      expenseId: draft.body.expense.id,
      description: 'Dinner',
      total: 1200,
      currency: 'SGD',
      splitType: 'even',
    });
    expect(h.notices[0]!.notice.shares).toEqual([
      { name: 'Ana', amount: 400n },
      { name: 'Sam', amount: 400n },
      { name: 'Leo', amount: 400n },
    ]);

    h.clear();
    const created = await h.sam.post(path, dinnerBody(h.a, { description: '', merchant: 'Casa Pepe', total: 8450 }));
    expect(h.sent()).toEqual(['expenseSaved']);
    expect(h.notices[0]!.notice).toMatchObject({ actorName: 'Sam', description: 'Casa Pepe' });

    h.clear();
    const id = created.body.expense.id;
    const edited = await h.sam.put(`/api/expenses/${id}`, { ...dinnerBody(h.a, { description: '', total: 8850, payerId: h.a.sam.id }), version: 1 });
    expect(edited.status).toBe(200);
    expect(h.sent()).toEqual(['expenseEdited']);
    expect(h.notices[0]!.notice.changes).toEqual(['total 84.50 to 88.50 SGD', 'paid by Ana to Sam']);

    h.clear();
    const same = await h.sam.put(`/api/expenses/${id}`, { ...dinnerBody(h.a, { description: '', total: 8850, payerId: h.a.sam.id }), version: 2 });
    expect(same.status).toBe(200);
    expect(h.sent()).toEqual([]);

    const version = same.body.expense.version;
    const deleted = await h.ana.post(`/api/expenses/${id}/delete`, { version });
    expect(h.sent()).toEqual(['expenseDeleted']);
    await h.ana.post(`/api/expenses/${id}/restore`, { version: deleted.body.expense.version });
    expect(h.sent()).toEqual(['expenseDeleted', 'expenseRestored']);
    expect(h.notices[1]!.notice).toMatchObject({ actorName: 'Ana', expenseId: id, total: 8850 });
  });

  it('that fail leave the request successful', async () => {
    const h = harness();
    h.failNotices();
    const before = countActivity(h.db);
    const created = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, dinnerBody(h.a));
    expect(created.status).toBe(201);
    expect(getExpense(h.db, h.a.asAna, created.body.expense.id).status).toBe('confirmed');
    const paid = await h.ana.post(`/api/trips/${h.a.trip.id}/settlements`, { fromMemberId: h.a.sam.id, toMemberId: h.a.ana.id, amount: 300 });
    expect(paid.status).toBe(201);
    expect((await h.ana.post(`/api/trips/${h.a.trip.id}/end`)).status).toBe(200);
    expect((await h.ana.post('/api/group/reset-link')).status).toBe(200);
    expect((await h.as(999, 'New', h.launch(h.a)).get('/api/group')).status).toBe(200);
    expect(h.sent()).toEqual(['expenseSaved', 'settlementRecorded', 'tripEnded', 'linkReset', 'memberJoinedByLink']);
    expect(countActivity(h.db)).toBe(before + 5);
  });
});
