import { describe, expect, it } from 'vitest';
import {
  createExpense,
  createSettlement,
  deleteExpense,
  discardExpense,
  endTrip,
  getActiveTrip,
  getOrCreateActiveTrip,
  getTrip,
  listActivity,
  listMembers,
  listTrips,
  undoSettlement,
  upsertTelegramMember,
} from '../../src/db/index.js';
import { countActivity, dinner, fingerprint } from '../db/helpers.js';
import { dinnerBody, harness } from './helpers.js';

describe('trips', () => {
  it('changes the home currency before the lock and refuses after it', async () => {
    const h = harness();
    const path = `/api/trips/${h.a.trip.id}`;
    const changed = await h.ana.patch(path, { homeCurrency: 'MYR' });
    expect(changed.status).toBe(200);
    expect(changed.body.trip).toMatchObject({ homeCurrency: 'MYR', homeCurrencyLocked: false });

    await h.ana.post(`${path}/expenses`, dinnerBody(h.a));
    expect((await h.ana.get(path)).body.trip.homeCurrencyLocked).toBe(true);
    const refused = await h.ana.patch(path, { homeCurrency: 'SGD' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('home_currency_locked');
    expect(getTrip(h.db, h.a.asAna, h.a.trip.id).homeCurrency).toBe('MYR');
    // Naming the currency it already has is not a change.
    expect((await h.ana.patch(path, { homeCurrency: 'MYR', name: 'Penang' })).status).toBe(200);
    expect(h.sent()).toEqual(['expenseSaved']);
  });

  it('changes nothing when one field of a change is not valid', async () => {
    const h = harness();
    const path = `/api/trips/${h.a.trip.id}`;
    const before = fingerprint(h.db);
    const reply = await h.ana.patch(path, { name: 'Osaka', homeCurrency: 'EUR', setupDone: true });
    expect(reply.status).toBe(400);
    expect(reply.body.error.code).toBe('unsupported_currency');
    expect(fingerprint(h.db)).toBe(before);

    const blank = await h.ana.patch(path, { homeCurrency: 'JPY', name: '   ' });
    expect(blank.status).toBe(400);
    expect(fingerprint(h.db)).toBe(before);
    expect((await h.ana.patch(path, { setupDone: false })).status).toBe(400);
    expect(fingerprint(h.db)).toBe(before);

    const all = await h.ana.patch(path, { name: 'Osaka', homeCurrency: 'JPY', setupDone: true });
    expect(all.status).toBe(200);
    expect(all.body.trip).toMatchObject({ name: 'Osaka', homeCurrency: 'JPY', setupDone: true });
    expect(h.sent()).toEqual([]);
  });

  it('ends, settles on the ended trip, refuses an expense on it, and reopens', async () => {
    const h = harness();
    const path = `/api/trips/${h.a.trip.id}`;
    const expense = createExpense(h.db, h.a.asAna, dinner(h.a));

    const ended = await h.ana.post(`${path}/end`);
    expect(ended.status).toBe(200);
    expect(ended.body.trip.status).toBe('ended');
    expect(h.notices).toEqual([{ name: 'tripEnded', notice: { chatId: h.a.group.chatId, actorName: 'Ana', tripName: h.a.trip.name } }]);
    expect((await h.ana.get('/api/group')).body.activeTrip).toBeNull();
    // Ending does not start a new trip.
    expect(listTrips(h.db, h.a.asAna)).toHaveLength(1);

    h.clear();
    const paid = await h.sam.post(`${path}/settlements`, { fromMemberId: h.a.sam.id, toMemberId: h.a.ana.id, amount: 333 });
    expect(paid.status).toBe(201);
    expect(paid.body.settlement).toMatchObject({ tripId: h.a.trip.id, amount: 333, status: 'active' });
    expect(h.notices).toEqual([
      { name: 'settlementRecorded', notice: { chatId: h.a.group.chatId, actorName: 'Sam', fromName: 'Sam', toName: 'Ana', amount: 333, currency: 'SGD' } },
    ]);
    const balances = await h.ana.get(`${path}/balances`);
    expect(balances.body.balances[h.a.sam.id]).toBe(0);
    expect(balances.body.settlements).toHaveLength(1);
    expect(balances.body.payments).toEqual([{ fromMemberId: h.a.leo.id, toMemberId: h.a.ana.id, amount: 333 }]);

    h.clear();
    const before = fingerprint(h.db);
    for (const reply of [
      await h.ana.post(`${path}/expenses`, dinnerBody(h.a)),
      await h.ana.put(`/api/expenses/${expense.id}`, { ...dinnerBody(h.a, { total: 5 }), version: 1 }),
      await h.ana.post(`/api/expenses/${expense.id}/delete`, { version: 1 }),
      await h.ana.patch(path, { name: 'Nope' }),
    ]) {
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe('trip_ended');
    }
    expect(fingerprint(h.db)).toBe(before);
    expect(h.sent()).toEqual([]);

    const reopened = await h.sam.post(`${path}/reopen`);
    expect(reopened.status).toBe(200);
    expect(reopened.body.trip.status).toBe('active');
    expect(h.sent()).toEqual(['tripReopened']);
    expect((await h.ana.post(`${path}/expenses`, dinnerBody(h.a))).status).toBe(201);
  });

  it('records a settlement against the ended trip while a newer trip is active', async () => {
    const h = harness();
    createExpense(h.db, h.a.asAna, dinner(h.a));
    endTrip(h.db, h.a.asAna, h.a.trip.id);
    const newer = getOrCreateActiveTrip(h.db, h.a.asAna).trip;
    expect(newer.id).not.toBe(h.a.trip.id);

    const paid = await h.sam.post(`/api/trips/${h.a.trip.id}/settlements`, { fromMemberId: h.a.sam.id, toMemberId: h.a.ana.id, amount: 333 });
    expect(paid.status).toBe(201);
    expect(paid.body.settlement.tripId).toBe(h.a.trip.id);
    expect((await h.ana.get(`/api/trips/${h.a.trip.id}/balances`)).body.settlements).toHaveLength(1);
    const other = await h.ana.get(`/api/trips/${newer.id}/balances`);
    expect(other.body.settlements).toEqual([]);
    expect(other.body.balances).toEqual({});

    // The ended trip cannot be reopened while the newer one is active.
    const refused = await h.ana.post(`/api/trips/${h.a.trip.id}/reopen`);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('active_trip_exists');
    expect(h.sent()).toEqual(['settlementRecorded']);
  });

  it('starts a trip when there is none, and only then', async () => {
    const h = harness();
    const refused = await h.ana.post('/api/trips', { name: 'Second' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('active_trip_exists');
    expect(getTrip(h.db, h.a.asAna, h.a.trip.id).name).toBe(h.a.trip.name);

    await h.ana.patch(`/api/trips/${h.a.trip.id}`, { homeCurrency: 'THB' });
    endTrip(h.db, h.a.asAna, h.a.trip.id);
    expect((await h.ana.get('/api/group')).body.newTripCurrency).toBe('THB');
    const bad = await h.ana.post('/api/trips', { name: 'Bali', homeCurrency: 'XXX' });
    expect(bad.status).toBe(400);
    expect(getActiveTrip(h.db, h.a.asAna)).toBeUndefined();

    const made = await h.ana.post('/api/trips');
    expect(made.status).toBe(201);
    expect(made.body.trip).toMatchObject({ status: 'active', homeCurrency: 'THB' });
    const trips = await h.ana.get('/api/trips');
    expect(trips.body.trips.map((t: { status: string }) => t.status)).toEqual(['active', 'ended']);
    expect(h.sent()).toEqual([]);
  });

  it('starts a trip first when an expense is added and the group has no active trip', async () => {
    const h = harness();
    endTrip(h.db, h.a.asAna, h.a.trip.id);
    const before = fingerprint(h.db);
    const refused = await h.ana.post('/api/trips/active/expenses', dinnerBody(h.a, { total: 0 }));
    expect(refused.status).toBe(400);
    // The trip is not left behind by an expense that was refused.
    expect(fingerprint(h.db)).toBe(before);

    const reply = await h.ana.post('/api/trips/active/expenses', dinnerBody(h.a));
    expect(reply.status).toBe(201);
    const active = getActiveTrip(h.db, h.a.asAna)!;
    expect(active.id).not.toBe(h.a.trip.id);
    expect(reply.body.expense.tripId).toBe(active.id);
    const second = await h.ana.post('/api/trips/active/expenses', dinnerBody(h.a));
    expect(second.body.expense.tripId).toBe(active.id);
    expect(listTrips(h.db, h.a.asAna)).toHaveLength(2);
  });
});

describe('claiming a member', () => {
  it('merges the hand-added member into the caller', async () => {
    const h = harness();
    const expense = createExpense(h.db, h.a.asAna, dinner(h.a, { payerId: h.a.leo.id, shares: [{ memberId: h.a.sam.id }, { memberId: h.a.leo.id }] }));
    const leonardo = h.as(104, 'Leonardo', h.launch(h.a));
    const me = (await leonardo.get('/api/group')).body.me;
    h.clear();

    const reply = await leonardo.post(`/api/members/${h.a.leo.id}/claim`, { memberId: h.a.sam.id });
    expect(reply.status).toBe(200);
    expect(reply.body.me).toMatchObject({ id: me.id, displayName: 'Leonardo' });
    expect(reply.body.members.map((m: { id: number }) => m.id)).not.toContain(h.a.leo.id);
    const after = await h.ana.get(`/api/expenses/${expense.id}`);
    expect(after.body.expense.payerId).toBe(me.id);
    expect(Object.keys(after.body.expense.amounts).map(Number).sort()).toEqual([h.a.sam.id, me.id].sort());
    expect(h.sent()).toEqual([]);

    const twice = await h.ana.post(`/api/members/${h.a.leo.id}/claim`);
    expect(twice.status).toBe(400);
    expect(twice.body.error.code).toBe('invalid_status');
    expect((await h.ana.post(`/api/members/${h.a.sam.id}/claim`)).body.error.code).toBe('invalid_status');
  });

  it('is refused when both are on the same expense, listing the expenses', async () => {
    const h = harness();
    const shared = createExpense(h.db, h.a.asAna, dinner(h.a));
    createExpense(h.db, h.a.asAna, dinner(h.a, { description: 'Fine', shares: [{ memberId: h.a.sam.id }, { memberId: h.a.leo.id }] }));
    const before = fingerprint(h.db);
    const reply = await h.ana.post(`/api/members/${h.a.leo.id}/claim`);
    expect(reply.status).toBe(400);
    expect(reply.body.error.code).toBe('claim_overlap');
    expect(reply.body.error.message).toMatch(/Remove one of the two/);
    expect(reply.body.error.expenses).toEqual([
      expect.objectContaining({ id: shared.id, tripId: h.a.trip.id, description: 'Dinner', total: 1000, currency: 'SGD', status: 'confirmed' }),
    ]);
    expect(fingerprint(h.db)).toBe(before);
  });

  it('is refused when it would change amounts, listing the expenses', async () => {
    const h = harness();
    const mia = upsertTelegramMember(h.db, h.a.asSystem, { telegramUserId: 105, displayName: 'Mia' }).member;
    const zoe = upsertTelegramMember(h.db, h.a.asSystem, { telegramUserId: 106, displayName: 'Zoe' }).member;
    const late = h.as(107, 'Late Leo', h.launch(h.a));
    await late.get('/api/group');
    const shifting = createExpense(h.db, h.a.asAna, dinner(h.a, { description: 'Cent', shares: [{ memberId: h.a.leo.id }, { memberId: mia.id }, { memberId: zoe.id }] }));

    const before = fingerprint(h.db);
    const reply = await late.post(`/api/members/${h.a.leo.id}/claim`);
    expect(reply.status).toBe(400);
    expect(reply.body.error.code).toBe('claim_changes_amounts');
    expect(reply.body.error.expenses.map((e: { id: number }) => e.id)).toEqual([shifting.id]);
    expect(reply.body.error.message.length).toBeGreaterThan(10);
    expect(fingerprint(h.db)).toBe(before);
  });

  it('adds a person by name', async () => {
    const h = harness();
    const reply = await h.ana.post('/api/members', { displayName: '  Mia  ', telegramUserId: 5, joinedVia: 'chat' });
    expect(reply.status).toBe(201);
    expect(reply.body.member).toMatchObject({ displayName: 'Mia', joinedVia: 'manual', telegramUserId: null, active: true });
    expect((await h.ana.post('/api/members', { displayName: ' ' })).status).toBe(400);
    expect((await h.ana.post('/api/members', {})).status).toBe(400);
    expect(listMembers(h.db, h.a.asAna)).toHaveLength(4);
    expect(h.sent()).toEqual([]);
  });
});

describe('activity', () => {
  it('restores each kind from its entry', async () => {
    const h = harness();
    const deleted = deleteExpense(h.db, h.a.asAna, createExpense(h.db, h.a.asAna, dinner(h.a)).id, 1);
    const discarded = discardExpense(h.db, h.a.asAna, createExpense(h.db, h.a.asAna, dinner(h.a, { status: 'draft' })).id, 1);
    const made = createSettlement(h.db, h.a.asAna, { tripId: h.a.trip.id, fromMemberId: h.a.sam.id, toMemberId: h.a.ana.id, amount: 300 });
    const undone = undoSettlement(h.db, h.a.asSam, made.id, 1);

    const list = await h.ana.get('/api/activity');
    const restorable = list.body.entries.filter((e: { restore: unknown }) => e.restore !== null);
    expect(restorable.map((e: { action: string; restore: unknown }) => [e.action, e.restore])).toEqual([
      ['settlement.undo', { kind: 'settlement', id: undone.id, version: undone.version }],
      ['expense.discard', { kind: 'expense', id: discarded.id, version: discarded.version }],
      ['expense.delete', { kind: 'expense', id: deleted.id, version: deleted.version }],
    ]);
    expect(list.body.entries[0]).toMatchObject({ actorName: 'Sam', entityType: 'settlement' });
    expect(list.body.entries.at(-1)).toMatchObject({ actorName: 'TripSplitter', actor: { kind: 'system' } });

    for (const entry of restorable) {
      const { kind, id, version } = entry.restore as { kind: string; id: number; version: number };
      const reply = await h.sam.post(`/api/${kind}s/${id}/restore`, { version });
      expect(reply.status).toBe(200);
    }
    expect((await h.ana.get(`/api/expenses/${deleted.id}`)).body.expense.status).toBe('confirmed');
    expect((await h.ana.get(`/api/expenses/${discarded.id}`)).body.expense.status).toBe('draft');
    expect((await h.ana.get(`/api/trips/${h.a.trip.id}/balances`)).body.settlements[0].status).toBe('active');
    // A deleted expense and a settlement are announced. A discarded draft coming back is not.
    expect(h.sent()).toEqual(['settlementRestored', 'expenseRestored']);

    const after = await h.ana.get('/api/activity');
    expect(after.body.entries.every((e: { restore: unknown }) => e.restore === null)).toBe(true);
    expect(after.body.entries.slice(0, 3).map((e: { action: string }) => e.action)).toEqual(['expense.restore', 'expense.restore', 'settlement.restore']);
  });

  it('comes in pages of 50, newest first', async () => {
    const h = harness();
    const start = countActivity(h.db, h.a.group.id);
    for (let i = 0; i < 120 - start; i += 1) createExpense(h.db, h.a.asAna, dinner(h.a, { description: `E${i}`, status: 'draft' }));
    const everything = listActivity(h.db, h.a.asAna, { limit: 200 }).map((e) => e.id);
    expect(everything).toHaveLength(120);

    const first = await h.ana.get('/api/activity');
    expect(first.body.entries).toHaveLength(50);
    expect(first.body.entries.map((e: { id: number }) => e.id)).toEqual(everything.slice(0, 50));
    expect(first.body.nextBefore).toBe(everything[49]);
    const second = await h.ana.get(`/api/activity?before=${first.body.nextBefore}`);
    expect(second.body.entries.map((e: { id: number }) => e.id)).toEqual(everything.slice(50, 100));
    const third = await h.ana.get(`/api/activity?before=${second.body.nextBefore}`);
    expect(third.body.entries.map((e: { id: number }) => e.id)).toEqual(everything.slice(100));
    expect(third.body.nextBefore).toBeNull();

    // Nothing of the other group, and a page of exactly 50 has no next page.
    expect(first.body.entries.every((e: { groupId: number }) => e.groupId === h.a.group.id)).toBe(true);
    const exact = await h.ana.get(`/api/activity?before=${everything[69]}`);
    expect(exact.body.entries).toHaveLength(50);
    expect(exact.body.nextBefore).toBeNull();

    const ofTrip = await h.ana.get(`/api/activity?tripId=${h.a.trip.id}`);
    expect(ofTrip.body.entries.every((e: { tripId: number }) => e.tripId === h.a.trip.id)).toBe(true);
    expect((await h.ana.get('/api/activity?before=abc')).status).toBe(400);
  });
});
