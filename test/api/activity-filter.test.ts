import { describe, expect, it } from 'vitest';
import { createExpense, createSettlement, saveExpense, setTripRate } from '../../src/db/index.js';
import { dinner, ramen, sameAs } from '../db/helpers.js';
import { harness } from './helpers.js';

describe("one record's activity", () => {
  it("lists only that expense's entries, newest first", async () => {
    const h = harness();
    const mine = createExpense(h.db, h.a.asAna, dinner(h.a));
    const other = createExpense(h.db, h.a.asAna, dinner(h.a, { description: 'Taxi' }));
    saveExpense(h.db, h.a.asSam, mine.id, 1, sameAs(h.a, dinner(h.a, { total: 1200 })));
    saveExpense(h.db, h.a.asSam, other.id, 1, sameAs(h.a, dinner(h.a, { description: 'Taxi', total: 900 })));

    const reply = await h.ana.get(`/api/activity?entityType=expense&entityId=${mine.id}`);
    expect(reply.status).toBe(200);
    expect(reply.body.entries.map((e: { action: string; entityId: number }) => [e.action, e.entityId])).toEqual([
      ['expense.save', mine.id],
      ['expense.create', mine.id],
    ]);
    expect(reply.body.entries[0]).toMatchObject({ actorName: 'Sam', before: { total: 1000 }, after: { total: 1200 } });
    expect(reply.body.nextBefore).toBeNull();
  });

  it('includes the entry a trip rate change wrote for the expense', async () => {
    const h = harness();
    setTripRate(h.db, h.a.asAna, h.a.trip.id, 'JPY', '100', 'member');
    const expense = createExpense(h.db, h.a.asSam, ramen(h.a));
    const rates = `/api/trips/${h.a.trip.id}/rates/JPY`;
    const preview = await h.ana.post(`${rates}/preview`, { rate: '112.4' });
    expect((await h.ana.put(rates, { rate: '112.4', snapshot: preview.body.snapshot })).status).toBe(200);

    const reply = await h.ana.get(`/api/activity?entityType=expense&entityId=${expense.id}`);
    expect(reply.body.entries.map((e: { action: string }) => e.action)).toEqual(['expense.rate_change', 'expense.create']);
    expect(reply.body.entries[0]).toMatchObject({ before: { fxRate: '100' }, after: { fxRate: '112.4' } });
  });

  it("lists a settlement's entries", async () => {
    const h = harness();
    const paid = createSettlement(h.db, h.a.asAna, { tripId: h.a.trip.id, fromMemberId: h.a.sam.id, toMemberId: h.a.ana.id, amount: 500 });
    await h.ana.post(`/api/settlements/${paid.id}/undo`, { version: paid.version });
    const reply = await h.ana.get(`/api/activity?entityType=settlement&entityId=${paid.id}`);
    expect(reply.body.entries.map((e: { action: string }) => e.action)).toEqual(['settlement.undo', 'settlement.create']);
  });

  it("is refused for another group's record, and without both parameters", async () => {
    const h = harness();
    const theirs = createExpense(h.db, h.b.asAna, dinner(h.b));
    const refused = await h.ana.get(`/api/activity?entityType=expense&entityId=${theirs.id}`);
    expect(refused.status).toBe(404);
    expect(refused.body.entries).toBeUndefined();

    const mine = createExpense(h.db, h.a.asAna, dinner(h.a));
    for (const query of [`entityId=${mine.id}`, 'entityType=expense', `entityType=trip&entityId=${mine.id}`, 'entityType=expense&entityId=abc']) {
      const reply = await h.ana.get(`/api/activity?${query}`);
      expect([query, reply.status, reply.body.error.code]).toEqual([query, 400, 'invalid_input']);
    }
  });

  it('comes in pages, like the whole list', async () => {
    const h = harness();
    const expense = createExpense(h.db, h.a.asAna, dinner(h.a));
    createExpense(h.db, h.a.asAna, dinner(h.a, { description: 'Other' }));
    for (let version = 1; version <= 55; version++) saveExpense(h.db, h.a.asAna, expense.id, version, sameAs(h.a, dinner(h.a, { total: 1000 + version })));
    const path = `/api/activity?entityType=expense&entityId=${expense.id}`;
    const first = await h.ana.get(path);
    expect(first.body.entries).toHaveLength(50);
    expect(first.body.nextBefore).toBe(first.body.entries[49].id);
    const second = await h.ana.get(`${path}&before=${first.body.nextBefore}`);
    expect(second.body.entries).toHaveLength(6);
    expect(second.body.entries.at(-1).action).toBe('expense.create');
    expect(second.body.nextBefore).toBeNull();
    expect([...first.body.entries, ...second.body.entries].every((e: { entityId: number }) => e.entityId === expense.id)).toBe(true);
  });
});

describe('filtering and paging the activity list', () => {
  function seed() {
    const h = harness();
    const taxi = createExpense(h.db, h.a.asAna, dinner(h.a, { description: 'Taxi' }));
    createExpense(h.db, h.a.asSam, dinner(h.a, { description: 'Lunch' }));
    createSettlement(h.db, h.a.asSam, { tripId: h.a.trip.id, fromMemberId: h.a.sam.id, toMemberId: h.a.ana.id, amount: 500 });
    saveExpense(h.db, h.a.asSam, taxi.id, 1, sameAs(h.a, dinner(h.a, { description: 'Taxi', total: 1500 })));
    return h;
  }
  const actions = (body: { entries: Array<{ action: string }> }) => body.entries.map((e) => e.action);

  it('shows only expenses, or only payments', async () => {
    const h = seed();
    const expenses = await h.ana.get('/api/activity?kind=expenses');
    expect(expenses.status).toBe(200);
    expect(actions(expenses.body)).toEqual(['expense.save', 'expense.create', 'expense.create']);
    const payments = await h.ana.get('/api/activity?kind=payments');
    expect(actions(payments.body)).toEqual(['settlement.create']);
  });

  it("the trip kind covers the trip, its rates and the group, and nothing else", async () => {
    const h = seed();
    setTripRate(h.db, h.a.asAna, h.a.trip.id, 'JPY', '112.4', 'member');
    const trip = await h.ana.get('/api/activity?kind=trip');
    expect(actions(trip.body).length).toBeGreaterThan(0);
    expect(actions(trip.body).every((a) => /^(trip|trip_rate|group)\./.test(a))).toBe(true);
    expect(actions(trip.body)).toContain('trip_rate.set');
  });

  it('shows only what one person did, and combines with a kind', async () => {
    const h = seed();
    const bySam = await h.ana.get(`/api/activity?actor=${h.a.sam.id}`);
    expect(bySam.body.entries.every((e: { actor: { kind: string; memberId?: number } }) => e.actor.kind === 'member' && e.actor.memberId === h.a.sam.id)).toBe(true);
    expect(actions(bySam.body)).toEqual(['expense.save', 'settlement.create', 'expense.create']);
    const samsExpenses = await h.ana.get(`/api/activity?actor=${h.a.sam.id}&kind=expenses`);
    expect(actions(samsExpenses.body)).toEqual(['expense.save', 'expense.create']);
  });

  it('pages by the given limit, with the filter kept across pages', async () => {
    const h = seed();
    const first = await h.ana.get('/api/activity?kind=expenses&limit=2');
    expect(actions(first.body)).toEqual(['expense.save', 'expense.create']);
    expect(first.body.nextBefore).toBe(first.body.entries[1].id);
    const second = await h.ana.get(`/api/activity?kind=expenses&limit=2&before=${first.body.nextBefore}`);
    expect(actions(second.body)).toEqual(['expense.create']);
    expect(second.body.nextBefore).toBeNull();
  });

  it('refuses an unknown kind and a limit outside 1 to 50', async () => {
    const h = seed();
    expect((await h.ana.get('/api/activity?kind=everything')).status).toBe(400);
    expect((await h.ana.get('/api/activity?limit=0')).status).toBe(400);
    expect((await h.ana.get('/api/activity?limit=51')).status).toBe(400);
  });

  it("a member of another group matches nothing", async () => {
    const h = seed();
    const reply = await h.ana.get(`/api/activity?actor=${h.b.ana.id}`);
    expect(reply.status).toBe(200);
    expect(reply.body.entries).toEqual([]);
  });
});
