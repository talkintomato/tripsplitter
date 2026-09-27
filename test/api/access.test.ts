import { describe, expect, it } from 'vitest';
import { LINK_INVALID_MESSAGE } from '../../src/api/index.js';
import {
  createExpense,
  createSettlement,
  deleteExpense,
  discardExpense,
  endTrip,
  getExpense,
  listMembers,
  resetLink,
  undoSettlement,
} from '../../src/db/index.js';
import { countActivity, dinner, fingerprint, type Seed } from '../db/helpers.js';
import { dinnerBody, harness, type Client, type Harness, type Reply } from './helpers.js';

interface RouteCase {
  name: string;
  /** True when the path names a record by ID. */
  takesId: boolean;
  /** Prepares what the route needs in the group of `s` and calls it as `client`. */
  call(h: Harness, s: Seed, client: Client): Promise<Reply>;
  ok: number;
}

const confirmed = (h: Harness, s: Seed) => createExpense(h.db, s.asAna, dinner(s));
const draft = (h: Harness, s: Seed) => createExpense(h.db, s.asAna, dinner(s, { status: 'draft' }));
const settlement = (h: Harness, s: Seed) =>
  createSettlement(h.db, s.asAna, { tripId: s.trip.id, fromMemberId: s.sam.id, toMemberId: s.ana.id, amount: 300 });

const ROUTES: RouteCase[] = [
  { name: 'GET /api/group', takesId: false, ok: 200, call: (_h, _s, c) => c.get('/api/group') },
  { name: 'GET /api/trips', takesId: false, ok: 200, call: (_h, _s, c) => c.get('/api/trips') },
  {
    name: 'POST /api/trips',
    takesId: false,
    ok: 201,
    call: (h, s, c) => {
      endTrip(h.db, s.asAna, s.trip.id);
      return c.post('/api/trips', { name: 'Next' });
    },
  },
  { name: 'GET /api/trips/:tripId', takesId: true, ok: 200, call: (_h, s, c) => c.get(`/api/trips/${s.trip.id}`) },
  { name: 'PATCH /api/trips/:tripId', takesId: true, ok: 200, call: (_h, s, c) => c.patch(`/api/trips/${s.trip.id}`, { name: 'Renamed' }) },
  { name: 'POST /api/trips/:tripId/end', takesId: true, ok: 200, call: (_h, s, c) => c.post(`/api/trips/${s.trip.id}/end`) },
  {
    name: 'POST /api/trips/:tripId/reopen',
    takesId: true,
    ok: 200,
    call: (h, s, c) => {
      endTrip(h.db, s.asAna, s.trip.id);
      return c.post(`/api/trips/${s.trip.id}/reopen`);
    },
  },
  { name: 'GET /api/trips/:tripId/expenses', takesId: true, ok: 200, call: (_h, s, c) => c.get(`/api/trips/${s.trip.id}/expenses?status=draft`) },
  {
    name: 'POST /api/trips/:tripId/expenses',
    takesId: true,
    ok: 201,
    // The members are the caller's own, so that only the trip decides the answer.
    call: (h, s, c) => c.post(`/api/trips/${s.trip.id}/expenses`, dinnerBody(h.a)),
  },
  { name: 'GET /api/expenses/:id', takesId: true, ok: 200, call: (h, s, c) => c.get(`/api/expenses/${confirmed(h, s).id}`) },
  {
    name: 'PUT /api/expenses/:id',
    takesId: true,
    ok: 200,
    call: (h, s, c) => c.put(`/api/expenses/${confirmed(h, s).id}`, { ...dinnerBody(h.a, { total: 1200 }), version: 1 }),
  },
  { name: 'POST /api/expenses/:id/confirm', takesId: true, ok: 200, call: (h, s, c) => c.post(`/api/expenses/${draft(h, s).id}/confirm`, { version: 1 }) },
  { name: 'POST /api/expenses/:id/discard', takesId: true, ok: 200, call: (h, s, c) => c.post(`/api/expenses/${draft(h, s).id}/discard`, { version: 1 }) },
  { name: 'POST /api/expenses/:id/delete', takesId: true, ok: 200, call: (h, s, c) => c.post(`/api/expenses/${confirmed(h, s).id}/delete`, { version: 1 }) },
  {
    name: 'POST /api/expenses/:id/restore',
    takesId: true,
    ok: 200,
    call: (h, s, c) => {
      const gone = deleteExpense(h.db, s.asAna, confirmed(h, s).id, 1);
      return c.post(`/api/expenses/${gone.id}/restore`, { version: gone.version });
    },
  },
  { name: 'GET /api/trips/:tripId/balances', takesId: true, ok: 200, call: (_h, s, c) => c.get(`/api/trips/${s.trip.id}/balances`) },
  {
    name: 'POST /api/trips/:tripId/settlements',
    takesId: true,
    ok: 201,
    call: (h, s, c) => c.post(`/api/trips/${s.trip.id}/settlements`, { fromMemberId: h.a.sam.id, toMemberId: h.a.ana.id, amount: 300 }),
  },
  { name: 'POST /api/settlements/:id/undo', takesId: true, ok: 200, call: (h, s, c) => c.post(`/api/settlements/${settlement(h, s).id}/undo`, { version: 1 }) },
  {
    name: 'POST /api/settlements/:id/restore',
    takesId: true,
    ok: 200,
    call: (h, s, c) => {
      const undone = undoSettlement(h.db, s.asAna, settlement(h, s).id, 1);
      return c.post(`/api/settlements/${undone.id}/restore`, { version: undone.version });
    },
  },
  { name: 'POST /api/members', takesId: false, ok: 201, call: (_h, _s, c) => c.post('/api/members', { displayName: 'Mia' }) },
  { name: 'POST /api/members/:id/claim', takesId: true, ok: 200, call: (_h, s, c) => c.post(`/api/members/${s.leo.id}/claim`) },
  { name: 'POST /api/group/reset-link', takesId: false, ok: 200, call: (_h, _s, c) => c.post('/api/group/reset-link') },
  { name: 'GET /api/activity', takesId: false, ok: 200, call: (_h, _s, c) => c.get('/api/activity') },
  { name: 'GET /api/activity?tripId=', takesId: true, ok: 200, call: (_h, s, c) => c.get(`/api/activity?tripId=${s.trip.id}`) },
];

/** A client that notes the state of the database just before its request, after the records were prepared. */
function watch(h: Harness, client: Client): { client: Client; prepared: () => string } {
  let state = fingerprint(h.db);
  const mark = (): void => {
    state = fingerprint(h.db);
  };
  return {
    prepared: () => state,
    client: {
      get: (p) => (mark(), client.get(p)),
      post: (p, b) => (mark(), client.post(p, b)),
      put: (p, b) => (mark(), client.put(p, b)),
      patch: (p, b) => (mark(), client.patch(p, b)),
    },
  };
}

describe('every route', () => {
  for (const route of ROUTES) {
    it(`${route.name} answers a member`, async () => {
      const h = harness();
      const reply = await route.call(h, h.a, h.ana);
      expect(reply.status).toBe(route.ok);
      expect(reply.body.error).toBeUndefined();
    });

    it(`${route.name} refuses a link from before a reset`, async () => {
      const h = harness();
      const old = h.as(101, 'Ana', h.launch(h.a));
      resetLink(h.db, h.a.asSam);
      h.clear();
      const watched = watch(h, old);
      const reply = await route.call(h, h.a, watched.client);
      const prepared = watched.prepared();
      expect(reply.status).toBe(403);
      expect(reply.body.error.code).toBe('link_invalid');
      expect(reply.body.error.message).toBe(LINK_INVALID_MESSAGE);
      expect(fingerprint(h.db)).toBe(prepared);
      expect(h.sent()).toEqual([]);
    });
  }

  for (const route of ROUTES.filter((r) => r.takesId)) {
    it(`${route.name} gives 404 for a record of another group`, async () => {
      const h = harness();
      // Records are prepared in group b. Ana of group a asks for them.
      const watched = watch(h, h.ana);
      const reply = await route.call(h, h.b, watched.client);
      const prepared = watched.prepared();
      expect(reply.status).toBe(404);
      expect(reply.body.error.code).toBe('not_found');
      expect(fingerprint(h.db)).toBe(prepared);
      expect(h.sent()).toEqual([]);
    });
  }

  it('gives 404 for an ID that is not a number', async () => {
    const h = harness();
    expect((await h.ana.get('/api/expenses/abc')).status).toBe(404);
    expect((await h.ana.get('/api/trips/0')).status).toBe(404);
    expect((await h.ana.post('/api/settlements/1e3/undo', { version: 1 })).status).toBe(404);
    expect((await h.ana.get('/api/nothing-here')).status).toBe(404);
  });
});

describe('signing in', () => {
  it('refuses a request without sign-in data, with a bad signature, or without a link', async () => {
    const h = harness();
    const launch = h.launch(h.a);
    const noAuth = await h.app.request('/api/group', { headers: { 'X-Launch': launch } });
    expect(noAuth.status).toBe(401);
    const forged = await h.app.request('/api/group', {
      headers: { Authorization: 'tma user=%7B%22id%22%3A101%7D&auth_date=1&hash=abcd', 'X-Launch': launch },
    });
    expect(forged.status).toBe(401);
    const noLink = await h.as(101, 'Ana', '').get('/api/group');
    expect(noLink.status).toBe(401);
    expect(noLink.body.error.message).toMatch(/from the link/);
    const tampered = await h.as(101, 'Ana', launch.replace(/_home_/, '_add_')).get('/api/group');
    expect(tampered.status).toBe(401);
  });

  it('never uses DEV_FAKE_USER outside development', async () => {
    const h = harness();
    const reply = await h.app.request('/api/group', { headers: { 'X-Launch': h.launch(h.a) } });
    expect(reply.status).toBe(401);
  });

  it('makes a new person a member and sends the notice once', async () => {
    const h = harness();
    const priya = h.as(555, 'Priya', h.launch(h.a));
    const first = await priya.get('/api/group');
    expect(first.status).toBe(200);
    expect(first.body.me).toMatchObject({ displayName: 'Priya', joinedVia: 'link', active: true, telegramUserId: 555 });
    expect(first.body.members.map((m: { displayName: string }) => m.displayName)).toContain('Priya');
    expect(h.notices).toEqual([{ name: 'memberJoinedByLink', notice: { chatId: h.a.group.chatId, memberName: 'Priya' } }]);

    await priya.get('/api/group');
    await priya.get('/api/trips');
    expect(h.sent()).toEqual(['memberJoinedByLink']);
    expect(listMembers(h.db, h.a.asAna).filter((m) => m.telegramUserId === 555)).toHaveLength(1);
    // She is a member of this group only.
    expect(listMembers(h.db, h.b.asAna).some((m) => m.telegramUserId === 555)).toBe(false);
  });

  it('keeps members after a reset and accepts the new link', async () => {
    const h = harness();
    const reply = await h.ana.post('/api/group/reset-link');
    expect(reply.status).toBe(200);
    expect(reply.body.group.linkVersion).toBe(2);
    expect(h.notices).toEqual([{ name: 'linkReset', notice: { chatId: h.a.group.chatId, groupId: h.a.group.id, actorName: 'Ana' } }]);

    expect((await h.ana.get('/api/group')).status).toBe(403);
    const again = await h.as(101, 'Ana', reply.body.launch).get('/api/group');
    expect(again.status).toBe(200);
    expect(again.body.me.id).toBe(h.a.ana.id);
    // Someone new with the old link does not get in and is not added.
    const members = listMembers(h.db, h.a.asAna).length;
    expect((await h.as(777, 'Eve', h.launch(h.b).replace(/^v1_\d+_/, `v1_${h.a.group.id}_`)).get('/api/group')).status).toBe(401);
    expect((await h.sam.get('/api/group')).status).toBe(403);
    expect(listMembers(h.db, h.a.asAna)).toHaveLength(members);
  });
});

describe('the acting member', () => {
  it('cannot be set from the request body', async () => {
    const h = harness();
    const reply = await h.sam.post(`/api/trips/${h.a.trip.id}/expenses`, {
      ...dinnerBody(h.a),
      createdBy: h.a.ana.id,
      actor: { kind: 'member', memberId: h.a.ana.id },
      memberId: h.a.ana.id,
      scope: { groupId: h.b.group.id, actor: { kind: 'system' } },
      groupId: h.b.group.id,
    });
    expect(reply.status).toBe(201);
    expect(reply.body.expense.createdBy).toBe(h.a.sam.id);
    expect(getExpense(h.db, h.a.asAna, reply.body.expense.id).createdBy).toBe(h.a.sam.id);
    expect(h.notices[0]!.notice.actorName).toBe('Sam');

    const paid = await h.sam.post(`/api/trips/${h.a.trip.id}/settlements`, {
      fromMemberId: h.a.leo.id,
      toMemberId: h.a.ana.id,
      amount: 100,
      createdBy: h.a.ana.id,
    });
    expect(paid.body.settlement.createdBy).toBe(h.a.sam.id);

    const activity = await h.ana.get('/api/activity');
    expect(activity.body.entries[0]).toMatchObject({ action: 'settlement.create', actor: { kind: 'member', memberId: h.a.sam.id }, actorName: 'Sam' });
  });

  it('cannot use a payer or a share member from another group', async () => {
    const h = harness();
    const before = countActivity(h.db);
    const payer = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, dinnerBody(h.a, { payerId: h.b.sam.id }));
    expect(payer.status).toBe(400);
    expect(payer.body.error.code).toBe('member_not_in_group');
    const share = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, dinnerBody(h.a, { shares: [{ memberId: h.a.ana.id }, { memberId: h.b.leo.id }] }));
    expect(share.status).toBe(400);
    expect(share.body.error.code).toBe('member_not_in_group');

    const existing = createExpense(h.db, h.a.asAna, dinner(h.a));
    const saved = await h.ana.put(`/api/expenses/${existing.id}`, { ...dinnerBody(h.a, { payerId: h.b.ana.id }), version: 1 });
    expect(saved.status).toBe(400);
    expect(saved.body.error.code).toBe('member_not_in_group');
    const paid = await h.ana.post(`/api/trips/${h.a.trip.id}/settlements`, { fromMemberId: h.b.sam.id, toMemberId: h.a.ana.id, amount: 5 });
    expect(paid.status).toBe(400);
    expect(paid.body.error.code).toBe('member_not_in_group');
    expect(countActivity(h.db)).toBe(before + 1);
    expect(h.sent()).toEqual([]);
  });

  it('answers a body that cannot be read with 400 and a plain message', async () => {
    const h = harness();
    const missing = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, { description: 'x' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('invalid_input');
    expect(missing.body.error.message).toMatch(/who paid/);
    const fraction = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, dinnerBody(h.a, { total: 10.5 }));
    expect(fraction.status).toBe(400);
    const noVersion = await h.ana.post(`/api/expenses/${createExpense(h.db, h.a.asAna, dinner(h.a)).id}/delete`);
    expect(noVersion.status).toBe(400);
    const zero = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, dinnerBody(h.a, { total: 0 }));
    expect(zero.status).toBe(400);
    expect(zero.body.error.code).toBe('invalid_expense');
    expect(zero.body.error.problems[0]).toMatchObject({ field: 'total', code: 'total_not_positive' });
  });
});

describe('the launch destination', () => {
  it('is returned with the group', async () => {
    const h = harness();
    for (const view of ['home', 'add', 'balances'] as const) {
      const reply = await h.as(101, 'Ana', h.launch(h.a, view)).get('/api/group');
      expect(reply.body.destination).toEqual({ view });
    }
    const reply = await h.ana.get('/api/group');
    expect(reply.body).toMatchObject({
      group: { id: h.a.group.id, title: 'Japan 2026', linkVersion: 1 },
      access: 'write',
      me: { id: h.a.ana.id },
      activeTrip: { id: h.a.trip.id, homeCurrency: 'SGD' },
      newTripCurrency: 'SGD',
    });
    expect(reply.body.members).toHaveLength(3);
    expect(reply.body.link).toMatch(/^https:\/\/t\.me\/.+\?startapp=v1_/);
  });

  it('opens an expense of an ended trip in that trip', async () => {
    const h = harness();
    const expense = createExpense(h.db, h.a.asAna, dinner(h.a));
    endTrip(h.db, h.a.asAna, h.a.trip.id);
    const reply = await h.as(102, 'Sam', h.launch(h.a, 'expense', expense.id)).get('/api/group');
    expect(reply.status).toBe(200);
    expect(reply.body.destination).toEqual({ view: 'expense', expenseId: expense.id, tripId: h.a.trip.id });
    expect(reply.body.activeTrip).toBeNull();
  });

  it('refuses an expense of another group', async () => {
    const h = harness();
    const theirs = createExpense(h.db, h.b.asAna, dinner(h.b));
    const reply = await h.as(101, 'Ana', h.launch(h.a, 'expense', theirs.id)).get('/api/group');
    expect(reply.status).toBe(404);
    expect(reply.body.destination).toBeUndefined();
    const drafted = discardExpense(h.db, h.a.asAna, createExpense(h.db, h.a.asAna, dinner(h.a, { status: 'draft' })).id, 1);
    const own = await h.as(101, 'Ana', h.launch(h.a, 'expense', drafted.id)).get('/api/group');
    expect(own.body.destination.expenseId).toBe(drafted.id);
  });
});
