// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseView, GroupResponse, Settlement } from '../../web/src/api/types';
import { ExpenseList, ExpenseRow } from '../../web/src/components/ExpenseRow';
import { groupByDay } from '../../web/src/dayGroups';
import { AppProvider } from '../../web/src/state';
import { ANA, MEMBERS, SAM, expenseView, fakeClient } from './helpers';

afterEach(cleanup);

const group: GroupResponse = { group: { id: 1, title: 'Friends', linkVersion: 1 }, me: SAM, members: MEMBERS, access: 'write', activeTrip: null, newTripCurrency: 'SGD', destination: { view: 'home' }, link: '' };
// Noon on Monday 28 September 2026, on this machine's clock.
const NOW = new Date(2026, 8, 28, 12, 0);

function show(ui: React.ReactNode) {
  render(<AppProvider value={{ client: fakeClient(), group, refresh: vi.fn(), setGroup: vi.fn() }}><MemoryRouter>{ui}</MemoryRouter></AppProvider>);
}

const on = (id: number, date: string, over: Partial<ExpenseView> = {}) =>
  expenseView({ id, description: `Expense ${id}`, expenseDate: date, createdAt: `${date}T08:00:00.000Z`, ...over });

describe('the list grouped by day', () => {
  it('puts the newest day first, calls today and yesterday by name, and adds the year only for another year', () => {
    const expenses = [on(1, '2025-12-30'), on(2, '2026-09-27'), on(3, '2026-09-28'), on(4, '2026-09-25'), on(5, '2026-09-28', { createdAt: '2026-09-28T09:00:00.000Z' })];
    show(<ExpenseList expenses={expenses} settlements={[]} currency="SGD" now={NOW} empty="None" />);
    const heads = screen.getAllByRole('heading', { level: 3 }).map((h) => h.firstChild?.textContent);
    expect(heads).toEqual(['Today', 'Yesterday', 'Fri 25 Sep', 'Tue 30 Dec 2025']);
    // Within a day, the newest first; rows carry no date of their own.
    const today = screen.getByRole('region', { name: 'Today' });
    expect(within(today).getAllByRole('link').map((a) => a.querySelector('.row-title')?.textContent)).toEqual(['Expense 5', 'Expense 3']);
    expect(within(today).queryByText(/Sep/)).not.toBeInTheDocument();
    // The day's total, from the converted totals of its expenses.
    expect(within(today).getByText('60.00 SGD')).toBeInTheDocument();
  });

  it('leaves the day total out when an expense has no converted total, and puts a payment on its day', () => {
    const settlement: Settlement = { id: 1, groupId: 1, tripId: 1, fromMemberId: ANA.id, toMemberId: SAM.id, amount: 2000, status: 'active', createdBy: 1, createdAt: new Date(2026, 8, 28, 9).toISOString(), version: 1 } as Settlement;
    const days = groupByDay([on(1, '2026-09-28', { homeTotal: null })], [settlement], NOW);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ label: 'Today', total: null });
    show(<ExpenseList expenses={[]} settlements={[settlement]} currency="SGD" now={NOW} empty="None" />);
    expect(screen.getByText('Payment')).toBeInTheDocument();
    expect(screen.getByText('Ana paid you')).toBeInTheDocument();
  });

  it('says so when there is nothing', () => {
    show(<ExpenseList expenses={[]} settlements={[]} currency="SGD" now={NOW} empty="No expenses yet. Add the first one." />);
    expect(screen.getByText('No expenses yet. Add the first one.')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});

describe("a row's stake", () => {
  it('says what the person lent, what they borrowed, or nothing', () => {
    show(<ul>
      <li><ExpenseRow expense={expenseView({ id: 1, description: 'Lent', myStake: { kind: 'lent', amount: 2000, currency: 'SGD' } })} /></li>
      <li><ExpenseRow expense={expenseView({ id: 2, description: 'Borrowed', payerId: ANA.id, myStake: { kind: 'borrowed', amount: 1250, currency: 'SGD' } })} /></li>
      <li><ExpenseRow expense={expenseView({ id: 3, description: 'Not mine', myStake: { kind: 'none', amount: 0, currency: 'SGD' } })} /></li>
    </ul>);
    const row = (title: string) => screen.getByText(title).closest('a') as HTMLElement;
    expect(within(row('Lent')).getByText('you lent 20.00 SGD')).toHaveClass('stake-lent');
    expect(within(row('Borrowed')).getByText('you borrowed 12.50 SGD')).toHaveClass('stake-borrowed');
    expect(within(row('Borrowed')).getByText('Paid by Ana')).toBeInTheDocument();
    expect(within(row('Not mine')).queryByText(/you /)).not.toBeInTheDocument();
  });

  it('shows a leading emoji of the title as the picture of the row', () => {
    show(<ExpenseRow expense={expenseView({ description: '🍜 Ramen' })} />);
    expect(screen.getByText('Ramen')).toHaveClass('row-title');
    expect(screen.getByText('🍜')).toHaveClass('tile');
  });
});
