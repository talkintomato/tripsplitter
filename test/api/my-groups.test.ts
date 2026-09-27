import { afterEach, beforeEach, expect, it } from 'vitest';
import type { MyGroupsResponse } from '../../src/api/types.js';
import { decodeLaunch } from '../../src/core/index.js';
import { createExpense, endTrip, resetLink, setMemberActive } from '../../src/db/index.js';
import { initDataFor } from '../auth/helpers.js';
import { dinner, fingerprint, seedGroup } from '../db/helpers.js';
import { harness, type Harness } from './helpers.js';

let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => h.db.close());
const auth = (id = 101, extra = {}) => ({ Authorization: `tma ${initDataFor({ id, first_name: 'Ana', ...extra }, new Date())}` });
const list = (query = '', id = 101) => h.app.request(`/api/my-groups${query}`, { headers: auth(id) });

it('returns exactly two of three groups, balances and open drafts, ignoring request identity and group IDs without writes', async () => {
  const c = seedGroup(h.db, -300, 'Third', 101);
  setMemberActive(h.db, c.asSystem, c.ana.id, false);
  createExpense(h.db, h.a.asAna, dinner(h.a));
  createExpense(h.db, h.a.asAna, dinner(h.a, { status: 'draft' }));
  const before = fingerprint(h.db);
  const response = await list(`?groupId=${h.b.group.id}&telegramUserId=201`);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body = await response.json() as MyGroupsResponse;
  expect(body.botUsername).toBe(h.config.botUsername);
  expect(body.groups.map((g: { id: number }) => g.id)).toEqual([h.a.group.id, c.group.id]);
  expect(body.groups[0]).toEqual({ id: h.a.group.id, title: h.a.group.title, tripName: h.a.trip.name,
    balance: { amount: 666, currency: 'SGD' }, draftsCount: 1, launch: h.launch(h.a) });
  expect(body.groups[1]!.balance).toEqual({ amount: 0, currency: 'SGD' });
  expect(fingerprint(h.db)).toBe(before);
  expect(h.notices).toEqual([]);
});

it('returns empty for strangers and merged identities and never joins them', async () => {
  const before = fingerprint(h.db);
  expect(await (await list(`?groupId=${h.a.group.id}`, 999)).json()).toEqual({ botUsername: h.config.botUsername, groups: [] });
  expect(fingerprint(h.db)).toBe(before);
  h.db.prepare('UPDATE member SET merged_into = ?, active = 0 WHERE id = ?').run(h.a.sam.id, h.a.ana.id);
  const merged = fingerprint(h.db);
  expect((await (await list()).json() as MyGroupsResponse).groups).toEqual([]);
  expect(fingerprint(h.db)).toBe(merged);
});

it('returns null trip and balance and zero drafts when no trip is active', async () => {
  endTrip(h.db, h.a.asAna, h.a.trip.id);
  expect((await (await list()).json() as MyGroupsResponse).groups[0]).toMatchObject({ tripName: null, balance: null, draftsCount: 0 });
});

it('issues the current working home launch after reset while the old link fails', async () => {
  const old = h.launch(h.a);
  resetLink(h.db, h.a.asAna);
  const { launch } = (await (await list()).json() as MyGroupsResponse).groups[0]!;
  expect(decodeLaunch(launch, h.config.linkSecret)).toEqual({ groupId: h.a.group.id, linkVersion: 2, view: 'home' });
  expect((await h.as(101, 'Ana', old).get('/api/group')).status).toBe(403);
  expect((await h.as(101, 'Ana', launch).get('/api/group')).status).toBe(200);
});

it('requires authenticated human Telegram data', async () => {
  for (const headers of [{}, { Authorization: 'tma forged' }, auth(101, { is_bot: true })]) {
    expect((await h.app.request('/api/my-groups', { headers })).status).toBe(401);
  }
});

it('every other registered API route still refuses a missing launch, including alternate paths and methods', async () => {
  const routes = h.app.routes.filter((r) => r.path.startsWith('/api/') && r.method !== 'ALL' && r.path !== '/api/my-groups');
  expect(routes.length).toBeGreaterThan(20);
  for (const route of [...routes, ...['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) => ({ method, path: '/api/my-groups' })),
    { method: 'GET', path: '/api/my-groups/' }, { method: 'GET', path: '/api/my-groups/group' }, { method: 'GET', path: '/api/unknown' }]) {
    const path = route.path.replace(/:[^/]+/g, '1');
    const response = await h.app.request(path, { method: route.method, headers: auth() });
    expect(response.status, `${route.method} ${path}`).toBe(401);
  }
});
