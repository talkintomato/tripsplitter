// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ActivityEntry, GroupResponse, Trip } from '../../web/src/api/types';
import { ACTIVITY_BATCH, Activity } from '../../web/src/screens/Activity';
import { AppProvider } from '../../web/src/state';
import { ANA, MEMBERS, SAM, expenseView, fakeClient } from './helpers';

afterEach(cleanup);

const trip: Trip = { id: 1, groupId: 1, name: 'Japan', homeCurrency: 'SGD', homeCurrencyLocked: true, status: 'active', setupDone: true, createdAt: '', endedAt: null };
const group: GroupResponse = { group: { id: 1, title: 'Friends', linkVersion: 1 }, me: SAM, members: MEMBERS, access: 'write', activeTrip: trip, newTripCurrency: 'SGD', destination: { view: 'home' }, link: '' };

function entry(id: number, description: string): ActivityEntry {
  return {
    id, groupId: 1, tripId: 1, actor: { kind: 'member', memberId: ANA.id }, action: 'expense.create', entityType: 'expense', entityId: id,
    before: null, after: expenseView({ description }), createdAt: '2026-09-20T10:00:00.000Z', actorName: 'Ana', restore: null,
  } as ActivityEntry;
}

function open(entries: ActivityEntry[]) {
  const client = fakeClient();
  client.listTrips.mockResolvedValue({ trips: [trip] });
  client.listActivity.mockResolvedValue({ entries, nextBefore: null });
  render(<AppProvider value={{ client, group, refresh: vi.fn(), setGroup: vi.fn() }}><MemoryRouter><Activity /></MemoryRouter></AppProvider>);
  return client;
}

it('loads 10 at a time and asks for the next batch from the last entry', async () => {
  const client = fakeClient();
  client.listTrips.mockResolvedValue({ trips: [trip] });
  client.listActivity
    .mockResolvedValueOnce({ entries: [entry(20, 'Taxi')], nextBefore: 20 })
    .mockResolvedValueOnce({ entries: [entry(19, 'Lunch')], nextBefore: null });
  render(<AppProvider value={{ client, group, refresh: vi.fn(), setGroup: vi.fn() }}><MemoryRouter><Activity /></MemoryRouter></AppProvider>);
  expect(ACTIVITY_BATCH).toBe(10);
  await screen.findByText(/Taxi/);
  expect(client.listActivity).toHaveBeenLastCalledWith({ limit: 10 });
  await userEvent.click(screen.getByRole('button', { name: 'Show older' }));
  await screen.findByText(/Lunch/);
  expect(client.listActivity).toHaveBeenLastCalledWith({ limit: 10, before: 20 });
  expect(screen.getByText("That's everything.")).toBeInTheDocument();
});

it('filters by kind and by person, starting again from the newest', async () => {
  const client = open([entry(20, 'Taxi')]);
  await screen.findByText(/Taxi/);
  await userEvent.click(screen.getByRole('radio', { name: 'Payments' }));
  expect(client.listActivity).toHaveBeenLastCalledWith({ kind: 'payments', limit: 10 });
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'By' }), String(SAM.id));
  expect(client.listActivity).toHaveBeenLastCalledWith({ kind: 'payments', actor: SAM.id, limit: 10 });
  await userEvent.click(screen.getByRole('radio', { name: 'All' }));
  expect(client.listActivity).toHaveBeenLastCalledWith({ actor: SAM.id, limit: 10 });
});

it('says when nothing matches the filters', async () => {
  open([]);
  await screen.findByText('Nothing has happened yet.');
  await userEvent.click(screen.getByRole('radio', { name: 'Expenses' }));
  await screen.findByText('Nothing matches these filters.');
});
