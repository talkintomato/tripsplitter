import { vi } from 'vitest';
import type { ApiClient } from '../../web/src/api/client';
import { convertExpense } from '../../src/core/balances';
import { computeShares, validateExpense } from '../../src/core/split';
import type { CreateExpenseBody, ExpensePreviewResponse, ExpenseView, ExpenseWriteResponse, Member } from '../../web/src/api/types';

export function member(id: number, displayName: string, over: Partial<Member> = {}): Member {
  return {
    id,
    groupId: 1,
    telegramUserId: 100 + id,
    displayName,
    username: null,
    active: true,
    joinedVia: 'chat',
    mergedInto: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

export const ANA = member(1, 'Ana');
export const SAM = member(2, 'Sam');
export const LEO = member(3, 'Leo', { telegramUserId: null, joinedVia: 'manual' });
/** Left the chat: listed only when already on the expense. */
export const KAI = member(4, 'Kai', { active: false });
export const MEMBERS = [ANA, KAI, LEO, SAM];

/** A saved expense as the API returns it: 30.00 SGD for dinner, paid by Ana, split evenly by three. */
export function expenseView(over: Partial<ExpenseView> = {}): ExpenseView {
  return {
    id: 7,
    tripId: 1,
    createdBy: 1,
    payerId: 1,
    description: 'Dinner',
    merchant: 'Casa Pepe',
    expenseDate: '2026-09-20',
    total: 3000,
    tax: 0,
    taxIncluded: false,
    tip: 0,
    serviceCharge: 0,
    discount: 0,
    currency: 'SGD',
    currencyNeedsReview: false,
    fxRate: '1',
    fxRateSource: 'home',
    splitType: 'even',
    receiptFileId: 'file-abc',
    status: 'confirmed',
    statusBeforeRemoval: null,
    version: 3,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    items: [],
    shares: [
      { id: 1, memberId: 1, weight: 1, expenseId: 7, itemId: null },
      { id: 2, memberId: 2, weight: 1, expenseId: 7, itemId: null },
      { id: 3, memberId: 3, weight: 1, expenseId: 7, itemId: null },
    ],
    homeCurrency: 'SGD',
    amounts: { 1: 1000, 2: 1000, 3: 1000 },
    homeTotal: 3000,
    homeAmounts: { 1: 1000, 2: 1000, 3: 1000 },
    problems: [],
    notice: null,
    myStake: { kind: 'lent', amount: 2000, currency: 'SGD' },
    ...over,
  };
}

export function written(expense: ExpenseView): ExpenseWriteResponse {
  return { expense, rateSet: null, keptAsDraft: false };
}

/** A client whose every function is a mock that fails unless the test says what it returns. */
export function fakeClient(): { [K in keyof ApiClient]: ReturnType<typeof vi.fn> } & ApiClient {
  const names: Array<keyof ApiClient> = [
    'request', 'setLaunch', 'getMyGroups', 'getGroup', 'resetLink', 'addMember', 'claimMember', 'listActivity', 'listTrips', 'createTrip', 'getTrip',
    'patchTrip', 'endTrip', 'reopenTrip', 'listExpenses', 'createExpense', 'previewExpense', 'getExpense', 'saveExpense', 'confirmExpense',
    'discardExpense', 'deleteExpense', 'restoreExpense', 'getBalances', 'createSettlement', 'undoSettlement', 'restoreSettlement',
  ];
  const client = Object.fromEntries(
    names.map((name) => [name, vi.fn(() => Promise.reject(new Error(`The test did not expect a call to ${name}`)))]),
  );
  return client as unknown as { [K in keyof ApiClient]: ReturnType<typeof vi.fn> } & ApiClient;
}

/**
 * What the server answers to a preview, for a client that has no server: the same two functions of the
 * foundation that the route calls.
 */
export function previewAnswer(body: CreateExpenseBody, loaded?: ExpenseView): ExpensePreviewResponse {
  const expense = {
    payerId: body.payerId,
    total: body.total,
    tax: body.tax ?? 0,
    taxIncluded: body.taxIncluded ?? false,
    tip: body.tip ?? 0,
    serviceCharge: body.serviceCharge ?? 0,
    discount: body.discount ?? 0,
    splitType: body.splitType,
  };
  const items = (body.items ?? []).map((item, index) => ({ id: index, amount: item.amount }));
  const shares = [
    ...body.shares.map((s) => ({ memberId: s.memberId, weight: s.weight ?? 1, itemId: null })),
    ...(body.items ?? []).flatMap((item, index) => (item.shares ?? []).map((s) => ({ memberId: s.memberId, weight: s.weight ?? 1, itemId: index }))),
  ];
  const problems = validateExpense(expense, items, shares);
  const amounts: Record<number, number> = {};
  if (problems.length === 0) for (const [id, amount] of computeShares(expense, items, shares)) amounts[id] = Number(amount);
  const currency = body.currency ?? 'SGD';
  const fxRate = currency === 'SGD' ? '1' : body.rateOverride ?? (loaded?.currency === currency ? loaded.fxRate : null);
  const fxRateSource = currency === 'SGD' ? 'home' : body.rateOverride ? 'expense' : loaded?.fxRateSource ?? 'missing';
  let homeTotal: number | null = null;
  if (fxRate && problems.length === 0) homeTotal = Number(convertExpense({ ...expense, currency, fxRate }, new Map(Object.entries(amounts).map(([id, amount]) => [Number(id), BigInt(amount)])), 'SGD').total);
  return {
    fx: { fxRate, fxRateSource, homeTotal, homeCurrency: 'SGD' },
    corrections: {
      total: problems.some((p) => p.code === 'total_mismatch') ? body.total - (problems.find((p) => p.code === 'total_mismatch')?.difference ?? 0) : null,
      discount: (problems.find((p) => p.code === 'total_mismatch')?.difference ?? 0) < 0 ? (body.discount ?? 0) - (problems.find((p) => p.code === 'total_mismatch')?.difference ?? 0) : null,
    },
    amounts: problems.length === 0 ? amounts : null,
    problems,
    difference: problems.find((p) => p.code === 'total_mismatch')?.difference ?? null,
  };
}
