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
