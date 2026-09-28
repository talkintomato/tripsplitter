// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { GroupResponse, Trip } from '../../web/src/api/types';
import { Currencies } from '../../web/src/screens/Currencies';
import { AppProvider } from '../../web/src/state';
import { MEMBERS, SAM, fakeClient } from './helpers';

afterEach(cleanup);

const trip: Trip = { id: 1, groupId: 1, name: 'Japan', homeCurrency: 'SGD', homeCurrencyLocked: true, status: 'active', setupDone: true, createdAt: '', endedAt: null };

function setup() {
  const client = fakeClient();
  let current = trip;
  const rates = [
    { currency: 'JPY', rate: '112.4', origin: 'member' },
    { currency: 'MYR', rate: '3.38', origin: 'suggested' },
  ];
  client.request.mockImplementation(async () => ({ trip: current, rates }));
  client.patchTrip.mockImplementation(async (_id: number, body: { name?: string }) => {
    current = { ...current, ...body };
    return { trip: current };
  });
  const group: GroupResponse = { group: { id: 1, title: 'Friends', linkVersion: 1 }, me: SAM, members: MEMBERS, access: 'write', activeTrip: trip, newTripCurrency: 'SGD', destination: { view: 'home' }, link: '' };
  render(<AppProvider value={{ client, group, refresh: vi.fn(async () => group), setGroup: vi.fn() }}><MemoryRouter initialEntries={['/trips/1/currencies']}><Routes><Route path="/trips/:tripId/currencies" element={<Currencies />} /></Routes></MemoryRouter></AppProvider>);
  return { client, user: userEvent.setup() };
}

it('has no trip name box: the trip is renamed from its title on Home', async () => {
  setup();
  await screen.findByLabelText('Add currency');
  expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save name' })).not.toBeInTheDocument();
});

it('offers to add only the currencies the trip does not have yet', async () => {
  setup();
  const picker = await screen.findByLabelText('Add currency');
  const offered = within(picker).getAllByRole('option').map((option) => (option as HTMLOptionElement).value);
  expect(offered).not.toContain('SGD');
  expect(offered).not.toContain('JPY');
  expect(offered).not.toContain('MYR');
  expect(offered).toContain('THB');
  expect(picker).toHaveValue(offered[0]);
  expect(screen.getByRole('link', { name: 'Set rate' })).toHaveAttribute('href', `/trips/1/rates/${offered[0]}`);
});
