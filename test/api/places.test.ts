import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { lookupPlace, placeName } from '../../src/api/places.js';
import { openDatabase, type Db } from '../../src/db/index.js';
import { dinnerBody, harness } from './helpers.js';

let db: Db;
let tick = Date.UTC(2030, 0, 1);
const send = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers(); tick += 100 * 86400000; vi.setSystemTime(tick);
  db = openDatabase(':memory:'); vi.stubGlobal('fetch', send); send.mockReset();
});
afterEach(() => { db.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([
  [{ name: 'Ichiran Shibuya', address: { city: 'Tokyo' } }, 'Ichiran Shibuya, Tokyo'],
  [{ address: { road: 'Example Road', city: 'Tokyo' } }, 'Example Road, Tokyo'],
  [{ address: { neighbourhood: 'Shibuya', city: 'Tokyo' } }, 'Shibuya, Tokyo'],
  [{ name: 'Tokyo', address: { city: 'Tokyo' } }, 'Tokyo'],
  [{ address: { town: 'Example town' } }, 'Example town'],
  [{ error: 'Unable to geocode' }, null], [null, null],
])('builds a short name from Nominatim JSON', (json, name) => expect(placeName(json)).toBe(name));

it('caches names by rounded key across callers for 90 days and identifies the app', async () => {
  send.mockResolvedValue(Response.json({ name: 'Place', address: { city: 'City' } }));
  expect(await lookupPlace(db, true, 35.12341, 139.12341)).toBe('Place, City');
  expect(await lookupPlace(db, true, 35.12342, 139.12342)).toBe('Place, City');
  expect(send).toHaveBeenCalledTimes(1);
  const [url, options] = send.mock.calls[0]!;
  expect(String(url)).toBe('https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=35.12341&lon=139.12341&zoom=18&accept-language=en');
  expect(options?.headers).toEqual({ 'User-Agent': 'TripSplitter (https://github.com/talkintomato/tripsplitter)' });
  vi.setSystemTime(tick + 90 * 86400000);
  await lookupPlace(db, true, 35.12341, 139.12341);
  expect(send).toHaveBeenCalledTimes(2);
});

it('caches a null result for one day', async () => {
  send.mockImplementation(async () => Response.json({ error: 'missing' }));
  expect(await lookupPlace(db, true, 1, 2)).toBeNull();
  vi.setSystemTime(tick + 86400000 - 1);
  expect(await lookupPlace(db, true, 1, 2)).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
  vi.setSystemTime(tick + 86400000);
  await lookupPlace(db, true, 1, 2);
  expect(send).toHaveBeenCalledTimes(2);
});

it('refuses simultaneous or sub-second requests across databases without caching refusals', async () => {
  send.mockImplementation(async () => Response.json({ name: 'Place' }));
  const other = openDatabase(':memory:');
  try {
    const first = lookupPlace(db, true, 1, 2);
    expect(await lookupPlace(other, true, 3, 4)).toBeNull();
    await first;
    vi.setSystemTime(tick + 999);
    expect(await lookupPlace(other, true, 3, 4)).toBeNull();
    expect(other.prepare('SELECT * FROM place_cache').all()).toEqual([]);
    vi.setSystemTime(tick + 1000);
    expect(await lookupPlace(other, true, 3, 4)).toBe('Place');
    expect(send).toHaveBeenCalledTimes(2);
  } finally { other.close(); }
});

it('times out and aborts after five seconds, caching the failure without logging data', async () => {
  send.mockImplementation(() => new Promise(() => {}));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = lookupPlace(db, true, 1, 2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBeNull();
    expect(send.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(await lookupPlace(db, true, 1, 2)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1); expect(log).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

it('turns lookups off including cached names', async () => {
  db.prepare('INSERT INTO place_cache VALUES (?, ?, ?, ?)').run(1, 2, 'Place', tick);
  expect(await lookupPlace(db, false, 1, 2)).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

it('authenticates and validates the endpoint, with config off returning null', async () => {
  const h = harness();
  try {
    h.config.placeLookup = false;
    expect((await h.app.request('/api/places/lookup', { method: 'POST' })).status).toBe(401);
    expect((await h.ana.post('/api/places/lookup', { lat: 91, lng: 0 })).status).toBe(400);
    expect(await h.ana.post('/api/places/lookup', { lat: 1, lng: 2 })).toEqual({ status: 200, body: { name: null } });
    expect(send).not.toHaveBeenCalled();
    h.config.placeLookup = true;
    send.mockResolvedValue(Response.json({ name: 'Place' }));
    expect(await h.ana.post('/api/places/lookup', { lat: 1, lng: 2 })).toEqual({ status: 200, body: { name: 'Place' } });
  } finally { h.db.close(); }
});

it('saves location through the API, preserves it on partial field edits, and reports stale versions', async () => {
  const h = harness();
  try {
    const location = { locationLat: 35.659504, locationLng: 139.700506, placeName: 'Shibuya', locationSource: 'photo' };
    const created = await h.ana.post(`/api/trips/${h.a.trip.id}/expenses`, dinnerBody(h.a, location));
    expect(created.status).toBe(201);
    const e = created.body.expense;
    expect(e).toMatchObject({ ...location, locationLat: 35.6595, locationLng: 139.70051 });
    const changed = await h.ana.put(`/api/expenses/${e.id}`, dinnerBody(h.a, { version: 1, description: 'Changed' }));
    expect(changed.body.expense.placeName).toBe('Shibuya');
    const stale = await h.ana.put(`/api/expenses/${e.id}`, dinnerBody(h.a, { version: 1, locationLat: null, locationLng: null }));
    expect(stale.status).toBe(409); expect(stale.body.error.current.placeName).toBe('Shibuya');
    const removed = await h.ana.put(`/api/expenses/${e.id}`, dinnerBody(h.a, { version: 2, locationLat: null, locationLng: null }));
    expect(removed.body.expense).toMatchObject({ locationLat: null, locationLng: null, placeName: null, locationSource: null });
    expect(h.notices.at(-1)?.notice.changes).toContain('location removed');
  } finally { h.db.close(); }
});

it.each(['network', 'http', 'json'])('caches %s failures as null without propagating request details', async failure => {
  if (failure === 'network') send.mockRejectedValue(new Error('request failed'));
  if (failure === 'http') send.mockResolvedValue(new Response('', { status: 503 }));
  if (failure === 'json') send.mockResolvedValue(new Response('unreadable'));
  expect(await lookupPlace(db, true, 1, 2)).toBeNull();
  expect(await lookupPlace(db, true, 1, 2)).toBeNull();
  expect(send).toHaveBeenCalledOnce();
});
