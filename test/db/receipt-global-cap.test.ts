import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countReceiptReads, reserveReceiptRead, ValidationError } from '../../src/db/index.js';
import { fingerprint, seedTwo } from './helpers.js';
let s: ReturnType<typeof seedTwo>;
beforeEach(() => { s = seedTwo(); });
afterEach(() => s.db.close());
const now = new Date('2026-09-27T15:59:59Z');

describe('overall receipt cap', () => {
  it('counts all groups in the same Singapore day and makes no reservation on refusal', () => {
    expect(reserveReceiptRead(s.db, s.a.group.id, 30, now, 2)).toBe(true);
    expect(reserveReceiptRead(s.db, s.b.group.id, 30, now, 2)).toBe(true);
    const before = fingerprint(s.db);
    expect(reserveReceiptRead(s.db, s.a.group.id, 30, now, 2)).toBe(false);
    expect(fingerprint(s.db)).toBe(before);
    expect(reserveReceiptRead(s.db, s.b.group.id, 30, new Date('2026-09-27T16:00:00Z'), 2)).toBe(true);
  });
  it('preserves the per-group limit when the overall cap is zero or omitted', () => {
    expect(reserveReceiptRead(s.db, s.a.group.id, 1, now)).toBe(true);
    expect(reserveReceiptRead(s.db, s.b.group.id, 2, now, 0)).toBe(true);
    expect(reserveReceiptRead(s.db, s.a.group.id, 1, now, 0)).toBe(false);
    expect(reserveReceiptRead(s.db, s.b.group.id, 2, now, 0)).toBe(true);
    expect(countReceiptReads(s.db, s.b.group.id, now)).toBe(2);
  });
  it('rejects invalid overall limits', () => {
    for (const cap of [-1, 0.5, NaN, Infinity]) expect(() => reserveReceiptRead(s.db, s.a.group.id, 30, now, cap)).toThrow(ValidationError);
  });
});
