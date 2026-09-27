// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ActivityEntry, ExpenseView, GroupResponse, Trip } from '../../web/src/api/types';
import { ExpenseDetail } from '../../web/src/screens/Expense';
import { AppProvider } from '../../web/src/state';
import { ANA, MEMBERS, SAM, expenseView, fakeClient } from './helpers';

afterEach(cleanup);

const trip: Trip = { id: 1, groupId: 1, name: 'Japan', homeCurrency: 'SGD', homeCurrencyLocked: true, status: 'active', setupDone: true, createdAt: '', endedAt: null };
const group: GroupResponse = { group: { id: 1, title: 'Friends', linkVersion: 1 }, me: SAM, members: MEMBERS, access: 'write', activeTrip: trip, newTripCurrency: 'SGD', destination: { view: 'home' }, link: '' };

let nextId = 100;
function entry(action: string, over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: nextId--, groupId: 1, tripId: 1, actor: { kind: 'member', memberId: ANA.id }, action, entityType: 'expense', entityId: 7,
    before: null, after: expenseView(), createdAt: '2026-09-20T10:00:00.000Z', actorName: 'Ana', restore: null, ...over,
  } as ActivityEntry;
}

function open(expense: ExpenseView, entries: ActivityEntry[] = []) {
  const client = fakeClient();
  client.getExpense.mockResolvedValue({ expense });
  client.getTrip.mockResolvedValue({ trip });
  client.listActivity.mockResolvedValue({ entries, nextBefore: null });
  render(<AppProvider value={{ client, group, refresh: vi.fn(), setGroup: vi.fn() }}><MemoryRouter initialEntries={['/expenses/7']}><Routes><Route path="/expenses/:id" element={<ExpenseDetail />} /></Routes></MemoryRouter></AppProvider>);
  return client;
}

it('shows API amounts, the rate source, and explicit and shared item diners', async () => {
  const expense = expenseView({
    currency: 'JPY', total: 11240, fxRate: '112.4', fxRateSource: 'expense', homeTotal: 10000, splitType: 'items',
    items: [
      { id: 10, expenseId: 7, label: 'Ramen', quantity: 1, amount: 10000, position: 0 },
      { id: 11, expenseId: 7, label: 'Tea', quantity: 1, amount: 1240, position: 1 },
    ],
    shares: [...expenseView().shares, { id: 8, memberId: SAM.id, weight: 1, expenseId: null, itemId: 10 }],
  });
  open(expense);
  expect(await screen.findByText('11,240 JPY')).toBeInTheDocument();
  expect(screen.getByText('= 100.00 SGD')).toBeInTheDocument();
  expect(screen.getByText('1 SGD = 112.4 JPY')).toBeInTheDocument();
  expect(screen.getByText("This expense's own rate")).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Change exchange rate' })).toBeInTheDocument();
  expect(within(screen.getByText('Ramen').closest('li')!).getByText('Sam')).toBeInTheDocument();
  expect(within(screen.getByText('Tea').closest('li')!).getByText('Ana, Sam, Leo')).toBeInTheDocument();
});

it("lists the expense's own history, three at first and all on request, with what each edit changed", async () => {
  const before = expenseView({ total: 3000, payerId: ANA.id });
  const after = expenseView({ total: 4500, payerId: SAM.id, splitType: 'items', items: [{ id: 1, expenseId: 7, label: 'Paella', quantity: 1, amount: 4500, position: 0 }] });
  const entries = [
    entry('expense.save', { before, after, actorName: 'Sam' }),
    entry('expense.restore'),
    entry('expense.delete'),
    entry('expense.save', { before: expenseView({ description: 'Lunch' }), after: expenseView() }),
    entry('expense.create'),
    // Another record's entry, which an older server may send: never shown here.
    entry('expense.create', { entityId: 99 }),
  ];
  const user = userEvent.setup();
  const client = open(expenseView(), entries);
  const history = await screen.findByRole('list', { name: 'History' });
  expect(client.listActivity).toHaveBeenCalledWith({ entity: { type: 'expense', id: 7 } });
  expect(within(history).getAllByRole('listitem').filter((li) => li.classList.contains('history-item'))).toHaveLength(3);
  const edit = within(history).getAllByRole('listitem')[0]!;
  expect(within(edit).getByText('Edited')).toBeInTheDocument();
  expect(within(edit).getByText('Amount: 30.00 SGD → 45.00 SGD')).toBeInTheDocument();
  expect(within(edit).getByText('Paid by: Ana → Sam')).toBeInTheDocument();
  expect(within(edit).getByText('Split: Equally → By item')).toBeInTheDocument();
  expect(within(edit).getByText(/^Sam · /)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Show all (5)' }));
  expect(within(history).getAllByRole('listitem').filter((li) => li.classList.contains('history-item'))).toHaveLength(5);
  expect(within(history).getByText('Description: Lunch → Dinner')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
});

it('shows a single entry alone, and says a receipt draft was read from a receipt', async () => {
  const draft = expenseView({ status: 'draft', receiptFileId: 'file-abc' });
  open(draft, [entry('expense.create', { after: draft })]);
  const history = await screen.findByRole('list', { name: 'History' });
  expect(within(history).getByText('Read from a receipt')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Review and approve' })).toBeInTheDocument();
});
