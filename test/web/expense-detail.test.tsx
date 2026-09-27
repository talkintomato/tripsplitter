// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { GroupResponse, Trip } from '../../web/src/api/types';
import { ExpenseDetail } from '../../web/src/screens/Expense';
import { AppProvider } from '../../web/src/state';
import { MEMBERS, SAM, expenseView, fakeClient } from './helpers';

afterEach(cleanup);
it('shows API amounts, the rate source, and explicit and shared item diners', async () => {
  const client = fakeClient();
  const trip: Trip = { id: 1, groupId: 1, name: 'Japan', homeCurrency: 'SGD', homeCurrencyLocked: true, status: 'active', setupDone: true, createdAt: '', endedAt: null };
  const expense = expenseView({
    currency: 'JPY', total: 11240, fxRate: '112.4', fxRateSource: 'expense', homeTotal: 10000, splitType: 'items',
    items: [
      { id: 10, expenseId: 7, label: 'Ramen', quantity: 1, amount: 10000, position: 0 },
      { id: 11, expenseId: 7, label: 'Tea', quantity: 1, amount: 1240, position: 1 },
    ],
    shares: [...expenseView().shares, { id: 8, memberId: SAM.id, weight: 1, expenseId: null, itemId: 10 }],
  });
  client.getExpense.mockResolvedValue({ expense });
  client.getTrip.mockResolvedValue({ trip });
  const group: GroupResponse = { group: { id: 1, title: 'Friends', linkVersion: 1 }, me: SAM, members: MEMBERS, access: 'write', activeTrip: trip, newTripCurrency: 'SGD', destination: { view: 'home' }, link: '' };
  render(<AppProvider value={{ client, group, refresh: vi.fn(), setGroup: vi.fn() }}><MemoryRouter initialEntries={['/expenses/7']}><Routes><Route path="/expenses/:id" element={<ExpenseDetail />} /></Routes></MemoryRouter></AppProvider>);
  expect(await screen.findByText('11,240 JPY')).toBeInTheDocument();
  expect(screen.getByText('= 100.00 SGD')).toBeInTheDocument();
  expect(screen.getByText('Rate: 1 SGD = 112.4 JPY')).toBeInTheDocument();
  expect(screen.getByText("This expense's own rate")).toBeInTheDocument();
  expect(within(screen.getByText('Ramen').closest('li')!).getByText('Sam')).toBeInTheDocument();
  expect(within(screen.getByText('Tea').closest('li')!).getByText('Ana, Sam, Leo')).toBeInTheDocument();
});
