import { describe, expect, it } from 'vitest';
import {
  InvalidExpenseError,
  computeShares,
  itemsDifference,
  validateExpense,
  type SplitExpense,
  type SplitItem,
  type SplitShare,
} from '../../src/core/index.js';

const expense = (over: Partial<SplitExpense>): SplitExpense => ({
  payerId: 1,
  total: 0,
  tax: 0,
  taxIncluded: false,
  tip: 0,
  serviceCharge: 0,
  discount: 0,
  splitType: 'even',
  ...over,
});
const include = (...ids: number[]): SplitShare[] => ids.map((memberId) => ({ memberId, weight: 1, expenseId: 1, itemId: null }));
const assign = (itemId: number, memberId: number, weight = 1): SplitShare => ({ memberId, weight, expenseId: null, itemId });
const obj = (shares: Map<number, bigint>) => Object.fromEntries([...shares].map(([id, amount]) => [id, Number(amount)]));
const sum = (shares: Map<number, bigint>) => [...shares.values()].reduce((a, b) => a + b, 0n);
const codes = (e: SplitExpense, items: SplitItem[], shares: SplitShare[]) => validateExpense(e, items, shares).map((p) => p.code);

describe('even split', () => {
  it('gives the leftover to the payer when the total does not divide exactly', () => {
    const shares = computeShares(expense({ total: 1000, payerId: 2 }), [], include(1, 2, 3));
    expect(obj(shares)).toEqual({ 1: 333, 2: 334, 3: 333 });
    expect(sum(shares)).toBe(1000n);
    expect(typeof shares.get(1)).toBe('bigint');
  });

  it('ignores weights', () => {
    const shares = computeShares(expense({ total: 900 }), [], [
      { memberId: 1, weight: 5 },
      { memberId: 2, weight: 1 },
      { memberId: 3, weight: 1 },
    ]);
    expect(obj(shares)).toEqual({ 1: 300, 2: 300, 3: 300 });
  });

  it('payer not included: the leftover goes to the included member with the lowest ID', () => {
    const shares = computeShares(expense({ total: 1000, payerId: 9 }), [], include(3, 1, 2));
    expect(obj(shares)).toEqual({ 1: 334, 2: 333, 3: 333 });
    expect(shares.has(9)).toBe(false);
  });

  it('gives several leftover units to one member', () => {
    expect(obj(computeShares(expense({ total: 1001, payerId: 3 }), [], include(1, 2, 3)))).toEqual({ 1: 333, 2: 333, 3: 335 });
  });

  it('a taxi fare of 20.00 split evenly with no items is valid', () => {
    const taxi = expense({ total: 2000, payerId: 1 });
    expect(validateExpense(taxi, [], include(1, 2))).toEqual([]);
    expect(obj(computeShares(taxi, [], include(1, 2)))).toEqual({ 1: 1000, 2: 1000 });
  });

  it('ignores items, even ones that do not add up', () => {
    const e = expense({ total: 2000, tax: 5 });
    expect(validateExpense(e, [{ id: 1, amount: 123 }], include(1, 2))).toEqual([]);
    expect(obj(computeShares(e, [{ id: 1, amount: 123 }], include(1, 2)))).toEqual({ 1: 1000, 2: 1000 });
  });

  it('accepts bigint amounts', () => {
    expect(obj(computeShares(expense({ total: 1000n, payerId: 2 }), [], include(1, 2, 3)))).toEqual({ 1: 333, 2: 334, 3: 333 });
  });
});

describe('portions split', () => {
  it('divides in proportion to the weights and gives the leftover to the payer', () => {
    const shares = computeShares(expense({ total: 1000, splitType: 'portions', payerId: 1 }), [], [
      { memberId: 1, weight: 1 },
      { memberId: 2, weight: 2 },
      { memberId: 3, weight: 3 },
    ]);
    expect(obj(shares)).toEqual({ 1: 167, 2: 333, 3: 500 });
    expect(sum(shares)).toBe(1000n);
  });

  it('payer not included: the leftover goes to the lowest ID', () => {
    const shares = computeShares(expense({ total: 100, splitType: 'portions', payerId: 7 }), [], [
      { memberId: 5, weight: 1 },
      { memberId: 4, weight: 2 },
    ]);
    expect(obj(shares)).toEqual({ 4: 67, 5: 33 });
  });
});

describe('items split', () => {
  it('divides items by weight and spreads tax in proportion, with amounts that do not divide exactly', () => {
    const e = expense({ total: 1600, tax: 100, splitType: 'items', payerId: 1 });
    const items: SplitItem[] = [
      { id: 1, amount: 1000 },
      { id: 2, amount: 500 },
    ];
    const shares = [...include(1, 2, 3), assign(1, 1), assign(1, 2), assign(1, 3), assign(2, 2)];
    expect(validateExpense(e, items, shares)).toEqual([]);
    // Item 1: 333 each, leftover 1 to the lowest ID. Subtotals 334, 833, 333.
    // Remainder 100 spread: 22, 55, 22 = 99. The last unit goes to the payer.
    const result = computeShares(e, items, shares);
    expect(obj(result)).toEqual({ 1: 357, 2: 888, 3: 355 });
    expect(sum(result)).toBe(1600n);
  });

  it('item shared by two members, by weight', () => {
    const e = expense({ total: 900, splitType: 'items', payerId: 2 });
    const result = computeShares(e, [{ id: 1, amount: 900 }], [...include(1, 2), assign(1, 1, 2), assign(1, 2, 1)]);
    expect(obj(result)).toEqual({ 1: 600, 2: 300 });
  });

  it('item shared by two members that does not divide: the leftover of the item goes to the lowest ID', () => {
    const e = expense({ total: 1001, splitType: 'items', payerId: 3 });
    const result = computeShares(e, [{ id: 1, amount: 1001 }], [...include(2, 3), assign(1, 2), assign(1, 3)]);
    expect(obj(result)).toEqual({ 2: 501, 3: 500 });
  });

  it('item with nobody assigned is divided equally between all included members', () => {
    const e = expense({ total: 1500, splitType: 'items', payerId: 1 });
    const items: SplitItem[] = [
      { id: 1, amount: 900 },
      { id: 2, amount: 600 },
    ];
    expect(obj(computeShares(e, items, [...include(1, 2, 3), assign(1, 1)]))).toEqual({ 1: 1100, 2: 200, 3: 200 });
  });

  it('item with quantity 2: the amount is used as given and not multiplied', () => {
    const e = expense({ total: 1600, splitType: 'items', payerId: 1 });
    const items: SplitItem[] = [{ id: 1, amount: 1600, quantity: 2 }];
    expect(validateExpense(e, items, include(1, 2))).toEqual([]);
    expect(obj(computeShares(e, items, include(1, 2)))).toEqual({ 1: 800, 2: 800 });
  });

  it('items 100, tax 10 not included, discount 10, total 100: valid', () => {
    const e = expense({ total: 100, tax: 10, taxIncluded: false, discount: 10, splitType: 'items' });
    expect(validateExpense(e, [{ id: 1, amount: 100 }], include(1, 2))).toEqual([]);
    expect(obj(computeShares(e, [{ id: 1, amount: 100 }], include(1, 2)))).toEqual({ 1: 50, 2: 50 });
  });

  it('items 100 with tax included, service charge 10, total 110: valid', () => {
    const e = expense({ total: 110, tax: 7, taxIncluded: true, serviceCharge: 10, splitType: 'items' });
    expect(validateExpense(e, [{ id: 1, amount: 100 }], include(1, 2))).toEqual([]);
    expect(obj(computeShares(e, [{ id: 1, amount: 100 }], include(1, 2)))).toEqual({ 1: 55, 2: 55 });
  });

  it('never guesses that tax is included: items that sum to the total with tax not included are refused', () => {
    const e = expense({ total: 100, tax: 7, taxIncluded: false, splitType: 'items' });
    const problems = validateExpense(e, [{ id: 1, amount: 100 }], include(1));
    expect(problems).toEqual([expect.objectContaining({ field: 'total', code: 'total_mismatch', difference: -7 })]);
  });

  it('zero-value items with a tip: refused', () => {
    const e = expense({ total: 10, tip: 10, splitType: 'items' });
    const items: SplitItem[] = [
      { id: 1, amount: 0 },
      { id: 2, amount: 0 },
    ];
    expect(codes(e, items, include(1, 2))).toEqual(['zero_items_with_adjustments']);
    expect(() => computeShares(e, items, include(1, 2))).toThrow(InvalidExpenseError);
  });

  it('accepts a zero-value item next to others', () => {
    const e = expense({ total: 500, splitType: 'items' });
    const items: SplitItem[] = [
      { id: 1, amount: 0 },
      { id: 2, amount: 500 },
    ];
    expect(obj(computeShares(e, items, [...include(1, 2), assign(1, 2), assign(2, 1)]))).toEqual({ 1: 500, 2: 0 });
  });

  it('negative remainder from a discount, spread in proportion', () => {
    const e = expense({ total: 2500, discount: 500, splitType: 'items', payerId: 2 });
    const items: SplitItem[] = [
      { id: 1, amount: 2000 },
      { id: 2, amount: 1000 },
    ];
    const shares = [...include(1, 2), assign(1, 1), assign(2, 2)];
    expect(validateExpense(e, items, shares)).toEqual([]);
    // Remainder -500: -333.33 and -166.67, rounded toward zero to -333 and -166. That leaves 2501, so the
    // payer gets one unit less.
    const result = computeShares(e, items, shares);
    expect(obj(result)).toEqual({ 1: 1667, 2: 833 });
    expect(sum(result)).toBe(2500n);
  });

  it('a receipt with discount and service charge', () => {
    const e = expense({ total: 2800, serviceCharge: 300, discount: 500, splitType: 'items', payerId: 2 });
    const items: SplitItem[] = [
      { id: 1, amount: 2000 },
      { id: 2, amount: 1000 },
    ];
    const result = computeShares(e, items, [...include(1, 2), assign(1, 1), assign(2, 2)]);
    expect(obj(result)).toEqual({ 1: 1867, 2: 933 });
    expect(sum(result)).toBe(2800n);
  });

  it('reports the difference as total minus expected total, with its sign', () => {
    const items: SplitItem[] = [
      { id: 1, amount: 2000 },
      { id: 2, amount: 1000 },
    ];
    const shares = [...include(1, 2), assign(1, 1), assign(2, 2)];
    const more = expense({ total: 3100, serviceCharge: 300, discount: 500, splitType: 'items' });
    expect(validateExpense(more, items, shares)).toEqual([
      { field: 'total', code: 'total_mismatch', message: expect.stringContaining('more than'), difference: 300 },
    ]);
    expect(itemsDifference(more, items)).toBe(300n);
    const less = expense({ total: 2700, serviceCharge: 300, discount: 500, splitType: 'items' });
    expect(validateExpense(less, items, shares)).toEqual([
      { field: 'total', code: 'total_mismatch', message: expect.stringContaining('less than'), difference: -100 },
    ]);
    expect(() => computeShares(more, items, shares)).toThrow(InvalidExpenseError);
  });

  it('refuses no items, a negative item, a negative adjustment, an unknown item and a member who is not included', () => {
    const e = expense({ total: 1000, splitType: 'items' });
    expect(codes(e, [], include(1))).toEqual(['no_items']);
    expect(codes(expense({ total: 900, splitType: 'items' }), [{ id: 1, amount: 1000 }, { id: 2, amount: -100 }], include(1))).toEqual(['invalid_amount']);
    expect(codes(expense({ total: 1000, tip: -5, splitType: 'items' }), [{ id: 1, amount: 1000 }], include(1))).toEqual(['invalid_amount']);
    expect(codes(e, [{ id: 1, amount: 1000 }], [...include(1), assign(2, 1)])).toEqual(['unknown_item']);
    expect(codes(e, [{ id: 1, amount: 1000 }], [...include(1), assign(1, 2)])).toEqual(['member_not_included']);
  });
});

describe('validateExpense for every split type', () => {
  it('wants a total above zero, someone included and whole positive weights', () => {
    expect(codes(expense({ total: 0 }), [], include(1))).toEqual(['total_not_positive']);
    expect(codes(expense({ total: -5 }), [], include(1))).toEqual(['total_not_positive']);
    expect(codes(expense({ total: 10.5 }), [], include(1))).toEqual(['invalid_amount']);
    expect(codes(expense({ total: 100 }), [], [])).toEqual(['no_members']);
    expect(codes(expense({ total: 100, splitType: 'portions' }), [], [{ memberId: 1, weight: 0 }])).toEqual(['invalid_weight']);
    expect(codes(expense({ total: 100, splitType: 'portions' }), [], [{ memberId: 1, weight: 1.5 }])).toEqual(['invalid_weight']);
    expect(codes(expense({ total: 100 }), [], [...include(1), ...include(1)])).toEqual(['duplicate_member']);
  });

  it('gives each problem a field and a message', () => {
    const problems = validateExpense(expense({ total: 0 }), [], []);
    expect(problems).toHaveLength(2);
    for (const p of problems) {
      expect(p.field).toMatch(/^(total|shares)$/);
      expect(p.message.length).toBeGreaterThan(10);
    }
  });

  it('computeShares throws with the problems', () => {
    try {
      computeShares(expense({ total: 100 }), [], []);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidExpenseError);
      expect((error as InvalidExpenseError).problems.map((p) => p.code)).toEqual(['no_members']);
    }
  });
});

describe('shares always sum to the total', () => {
  it('for many totals and group sizes', () => {
    for (let total = 1; total <= 250; total += 7) {
      for (let n = 1; n <= 7; n++) {
        const members = Array.from({ length: n }, (_, i) => i + 1);
        expect(sum(computeShares(expense({ total, payerId: 3 }), [], include(...members)))).toBe(BigInt(total));
        const weighted = members.map((memberId) => ({ memberId, weight: memberId * 2 + 1 }));
        expect(sum(computeShares(expense({ total, splitType: 'portions', payerId: 99 }), [], weighted))).toBe(BigInt(total));
        const items = [{ id: 1, amount: total }, { id: 2, amount: 13 }];
        const e = expense({ total: total + 13 + 9 - 4, tip: 9, discount: 4, splitType: 'items', payerId: 2 });
        expect(sum(computeShares(e, items, [...include(...members), assign(2, 1)]))).toBe(BigInt(total + 18));
      }
    }
  });
});
