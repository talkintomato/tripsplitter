import { describe, expect, it } from 'vitest';
import { planMerge, type MergeRecords } from '../../src/core/index.js';

const SURVIVOR = 2;
const ABSORBED = 5;
const none: MergeRecords = { expenses: [], shares: [], settlements: [], tripRates: [] };

describe('planMerge', () => {
  it('moves shares, payer, created-by and set-by to the survivor', () => {
    const plan = planMerge(SURVIVOR, ABSORBED, {
      expenses: [
        { id: 10, payerId: ABSORBED, createdBy: ABSORBED },
        { id: 11, payerId: 3, createdBy: 3 },
        { id: 12, payerId: SURVIVOR, createdBy: 3 },
      ],
      shares: [
        { id: 1, memberId: ABSORBED, expenseId: 10, itemId: null, ownerExpenseId: 10 },
        { id: 2, memberId: ABSORBED, expenseId: null, itemId: 7, ownerExpenseId: 11 },
        { id: 3, memberId: SURVIVOR, expenseId: 12, itemId: null, ownerExpenseId: 12 },
      ],
      settlements: [],
      tripRates: [
        { id: 1, setBy: ABSORBED },
        { id: 2, setBy: SURVIVOR },
        { id: 3, setBy: null },
      ],
    });
    expect(plan).toEqual({
      survivorId: SURVIVOR,
      absorbedId: ABSORBED,
      overlappingExpenseIds: [],
      shareIds: [1, 2],
      payerExpenseIds: [10],
      creatorExpenseIds: [10],
      touchedExpenseIds: [10, 11],
      settlements: [],
      tripRateIds: [1],
    });
  });

  it('reports expenses where both have a share on the expense or on the same item', () => {
    const plan = planMerge(SURVIVOR, ABSORBED, {
      ...none,
      shares: [
        { id: 1, memberId: SURVIVOR, expenseId: 10, itemId: null, ownerExpenseId: 10 },
        { id: 2, memberId: ABSORBED, expenseId: 10, itemId: null, ownerExpenseId: 10 },
        { id: 3, memberId: SURVIVOR, expenseId: null, itemId: 7, ownerExpenseId: 11 },
        { id: 4, memberId: ABSORBED, expenseId: null, itemId: 7, ownerExpenseId: 11 },
        // Different items of one expense are no overlap.
        { id: 5, memberId: SURVIVOR, expenseId: null, itemId: 8, ownerExpenseId: 12 },
        { id: 6, memberId: ABSORBED, expenseId: null, itemId: 9, ownerExpenseId: 12 },
      ],
    });
    expect(plan.overlappingExpenseIds).toEqual([10, 11]);
  });

  it('moves both ends of every settlement, undone ones included, and undoes one that would be from a member to themselves', () => {
    const plan = planMerge(SURVIVOR, ABSORBED, {
      ...none,
      settlements: [
        { id: 20, createdBy: 3, fromMemberId: ABSORBED, toMemberId: SURVIVOR, status: 'active' },
        { id: 21, createdBy: 3, fromMemberId: SURVIVOR, toMemberId: ABSORBED, status: 'undone' },
        { id: 22, createdBy: ABSORBED, fromMemberId: ABSORBED, toMemberId: 3, status: 'active' },
        { id: 23, createdBy: 3, fromMemberId: 3, toMemberId: ABSORBED, status: 'undone' },
        { id: 24, createdBy: 3, fromMemberId: 3, toMemberId: SURVIVOR, status: 'active' },
        { id: 25, createdBy: ABSORBED, fromMemberId: 3, toMemberId: 4, status: 'active' },
      ],
    });
    expect(plan.settlements).toEqual([
      { id: 20, fromMemberId: SURVIVOR, toMemberId: SURVIVOR, createdBy: 3, undo: true },
      { id: 21, fromMemberId: SURVIVOR, toMemberId: SURVIVOR, createdBy: 3, undo: false },
      { id: 22, fromMemberId: SURVIVOR, toMemberId: 3, createdBy: SURVIVOR, undo: false },
      { id: 23, fromMemberId: 3, toMemberId: SURVIVOR, createdBy: 3, undo: false },
      { id: 25, fromMemberId: 3, toMemberId: 4, createdBy: SURVIVOR, undo: false },
    ]);
  });

  it('plans nothing when the absorbed member has no records', () => {
    const plan = planMerge(SURVIVOR, ABSORBED, {
      ...none,
      expenses: [{ id: 10, payerId: SURVIVOR, createdBy: 3 }],
      shares: [{ id: 1, memberId: SURVIVOR, expenseId: 10, itemId: null, ownerExpenseId: 10 }],
    });
    expect(plan.touchedExpenseIds).toEqual([]);
    expect(plan.shareIds).toEqual([]);
  });

  it('refuses to merge a member with themselves', () => {
    expect(() => planMerge(2, 2, none)).toThrow(RangeError);
  });
});
