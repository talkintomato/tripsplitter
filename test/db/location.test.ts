import { afterEach, expect, it } from 'vitest';
import { createExpense, getExpense, listActivity, saveExpense, StaleEditError, ValidationError, type Db } from '../../src/db/index.js';
import { inputOf } from '../../src/tools/tools/shared.js';
import { dinner, seed } from './helpers.js';

const opened: Db[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
function setup() { const s = seed(); opened.push(s.db); return s; }
const location = { locationLat: 35.659504, locationLng: 139.700506, placeName: 'Shibuya', locationSource: 'photo' as const };

it('creates, rounds, edits and removes location with versioned activity snapshots', () => {
  const s = setup();
  const first = createExpense(s.db, s.asAna, dinner(s, location));
  expect(first).toMatchObject({ ...location, locationLat: 35.6595, locationLng: 139.70051 });
  const second = saveExpense(s.db, s.asAna, first.id, 1, dinner(s, { ...location, placeName: 'Tokyo', locationSource: 'device' }));
  expect(second).toMatchObject({ version: 2, placeName: 'Tokyo', locationSource: 'device' });
  expect(() => saveExpense(s.db, s.asAna, first.id, 1, dinner(s, { locationLat: null, locationLng: null }))).toThrow(StaleEditError);
  expect(getExpense(s.db, s.asAna, first.id)).toEqual(second);
  const third = saveExpense(s.db, s.asAna, first.id, 2, dinner(s, { locationLat: null, locationLng: null }));
  expect(third).toMatchObject({ version: 3, locationLat: null, locationLng: null, placeName: null, locationSource: null });
  expect(listActivity(s.db, s.asAna, { entity: { type: 'expense', id: first.id } })[0]).toMatchObject({ action: 'expense.save', before: second, after: third });
});

it('preserves location when unrelated fields are edited, including the agent input copy', () => {
  const s = setup();
  const first = createExpense(s.db, s.asAna, dinner(s, location));
  const edited = saveExpense(s.db, s.asAna, first.id, 1, dinner(s, { description: 'New description' }));
  for (const key of ['locationLat', 'locationLng', 'placeName', 'locationSource'] as const) {
    expect(edited[key]).toEqual(first[key]);
    expect(inputOf(edited)[key]).toEqual(first[key]);
  }
});

it.each([
  { locationLat: 91, locationLng: 0 }, { locationLat: -91, locationLng: 0 },
  { locationLat: 0, locationLng: 181 }, { locationLat: 0, locationLng: -181 },
  { locationLat: 0 }, { locationLng: 0 }, { locationLat: NaN, locationLng: 0 },
  { locationLat: 0, locationLng: Infinity },
])('rejects invalid location without changing the expense', input => {
  const s = setup();
  expect(() => createExpense(s.db, s.asAna, dinner(s, input))).toThrow(ValidationError);
});

it('migration enforces paired coordinates, ranges and source on direct SQL writes', () => {
  const s = setup();
  const e = createExpense(s.db, s.asAna, dinner(s));
  for (const [lat, lng] of [[0, null], [null, 0], [91, 0], [-91, 0], [0, 181], [0, -181]]) {
    expect(() => s.db.prepare('UPDATE expense SET location_lat = ?, location_lng = ? WHERE id = ?').run(lat, lng, e.id)).toThrow(/CHECK/);
  }
  for (const [lat, lng] of [[90, 180], [-90, -180], [0, 0], [null, null]]) {
    s.db.prepare('UPDATE expense SET location_lat = ?, location_lng = ? WHERE id = ?').run(lat, lng, e.id);
  }
  expect(() => s.db.prepare("UPDATE expense SET location_source = 'unknown' WHERE id = ?").run(e.id)).toThrow(/CHECK/);
});

it('clearing both coordinates also clears the previous name and source', () => {
  const s = setup();
  const e = createExpense(s.db, s.asAna, dinner(s, location));
  expect(saveExpense(s.db, s.asAna, e.id, e.version, { ...inputOf(e), locationLat: null, locationLng: null })).toMatchObject({ locationLat: null, locationLng: null, placeName: null, locationSource: null });
});
