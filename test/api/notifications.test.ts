import { afterEach, expect, it } from 'vitest';
import { harness, type Harness } from './helpers.js';
import { getGroupNotificationSettings, getMyNotificationSettings } from '../../src/db/index.js';
const opened: Harness[] = [];
afterEach(() => opened.splice(0).forEach(h => h.db.close()));
function setup() { const h = harness(); opened.push(h); return h; }
it('reads defaults and allows any member to change group settings while personal settings belong only to the caller', async () => {
  const h = setup();
  const initial = await h.ana.get('/api/notifications');
  expect(initial.status).toBe(200);
  expect(initial.body.canMessageMe).toBeNull();
  expect(initial.body.botUsername).toBe(h.config.botUsername);
  expect(Object.values(initial.body.group)).toEqual(Array(7).fill(true));
  expect(Object.values(initial.body.personal)).toEqual(Array(5).fill(false));
  expect((await h.sam.put('/api/notifications/group/payment', { enabled: false })).status).toBe(200);
  expect((await h.ana.get('/api/notifications')).body.group.payment).toBe(false);
  expect((await h.ana.put('/api/notifications/personal/payments_me', { enabled: true })).status).toBe(200);
  expect((await h.ana.get('/api/notifications')).body.personal.payments_me).toBe(true);
  expect((await h.sam.get('/api/notifications')).body.personal.payments_me).toBe(false);
  expect(getGroupNotificationSettings(h.db, h.b.asAna).payment).toBe(true);
  expect(getMyNotificationSettings(h.db, h.b.asAna).payments_me).toBe(false);
});
it('rejects unknown types and malformed bodies and never accepts a target group or member', async () => {
  const h = setup();
  for (const kind of ['group', 'personal']) {
    expect((await h.ana.put(`/api/notifications/${kind}/unknown`, { enabled: true })).status).toBe(400);
    for (const body of [{}, { enabled: 'false' }, { enabled: false, groupId: h.b.group.id }, { enabled: false, memberId: h.a.sam.id }]) {
      expect((await h.ana.put(`/api/notifications/${kind}/exchange_rate`, body)).status).toBe(400);
    }
  }
  expect((await h.as(101, 'Ana', '').get('/api/notifications')).status).toBe(401);
  const other = h.as(201, 'Ana', h.launch(h.b));
  await other.put('/api/notifications/group/trip', { enabled: false });
  expect((await h.ana.get('/api/notifications')).body.group.trip).toBe(true);
  expect((await other.get('/api/notifications')).body.group.trip).toBe(false);
});

it('API expense edits carry both participants and payer context, and payments carry both parties', async () => {
  const h = setup();
  const input = { payerId: h.a.ana.id, description: 'Dinner', expenseDate: '2026-09-27', total: 3000, splitType: 'even', shares: [{ memberId: h.a.ana.id }, { memberId: h.a.sam.id }] };
  const created = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, input);
  expect(created.status).toBe(201);
  expect(h.notices.at(-1)!.notice.personal).toEqual({ actorMemberId: h.a.ana.id, tripId: h.a.trip.id, tripName: h.a.trip.name, payerId: h.a.ana.id, memberIds: [h.a.ana.id, h.a.sam.id], homeCurrency: 'SGD', balances: { [h.a.ana.id]: 1500, [h.a.sam.id]: -1500 } });
  const e = created.body.expense;
  const edited = await h.sam.put(`/api/expenses/${e.id}`, { ...input, payerId: h.a.sam.id, shares: [{ memberId: h.a.leo.id }], version: e.version });
  expect(edited.status).toBe(200);
  expect(h.notices.at(-1)!.notice.beforePersonal).toMatchObject({ payerId: h.a.ana.id, memberIds: [h.a.ana.id, h.a.sam.id] });
  expect(h.notices.at(-1)!.notice.personal).toMatchObject({ actorMemberId: h.a.sam.id, payerId: h.a.sam.id, memberIds: [h.a.leo.id] });
  const paid = await h.ana.post(`/api/trips/${h.a.trip.id}/settlements`, { fromMemberId: h.a.sam.id, toMemberId: h.a.leo.id, amount: 100 });
  expect(paid.status).toBe(201);
  expect(h.notices.at(-1)!.notice).toMatchObject({ actorMemberId: h.a.ana.id, fromMemberId: h.a.sam.id, toMemberId: h.a.leo.id, tripId: h.a.trip.id, groupId: h.a.group.id });
});
