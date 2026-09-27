/** The records of a group that `planMerge` looks at. Rows from `src/db` fit these types. */
export interface MergeRecords {
  expenses: ReadonlyArray<{ id: number; payerId: number; createdBy: number }>;
  /** Every share of the group. `ownerExpenseId` is the expense the share belongs to, also for item shares. */
  shares: ReadonlyArray<{
    id: number;
    memberId: number;
    expenseId: number | null;
    itemId: number | null;
    ownerExpenseId: number;
  }>;
  settlements: ReadonlyArray<{
    id: number;
    createdBy: number;
    fromMemberId: number;
    toMemberId: number;
    status: string;
  }>;
  tripRates: ReadonlyArray<{ id: number; setBy: number | null }>;
}

export interface MergePlan {
  survivorId: number;
  absorbedId: number;
  /**
   * IDs of expenses on which both members have a share on the expense itself or on the same item.
   * When this is not empty the merge must be refused and nothing else in the plan applies.
   */
  overlappingExpenseIds: number[];
  /** Shares that move to the survivor. */
  shareIds: number[];
  /** Expenses whose payer moves to the survivor. */
  payerExpenseIds: number[];
  /** Expenses whose creator moves to the survivor. */
  creatorExpenseIds: number[];
  /** Every expense touched: its version goes up by one and one activity entry is written. */
  touchedExpenseIds: number[];
  /**
   * Settlements touched. Each end and the creator move to the survivor where they were the absorbed member.
   * `undo` is true for an active settlement that would then be from a member to themselves.
   */
  settlements: Array<{ id: number; fromMemberId: number; toMemberId: number; createdBy: number; undo: boolean }>;
  /** Trip rates whose set-by moves to the survivor. */
  tripRateIds: number[];
}

/**
 * The changes needed to fold member `absorbedId` into member `survivorId`, across all trips of the group.
 * Pure: changes nothing itself.
 *
 * - Both members on the same expense or the same item: reported in `overlappingExpenseIds`.
 * - Shares, payer, created-by and set-by references move to the survivor.
 * - Both ends of every settlement move, undone ones included. A settlement that would then be from a
 *   member to themselves is marked undone.
 *
 * Throws RangeError when survivor and absorbed are the same member.
 */
export function planMerge(survivorId: number, absorbedId: number, records: MergeRecords): MergePlan {
  if (survivorId === absorbedId) throw new RangeError('A member cannot be merged with themselves.');
  const byId = (a: number, b: number) => a - b;

  const target = (s: { expenseId: number | null; itemId: number | null }) => (s.itemId !== null ? `i${s.itemId}` : `e${s.expenseId}`);
  const survivorTargets = new Set(records.shares.filter((s) => s.memberId === survivorId).map(target));
  const overlapping = new Set<number>();
  const shareIds: number[] = [];
  const touched = new Set<number>();
  for (const share of records.shares) {
    if (share.memberId !== absorbedId) continue;
    if (survivorTargets.has(target(share))) overlapping.add(share.ownerExpenseId);
    shareIds.push(share.id);
    touched.add(share.ownerExpenseId);
  }

  const payerExpenseIds: number[] = [];
  const creatorExpenseIds: number[] = [];
  for (const expense of records.expenses) {
    if (expense.payerId === absorbedId) {
      payerExpenseIds.push(expense.id);
      touched.add(expense.id);
    }
    if (expense.createdBy === absorbedId) {
      creatorExpenseIds.push(expense.id);
      touched.add(expense.id);
    }
  }

  const move = (memberId: number) => (memberId === absorbedId ? survivorId : memberId);
  const settlements: MergePlan['settlements'] = [];
  for (const settlement of records.settlements) {
    const involved =
      settlement.fromMemberId === absorbedId || settlement.toMemberId === absorbedId || settlement.createdBy === absorbedId;
    if (!involved) continue;
    const fromMemberId = move(settlement.fromMemberId);
    const toMemberId = move(settlement.toMemberId);
    settlements.push({
      id: settlement.id,
      fromMemberId,
      toMemberId,
      createdBy: move(settlement.createdBy),
      undo: fromMemberId === toMemberId && settlement.status === 'active',
    });
  }

  return {
    survivorId,
    absorbedId,
    overlappingExpenseIds: [...overlapping].sort(byId),
    shareIds: shareIds.sort(byId),
    payerExpenseIds: payerExpenseIds.sort(byId),
    creatorExpenseIds: creatorExpenseIds.sort(byId),
    touchedExpenseIds: [...touched].sort(byId),
    settlements: settlements.sort((a, b) => a.id - b.id),
    tripRateIds: records.tripRates.filter((r) => r.setBy === absorbedId).map((r) => r.id).sort(byId),
  };
}
