import { expenseNoticeContext } from '../tools/notice-context.js';
import { computeShares, formatAmount, fromMinorUnits, type ExpenseNotice, type NoticeShare, type SettlementNotice } from '../core/index.js';
import { listMembers, type Db, type ExpenseDetail, type Scope, type Settlement, type Trip } from '../db/index.js';
import type { Caller } from './context.js';

/**
 * Sends one notice after a change has committed. A notice that fails is logged and never fails the request.
 * The request waits for the notice, so that the order of messages in the group matches the order of changes.
 */
export async function notify(name: string, send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (error) {
    console.error(`Could not send the notice ${name}:`, error instanceof Error ? error.name : 'UnknownError');
  }
}

function memberNames(db: Db, scope: Scope): Map<number, string> {
  return new Map(listMembers(db, scope, { includeMerged: true }).map((m) => [m.id, m.displayName]));
}

const nameOf = (names: Map<number, string>, id: number): string => names.get(id) ?? 'Someone';

/** What to call the expense in a message. */
export function expenseLabel(expense: { description: string; merchant: string | null }): string {
  return expense.description.trim() || expense.merchant?.trim() || 'an expense';
}

export function expenseNotice(db: Db, caller: Caller, expense: ExpenseDetail): ExpenseNotice {
  const names = memberNames(db, caller.scope);
  let shares: NoticeShare[] = [];
  try {
    shares = [...computeShares(expense, expense.items, expense.shares)].map(([memberId, amount]) => ({
      name: nameOf(names, memberId),
      amount,
    }));
  } catch {
    // An expense that cannot be split is announced without amounts.
  }
  return {
    chatId: caller.group.chatId,
    actorName: caller.member.displayName,
    expenseId: expense.id,
    personal: expenseNoticeContext(db, caller.scope, expense),
    groupId: caller.group.id,
    description: expenseLabel(expense),
    total: expense.total,
    currency: expense.currency,
    splitType: expense.splitType,
    shares,
  };
}

export function settlementNotice(db: Db, caller: Caller, settlement: Settlement, trip: Trip): SettlementNotice {
  const names = memberNames(db, caller.scope);
  return {
    chatId: caller.group.chatId,
    actorName: caller.member.displayName,
    groupId: caller.group.id, actorMemberId: caller.member.id, tripId: trip.id, tripName: trip.name,
    fromMemberId: settlement.fromMemberId, toMemberId: settlement.toMemberId,
    fromName: nameOf(names, settlement.fromMemberId),
    toName: nameOf(names, settlement.toMemberId),
    amount: settlement.amount,
    currency: trip.homeCurrency,
  };
}

const SPLIT_LABEL = { even: 'evenly', portions: 'by portions', items: 'by item' } as const;

function includedKey(expense: ExpenseDetail): string {
  return expense.shares
    .filter((s) => s.itemId === null)
    .map((s) => `${s.memberId}:${s.weight}`)
    .sort()
    .join(',');
}

function itemsKey(expense: ExpenseDetail): string {
  const byItem = new Map<number, string[]>();
  for (const share of expense.shares) {
    if (share.itemId === null) continue;
    byItem.set(share.itemId, [...(byItem.get(share.itemId) ?? []), `${share.memberId}:${share.weight}`]);
  }
  return JSON.stringify(expense.items.map((item) => [item.label, item.quantity, item.amount, (byItem.get(item.id) ?? []).sort()]));
}

/** What changed between two versions of an expense, as short phrases for the group: "total 84.50 to 88.50 SGD". */
export function describeChanges(db: Db, scope: Scope, before: ExpenseDetail, after: ExpenseDetail): string[] {
  const names = memberNames(db, scope);
  const changes: string[] = [];
  const money = (label: string, a: number, b: number): void => {
    const sameCurrency = before.currency === after.currency;
    if (a === b && sameCurrency) return;
    if (a === 0 && b === 0) return;
    const from = sameCurrency ? fromMinorUnits(a, before.currency) : formatAmount(a, before.currency);
    changes.push(`${label} ${from} to ${formatAmount(b, after.currency)}`);
  };
  money('total', before.total, after.total);
  if (before.description !== after.description) changes.push(`name "${before.description}" to "${after.description}"`);
  if ((before.merchant ?? '') !== (after.merchant ?? '')) changes.push(`place "${before.merchant ?? ''}" to "${after.merchant ?? ''}"`);
  if (before.expenseDate !== after.expenseDate) changes.push(`date ${before.expenseDate} to ${after.expenseDate}`);
  if (before.payerId !== after.payerId) changes.push(`paid by ${nameOf(names, before.payerId)} to ${nameOf(names, after.payerId)}`);
  if (before.splitType !== after.splitType) changes.push(`split ${SPLIT_LABEL[before.splitType]} to ${SPLIT_LABEL[after.splitType]}`);
  if (includedKey(before) !== includedKey(after)) changes.push('who is included');
  if (itemsKey(before) !== itemsKey(after)) changes.push('items');
  money('tax', before.tax, after.tax);
  if (before.taxIncluded !== after.taxIncluded) changes.push(after.taxIncluded ? 'tax already in the prices' : 'tax added on top');
  money('tip', before.tip, after.tip);
  money('service charge', before.serviceCharge, after.serviceCharge);
  money('discount', before.discount, after.discount);
  if (before.fxRate !== after.fxRate && before.currency === after.currency) changes.push('exchange rate');
  return changes;
}
