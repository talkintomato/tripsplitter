import { describe, expect, it } from 'vitest';
import { suggestPayments } from '../../src/core/index.js';

const big = (entries: Array<[number, number]>) => new Map(entries.map(([id, amount]) => [id, BigInt(amount)]));

describe('suggestPayments', () => {
  it('breaks ties by the lowest member ID', () => {
    expect(suggestPayments(big([[4, -500], [2, 500], [3, -500], [1, 500]]))).toEqual([
      { fromMemberId: 3, toMemberId: 1, amount: 500n },
      { fromMemberId: 4, toMemberId: 2, amount: 500n },
    ]);
  });

  it('returns nothing when everyone is settled', () => {
    expect(suggestPayments(big([[1, 0], [2, 0], [3, 0]]))).toEqual([]);
    expect(suggestPayments(new Map())).toEqual([]);
  });

  it('handles one member owing several', () => {
    expect(suggestPayments(big([[1, -900], [2, 300], [3, 600]]))).toEqual([
      { fromMemberId: 1, toMemberId: 3, amount: 600n },
      { fromMemberId: 1, toMemberId: 2, amount: 300n },
    ]);
  });

  it('handles several members owing one', () => {
    expect(suggestPayments(big([[1, 1000], [2, -300], [3, -700]]))).toEqual([
      { fromMemberId: 3, toMemberId: 1, amount: 700n },
      { fromMemberId: 2, toMemberId: 1, amount: 300n },
    ]);
  });

  it('gives the same result whatever the order of the input', () => {
    const entries: Array<[number, number]> = [[1, -1332], [2, 5664], [3, -4332], [4, 250], [5, -250]];
    const expected = suggestPayments(big(entries));
    expect(suggestPayments(big([...entries].reverse()))).toEqual(expected);
    expect(suggestPayments(big([entries[2]!, entries[0]!, entries[4]!, entries[1]!, entries[3]!]))).toEqual(expected);
  });

  it('needs at most N-1 payments and settles everyone', () => {
    const balances = big([[1, -1332], [2, 5664], [3, -4332], [4, 250], [5, -250], [6, 0]]);
    const payments = suggestPayments(balances);
    expect(payments.length).toBeLessThanOrEqual(balances.size - 1);
    const after = new Map(balances);
    for (const p of payments) {
      expect(p.amount > 0n).toBe(true);
      after.set(p.fromMemberId, after.get(p.fromMemberId)! + p.amount);
      after.set(p.toMemberId, after.get(p.toMemberId)! - p.amount);
    }
    expect([...after.values()].every((v) => v === 0n)).toBe(true);
  });

  it('accepts numbers and does not change its input', () => {
    const balances = new Map([[1, -100], [2, 100]]);
    expect(suggestPayments(balances)).toEqual([{ fromMemberId: 1, toMemberId: 2, amount: 100n }]);
    expect(Object.fromEntries(balances)).toEqual({ 1: -100, 2: 100 });
  });
});
