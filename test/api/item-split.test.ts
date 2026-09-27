import { describe, expect, it } from 'vitest';
import { createExpense, endTrip, getExpense, listTrips } from '../../src/db/index.js';
import { countActivity, dinner, fingerprint } from '../db/helpers.js';
import { dinnerBody, harness, type Harness } from './helpers.js';

// The amounts expected here were worked out by hand, not with the code under test.

const PREVIEW = '/api/expenses/preview';

/**
 * Casa Pepe: Paella x2 32.00 for Ana and Sam, Beer 4.50 for Sam, Bread 3.00 for everyone,
 * tax 3.95 on top, tip 5.00. Total 48.45, paid by Ana.
 *
 * Items: Ana 16.00 + 1.00 = 17.00, Sam 16.00 + 4.50 + 1.00 = 21.50, Leo 1.00. Sum 39.50.
 * Tax and tip, 8.95, in proportion: Ana 3.85 (3.8518), Sam 4.87 (4.8715), Leo 0.22 (0.2265).
 * That is 48.44, and the cent left over goes to Ana, who paid.
 */
function casaPepe(h: Harness, over: Record<string, unknown> = {}): Record<string, unknown> {
  const { ana, sam, leo } = h.a;
  return dinnerBody(h.a, {
    total: 4845,
    tax: 395,
    taxIncluded: false,
    tip: 500,
    splitType: 'items',
    shares: [{ memberId: ana.id }, { memberId: sam.id }, { memberId: leo.id }],
    items: [
      { label: 'Paella', quantity: 2, amount: 3200, shares: [{ memberId: ana.id }, { memberId: sam.id }] },
      { label: 'Beer', amount: 450, shares: [{ memberId: sam.id }] },
      { label: 'Bread', amount: 300 },
    ],
    ...over,
  });
}

const casaPepeAmounts = (h: Harness) => ({ [h.a.ana.id]: 2086, [h.a.sam.id]: 2637, [h.a.leo.id]: 122 });

/** Runs a request that must leave the database exactly as it was. */
async function unchanged<T>(h: Harness, run: () => Promise<T>): Promise<T> {
  const before = fingerprint(h.db);
  const result = await run();
  expect(fingerprint(h.db)).toBe(before);
  expect(h.sent()).toEqual([]);
  return result;
}

describe('the preview of an item split', () => {
  it('gives each person\'s amount with an unassigned item, a shared item and a quantity of 2, and saves nothing', async () => {
    const h = harness();
    const reply = await unchanged(h, () => h.ana.post(PREVIEW, casaPepe(h)));
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ amounts: casaPepeAmounts(h), problems: [], difference: null });
    expect((await h.ana.get(`/api/trips/${h.a.trip.id}/expenses`)).body.expenses).toEqual([]);
  });

  it('does not multiply the amount of an item by its quantity', async () => {
    const h = harness();
    const items = (quantity: number) => (casaPepe(h).items as Array<Record<string, unknown>>).map((item, i) => (i === 0 ? { ...item, quantity } : item));
    const one = await h.ana.post(PREVIEW, casaPepe(h, { items: items(1) }));
    const five = await h.ana.post(PREVIEW, casaPepe(h, { items: items(5) }));
    expect(one.body).toEqual({ amounts: casaPepeAmounts(h), problems: [], difference: null });
    expect(five.body).toEqual(one.body);
  });

  it('matches what a create and a save then store', async () => {
    const h = harness();
    const preview = await h.ana.post(PREVIEW, casaPepe(h));

    // Entered by hand and created through POST.
    const created = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, casaPepe(h));
    expect(created.status).toBe(201);
    const expense = created.body.expense;
    expect(expense).toMatchObject({ status: 'confirmed', splitType: 'items', total: 4845, tax: 395, taxIncluded: false, tip: 500, problems: [] });
    expect(expense.amounts).toEqual(preview.body.amounts);
    expect(expense.amounts).toEqual(casaPepeAmounts(h));
    expect(expense.items.map((i: { label: string; quantity: number; amount: number }) => [i.label, i.quantity, i.amount])).toEqual([
      ['Paella', 2, 3200],
      ['Beer', 1, 450],
      ['Bread', 1, 300],
    ]);
    const [paella, beer, bread] = expense.items as Array<{ id: number }>;
    const assigned = (itemId: number) => expense.shares.filter((s: { itemId: number | null }) => s.itemId === itemId).map((s: { memberId: number }) => s.memberId);
    expect(assigned(paella!.id)).toEqual([h.a.ana.id, h.a.sam.id]);
    expect(assigned(beer!.id)).toEqual([h.a.sam.id]);
    expect(assigned(bread!.id)).toEqual([]);
    expect(h.sent()).toEqual(['expenseSaved']);
    expect(h.notices[0]!.notice).toMatchObject({ splitType: 'items', total: 4845 });
    expect(h.notices[0]!.notice.shares).toEqual([
      { name: 'Ana', amount: 2086n },
      { name: 'Sam', amount: 2637n },
      { name: 'Leo', amount: 122n },
    ]);

    // Saved through PUT with the beer moved to Leo: Ana 17.00, Sam 17.00, Leo 5.50 before tax and tip.
    // 8.95 in proportion: Ana 3.85 (3.8518), Sam 3.85, Leo 1.24 (1.2462). One cent is left for Ana.
    const moved = casaPepe(h);
    (moved.items as Array<Record<string, unknown>>)[1]!.shares = [{ memberId: h.a.leo.id }];
    const again = await unchanged(h, () => {
      h.clear();
      return h.ana.post(PREVIEW, moved);
    });
    expect(again.body.amounts).toEqual({ [h.a.ana.id]: 2086, [h.a.sam.id]: 2085, [h.a.leo.id]: 674 });
    const saved = await h.sam.put(`/api/expenses/${expense.id}`, { ...moved, version: expense.version });
    expect(saved.status).toBe(200);
    expect(saved.body.expense.amounts).toEqual(again.body.amounts);
    expect((await h.ana.get(`/api/expenses/${expense.id}`)).body.expense.amounts).toEqual(again.body.amounts);
  });

  it('adds tax that is not in the prices, and leaves out tax that is', async () => {
    const h = harness();
    const { ana, sam, leo } = h.a;
    // Tax already in the prices, with a service charge. Paid by Sam.
    // Items: Ana 21.50; 9.95 between Sam and Leo is 4.97 each and the cent goes to Sam, the lower ID.
    // Service charge 3.14 in proportion to 21.50, 4.98 and 4.97: 2.14 (2.1465), 0.49 (0.4972), 0.49 (0.4962).
    // That is 34.57 of 34.59, so 2 cents are left for Sam, who paid.
    const included = dinnerBody(h.a, {
      payerId: sam.id,
      total: 3459,
      tax: 280,
      taxIncluded: true,
      serviceCharge: 314,
      splitType: 'items',
      items: [
        { label: 'Steak', amount: 2150, shares: [{ memberId: ana.id }] },
        { label: 'Pizza', amount: 995, shares: [{ memberId: sam.id }, { memberId: leo.id }] },
      ],
    });
    const expected = { [ana.id]: 2364, [sam.id]: 549, [leo.id]: 546 };
    const preview = await unchanged(h, () => h.ana.post(PREVIEW, included));
    expect(preview.body).toEqual({ amounts: expected, problems: [], difference: null });
    const created = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, included);
    expect(created.status).toBe(201);
    expect(created.body.expense).toMatchObject({ tax: 280, taxIncluded: true, serviceCharge: 314, amounts: expected });

    // The same figures with the tax not in the prices are 2.80 short.
    const notIncluded = await h.ana.post(PREVIEW, { ...included, taxIncluded: false });
    expect(notIncluded.body).toMatchObject({ amounts: null, difference: -280 });
    const onTop = await h.ana.post(PREVIEW, casaPepe(h, { taxIncluded: true }));
    expect(onTop.body).toMatchObject({ amounts: null, difference: 395 });
  });

  it('takes a discount off in proportion', async () => {
    const h = harness();
    const { ana, sam, leo } = h.a;
    // Paid by Leo, who is not included. Items: Ana 20.00, Sam 10.01. Discount 5.00 in proportion:
    // Ana 3.33 (3.3322), Sam 1.66 (1.6677), both rounded toward zero, which gives 16.67 and 8.35.
    // That is 25.02 of 25.01, and the cent too many is taken from Ana, the lowest ID.
    const body = dinnerBody(h.a, {
      payerId: leo.id,
      total: 2501,
      discount: 500,
      splitType: 'items',
      shares: [{ memberId: ana.id }, { memberId: sam.id }],
      items: [
        { label: 'Set lunch', amount: 2000, shares: [{ memberId: ana.id }] },
        { label: 'Noodles', amount: 1001, shares: [{ memberId: sam.id }] },
      ],
    });
    const expected = { [ana.id]: 1666, [sam.id]: 835 };
    const preview = await unchanged(h, () => h.ana.post(PREVIEW, body));
    expect(preview.body).toEqual({ amounts: expected, problems: [], difference: null });
    const created = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, body);
    expect(created.body.expense).toMatchObject({ discount: 500, amounts: expected });
  });

  it('reports a total that is more than the items explain as a positive difference', async () => {
    const h = harness();
    const preview = await unchanged(h, () => h.ana.post(PREVIEW, casaPepe(h, { total: 5000 })));
    expect(preview.status).toBe(200);
    expect(preview.body.amounts).toBeNull();
    expect(preview.body.difference).toBe(155);
    expect(preview.body.problems).toEqual([expect.objectContaining({ field: 'total', code: 'total_mismatch', difference: 155 })]);

    const refused = await unchanged(h, () => h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, casaPepe(h, { total: 5000 })));
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('invalid_expense');
    expect(refused.body.error.problems).toEqual(preview.body.problems);
  });

  it('reports a total that is less than the items explain as a negative difference', async () => {
    const h = harness();
    const preview = await unchanged(h, () => h.ana.post(PREVIEW, casaPepe(h, { total: 4800 })));
    expect(preview.status).toBe(200);
    expect(preview.body.amounts).toBeNull();
    expect(preview.body.difference).toBe(-45);
    expect(preview.body.problems).toEqual([expect.objectContaining({ field: 'total', code: 'total_mismatch', difference: -45 })]);

    const refused = await unchanged(h, () => h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, casaPepe(h, { total: 4800 })));
    expect(refused.status).toBe(400);
    expect(refused.body.error.problems).toEqual(preview.body.problems);
  });

  it('refuses items that are all zero when there is a tip', async () => {
    const h = harness();
    const body = dinnerBody(h.a, { total: 500, tip: 500, splitType: 'items', items: [{ label: 'Water', amount: 0 }, { label: 'Bread', amount: 0 }] });
    const preview = await unchanged(h, () => h.ana.post(PREVIEW, body));
    expect(preview.status).toBe(200);
    expect(preview.body.amounts).toBeNull();
    expect(preview.body.problems).toEqual([expect.objectContaining({ field: 'items', code: 'zero_items_with_adjustments' })]);

    const created = await unchanged(h, () => h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, body));
    expect(created.status).toBe(400);
    expect(created.body.error.code).toBe('invalid_expense');
    expect(created.body.error.problems.map((p: { code: string }) => p.code)).toEqual(['zero_items_with_adjustments']);

    const draft = createExpense(h.db, h.a.asAna, dinner(h.a, { status: 'draft' }));
    const saved = await unchanged(h, () => h.ana.put(`/api/expenses/${draft.id}`, { ...body, version: 1, confirm: true }));
    expect(saved.status).toBe(400);
    expect(saved.body.error.code).toBe('invalid_expense');
  });

  it('reports the other problems of a split: no items, nobody included', async () => {
    const h = harness();
    const noItems = await h.ana.post(PREVIEW, casaPepe(h, { items: [] }));
    expect(noItems.body).toMatchObject({ amounts: null, difference: null });
    expect(noItems.body.problems.map((p: { code: string }) => p.code)).toEqual(['no_items']);
    const nobody = await h.ana.post(PREVIEW, casaPepe(h, { shares: [], items: [{ label: 'Bread', amount: 3950 }] }));
    expect(nobody.body.problems.map((p: { field: string; code: string }) => [p.field, p.code])).toEqual([['shares', 'no_members']]);
  });

  it('refuses an item assigned to a member who is not included in the expense', async () => {
    const h = harness();
    const { ana, sam, leo } = h.a;
    const body = casaPepe(h, { shares: [{ memberId: ana.id }, { memberId: sam.id }] });
    (body.items as Array<Record<string, unknown>>)[1]!.shares = [{ memberId: leo.id }];

    const preview = await unchanged(h, () => h.ana.post(PREVIEW, body));
    expect(preview.status).toBe(400);
    expect(preview.body.error.code).toBe('invalid_input');
    expect(preview.body.error.message).toBe('A person assigned to an item must be included in the expense.');

    // A create and a save refuse it with the same words.
    const created = await unchanged(h, () => h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, body));
    expect([created.status, created.body.error]).toEqual([400, preview.body.error]);
    const draft = createExpense(h.db, h.a.asAna, dinner(h.a, { status: 'draft' }));
    const saved = await unchanged(h, () => h.ana.put(`/api/expenses/${draft.id}`, { ...body, version: 1 }));
    expect([saved.status, saved.body.error]).toEqual([400, preview.body.error]);
  });

  it('refuses a member of another group, wherever the member is named', async () => {
    const h = harness();
    const stranger = h.b.sam.id;
    const withItem = casaPepe(h);
    (withItem.items as Array<Record<string, unknown>>)[1]!.shares = [{ memberId: stranger }];
    const bodies = [
      casaPepe(h, { shares: [{ memberId: h.a.ana.id }, { memberId: stranger }] }),
      casaPepe(h, { payerId: stranger }),
      withItem,
      casaPepe(h, { payerId: 999999 }),
    ];
    for (const body of bodies) {
      const preview = await unchanged(h, () => h.ana.post(PREVIEW, body));
      expect(preview.status).toBe(400);
      expect(preview.body.error.code).toBe('member_not_in_group');
      // Exactly what a create says.
      const created = await unchanged(h, () => h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, body));
      expect([created.status, created.body.error]).toEqual([400, preview.body.error]);
    }
    // The members of the other group can use their own.
    const theirs = h.as(202, 'Sam', h.launch(h.b));
    const own = await theirs.post(PREVIEW, dinnerBody(h.b, { total: 900, splitType: 'items', items: [{ label: 'Satay', amount: 900, shares: [{ memberId: stranger }] }] }));
    expect(own.body.amounts).toEqual({ [h.b.ana.id]: 0, [h.b.sam.id]: 900, [h.b.leo.id]: 0 });
  });

  it('checks the figures as a save does', async () => {
    const h = harness();
    for (const over of [{ tip: -1 }, { total: -5 }, { currency: 'EUR' }, { expenseDate: 'yesterday' }, { items: [{ label: 'Beer', amount: -450 }] }, { items: [{ label: 'Beer', amount: 450, quantity: 0 }] }]) {
      const preview = await unchanged(h, () => h.ana.post(PREVIEW, casaPepe(h, over)));
      const created = await unchanged(h, () => h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, { ...casaPepe(h, over), status: 'draft' }));
      expect(created.status).toBe(400);
      expect([preview.status, preview.body]).toEqual([400, created.body]);
    }
    const shapeless = await h.ana.post(PREVIEW, { total: 'ten' });
    expect(shapeless.status).toBe(400);
    expect(shapeless.body.error.code).toBe('invalid_input');
    expect((await h.ana.post(PREVIEW)).status).toBe(400);
  });

  it('changes nothing: no expense, no activity, no trip, no rate lookup, no notice, no used ID', async () => {
    const h = harness();
    const activity = countActivity(h.db);
    for (let i = 0; i < 3; i++) await unchanged(h, () => h.ana.post(PREVIEW, casaPepe(h)));
    await unchanged(h, () => h.ana.post(PREVIEW, casaPepe(h, { currency: 'JPY' })));
    expect(countActivity(h.db)).toBe(activity);
    expect(h.rateLookups).toEqual([]);
    const first = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, casaPepe(h));
    expect(first.body.expense.id).toBe(1);
    expect(first.body.expense.items.map((i: { id: number }) => i.id)).toEqual([1, 2, 3]);

    // With no active trip a preview still answers, and does not start one.
    endTrip(h.db, h.a.asAna, h.a.trip.id);
    h.clear();
    const preview = await unchanged(h, () => h.ana.post(PREVIEW, casaPepe(h)));
    expect(preview.body.amounts).toEqual(casaPepeAmounts(h));
    expect(listTrips(h.db, h.a.asAna).map((t) => t.status)).toEqual(['ended']);
  });

  it('needs a sign-in and a link like every other route', async () => {
    const h = harness();
    const reply = await h.app.request(PREVIEW, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(casaPepe(h)) });
    expect(reply.status).toBe(401);
  });

  it('is not taken for an expense called "preview"', async () => {
    const h = harness();
    expect((await h.ana.get(PREVIEW)).status).toBe(404);
    expect((await h.ana.put(PREVIEW, { ...casaPepe(h), version: 1 })).status).toBe(404);
  });
});

describe('a receipt draft', () => {
  /** What the receipt reader leaves behind: the items of the receipt, nobody assigned, split evenly for now. */
  function receiptDraft(h: Harness) {
    const body = casaPepe(h);
    return createExpense(h.db, h.a.asSam, {
      ...dinner(h.a),
      status: 'draft',
      payerId: h.a.sam.id,
      description: '',
      total: 4845,
      tax: 395,
      tip: 500,
      splitType: 'even',
      receiptFileId: 'telegram-file-1',
      items: (body.items as Array<{ label: string; quantity?: number; amount: number }>).map(({ label, quantity, amount }) => ({ label, amount, ...(quantity ? { quantity } : {}) })),
    });
  }

  it('is confirmed after its items were assigned', async () => {
    const h = harness();
    const draft = receiptDraft(h);
    expect(draft).toMatchObject({ status: 'draft', splitType: 'even' });

    // Same receipt as above, paid by Sam, so the cent left over goes to Sam.
    const expected = { [h.a.ana.id]: 2085, [h.a.sam.id]: 2638, [h.a.leo.id]: 122 };
    const assigned = { ...casaPepe(h, { payerId: h.a.sam.id, description: '' }) };
    const preview = await unchanged(h, () => h.ana.post(PREVIEW, assigned));
    expect(preview.body.amounts).toEqual(expected);

    const saved = await h.ana.put(`/api/expenses/${draft.id}`, { ...assigned, version: draft.version });
    expect(saved.status).toBe(200);
    expect(saved.body.expense).toMatchObject({ status: 'draft', splitType: 'items', version: 2, receiptFileId: 'telegram-file-1', amounts: expected, problems: [] });
    expect(h.sent()).toEqual([]);

    const confirmed = await h.ana.post(`/api/expenses/${draft.id}/confirm`, { version: 2 });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.expense).toMatchObject({ status: 'confirmed', splitType: 'items', receiptFileId: 'telegram-file-1', amounts: expected });
    expect(h.sent()).toEqual(['expenseSaved']);
    expect(h.notices[0]!.notice).toMatchObject({ actorName: 'Ana', description: 'Casa Pepe', splitType: 'items' });
    expect(getExpense(h.db, h.a.asAna, draft.id).shares.filter((s) => s.itemId !== null)).toHaveLength(3);

    const balances = await h.ana.get(`/api/trips/${h.a.trip.id}/balances`);
    expect(balances.body.balances).toEqual({ [h.a.ana.id]: -2085, [h.a.sam.id]: 4845 - 2638, [h.a.leo.id]: -122 });
  });

  it('is assigned and confirmed in one step, or not at all', async () => {
    const h = harness();
    const draft = receiptDraft(h);
    const assigned = casaPepe(h, { payerId: h.a.sam.id });

    const refused = await unchanged(h, () => h.ana.put(`/api/expenses/${draft.id}`, { ...assigned, total: 4900, version: 1, confirm: true }));
    expect(refused.status).toBe(400);
    expect(refused.body.error.problems).toEqual([expect.objectContaining({ code: 'total_mismatch', difference: 55 })]);

    const done = await h.ana.put(`/api/expenses/${draft.id}`, { ...assigned, version: 1, confirm: true });
    expect(done.status).toBe(200);
    expect(done.body.expense).toMatchObject({ status: 'confirmed', splitType: 'items', amounts: { [h.a.ana.id]: 2085, [h.a.sam.id]: 2638, [h.a.leo.id]: 122 } });
    expect(h.sent()).toEqual(['expenseSaved']);
  });

  it('cannot be confirmed while its figures do not add up', async () => {
    const h = harness();
    const draft = receiptDraft(h);
    const saved = await h.ana.put(`/api/expenses/${draft.id}`, { ...casaPepe(h, { total: 4000 }), version: 1 });
    expect(saved.status).toBe(200);
    expect(saved.body.expense).toMatchObject({ status: 'draft', amounts: null });
    const refused = await unchanged(h, () => h.ana.post(`/api/expenses/${draft.id}/confirm`, { version: 2 }));
    expect(refused.status).toBe(400);
    expect(refused.body.error.problems).toEqual([expect.objectContaining({ code: 'total_mismatch', difference: -845 })]);
  });
});
