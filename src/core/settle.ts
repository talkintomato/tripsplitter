import { toBigInt } from './amounts.js';
import type { Amount, Payment } from './types.js';

/**
 * A short list of payments that settles every balance. Repeatedly matches the member owed the most with
 * the member who owes the most and pays the smaller of the two amounts. Ties go to the lowest member ID.
 * At most N-1 payments for N members, and the same output for the same input whatever the order of the map.
 * Not guaranteed to be the shortest possible list. Does not change its input.
 */
export function suggestPayments(balances: ReadonlyMap<number, Amount>): Payment[] {
  const open = [...balances]
    .map(([memberId, amount]) => ({ memberId, amount: toBigInt(amount) }))
    .filter((entry) => entry.amount !== 0n)
    .sort((a, b) => a.memberId - b.memberId);

  const payments: Payment[] = [];
  for (;;) {
    let creditor: { memberId: number; amount: bigint } | undefined;
    let debtor: { memberId: number; amount: bigint } | undefined;
    // `open` is sorted by ID and the comparisons are strict, so the lowest ID wins a tie.
    for (const entry of open) {
      if (entry.amount > 0n && (!creditor || entry.amount > creditor.amount)) creditor = entry;
      if (entry.amount < 0n && (!debtor || entry.amount < debtor.amount)) debtor = entry;
    }
    if (!creditor || !debtor) break;
    const amount = creditor.amount < -debtor.amount ? creditor.amount : -debtor.amount;
    payments.push({ fromMemberId: debtor.memberId, toMemberId: creditor.memberId, amount });
    creditor.amount -= amount;
    debtor.amount += amount;
  }
  return payments;
}
