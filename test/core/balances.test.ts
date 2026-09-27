import { describe, expect, it } from 'vitest';
import {
  InvalidExpenseError,
  computeBalances,
  computeShares,
  convertExpense,
  type BalanceExpense,
  type BalanceSettlement,
} from '../../src/core/index.js';

const even = (over: Partial<BalanceExpense> & { members: number[] }): BalanceExpense => {
  const { members, ...rest } = over;
  return {
    id: 1,
    status: 'confirmed',
    payerId: 1,
    total: 0,
    tax: 0,
    taxIncluded: false,
    tip: 0,
    serviceCharge: 0,
    discount: 0,
    splitType: 'even',
    currency: 'SGD',
    fxRate: '1',
    items: [],
    shares: members.map((memberId) => ({ memberId, weight: 1, expenseId: 1, itemId: null })),
    ...rest,
  };
};
const obj = (map: Map<number, bigint>) => Object.fromEntries([...map].map(([id, amount]) => [id, Number(amount)]));
const sum = (map: Map<number, bigint>) => [...map.values()].reduce((a, b) => a + b, 0n);
const converted = (e: BalanceExpense, home: string) => convertExpense(e, computeShares(e, e.items, e.shares), home);

const lunch = even({ id: 1, total: 3000, payerId: 1, members: [1, 2, 3] });
// 1 SGD = 112.4 JPY. 11240 JPY is 100.00 SGD.
const ramen = even({ id: 2, total: 11240, payerId: 2, currency: 'JPY', fxRate: '112.4', members: [1, 2, 3] });

describe('convertExpense', () => {
  it('shares that do not convert exactly: converted shares sum to the converted total', () => {
    // JPY shares 3746, 3748 (payer, with the leftover 2), 3746.
    // In SGD minor units, rounded down: 3332, 3334, 3332 = 9998. Leftover 2 to the payer.
    const { total, shares } = converted(ramen, 'SGD');
    expect(total).toBe(10000n);
    expect(obj(shares)).toEqual({ 1: 3332, 2: 3336, 3: 3332 });
    expect(sum(shares)).toBe(total);
  });

  it('gives the leftover to the lowest ID when the payer is not included', () => {
    const { total, shares } = converted({ ...ramen, payerId: 9 }, 'SGD');
    expect(total).toBe(10000n);
    // JPY shares 3748 (lowest ID), 3746, 3746 -> 3334, 3332, 3332 = 9998, leftover 2 to member 1.
    expect(obj(shares)).toEqual({ 1: 3336, 2: 3332, 3: 3332 });
  });

  it('rounds the total half up and the shares down', () => {
    // 1 SGD = 3 THB. 1.00 THB is 33.33 cents: total 33. Two shares of 0.50 THB are 16.67 each, down to 16.
    const e = even({ total: 100, payerId: 2, currency: 'THB', fxRate: '3', members: [1, 2] });
    const { total, shares } = converted(e, 'SGD');
    expect(total).toBe(33n);
    expect(obj(shares)).toEqual({ 1: 16, 2: 17 });
    // 0.50 THB is 16.67 cents: total rounds up to 17.
    expect(converted(even({ total: 50, currency: 'THB', fxRate: '3', members: [1] }), 'SGD').total).toBe(17n);
  });

  it('an SGD expense in a JPY-home trip', () => {
    // 1 JPY = 0.0089 SGD. 10.00 SGD is 1123.6 JPY, rounded half up to 1124.
    const e = even({ total: 1000, payerId: 1, currency: 'SGD', fxRate: '0.0089', members: [1, 2] });
    const { total, shares } = converted(e, 'JPY');
    expect(total).toBe(1124n);
    // 5.00 SGD is 561.8 JPY, down to 561 each. Leftover 2 to the payer.
    expect(obj(shares)).toEqual({ 1: 563, 2: 561 });
    expect(obj(computeBalances([e], [], 'JPY'))).toEqual({ 1: 561, 2: -561 });
  });

  it('throws when the rate is missing', () => {
    expect(() => converted({ ...ramen, fxRate: null }, 'SGD')).toThrow(InvalidExpenseError);
  });
});

describe('computeBalances', () => {
  it('balances across two currencies sum to zero', () => {
    const balances = computeBalances([lunch, ramen], [], 'SGD');
    // Member 1 paid 30.00, owes 10.00 + 33.32. Member 2 paid 100.00, owes 10.00 + 33.36. Member 3 owes 10.00 + 33.32.
    expect(obj(balances)).toEqual({ 1: -1332, 2: 5664, 3: -4332 });
    expect(sum(balances)).toBe(0n);
    expect(typeof balances.get(1)).toBe('bigint');
  });

  it('counts only confirmed expenses and active settlements', () => {
    const expenses: BalanceExpense[] = [
      lunch,
      ramen,
      { ...lunch, id: 3, status: 'draft', total: 99999 },
      { ...lunch, id: 4, status: 'deleted', total: 99999 },
      { ...lunch, id: 5, status: 'discarded', total: 99999 },
      // A draft without a rate or with nobody included must not break anything.
      { ...ramen, id: 6, status: 'draft', fxRate: null, shares: [] },
    ];
    const settlements: BalanceSettlement[] = [
      { fromMemberId: 3, toMemberId: 2, amount: 1000, status: 'active' },
      { fromMemberId: 1, toMemberId: 2, amount: 5000, status: 'undone' },
    ];
    const balances = computeBalances(expenses, settlements, 'SGD');
    // The member who paid the settlement is credited, the receiver debited.
    expect(obj(balances)).toEqual({ 1: -1332, 2: 4664, 3: -3332 });
    expect(sum(balances)).toBe(0n);
  });

  it('is empty without anything', () => {
    expect(computeBalances([], [], 'SGD').size).toBe(0);
  });

  it('shows a payer who is not included as owed the whole amount', () => {
    const balances = computeBalances([even({ total: 1000, payerId: 4, members: [1, 2, 3] })], [], 'SGD');
    expect(obj(balances)).toEqual({ 1: -334, 2: -333, 3: -333, 4: 1000 });
  });

  it('sums to zero over many rates and totals', () => {
    for (const rate of ['112.4', '0.75', '3', '11500', '0.000123', '7.123456']) {
      for (let total = 1; total < 4000; total += 397) {
        const e = even({ total, payerId: 2, currency: 'JPY', fxRate: rate, members: [1, 2, 3, 4] });
        expect(sum(computeBalances([e, lunch], [], 'SGD'))).toBe(0n);
      }
    }
  });
});
