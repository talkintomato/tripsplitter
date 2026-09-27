// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../web/src/App';
import { ApiError, createApiClient } from '../../web/src/api/client';
import type { GroupResponse, MyGroupsResponse } from '../../web/src/api/types';
import { ANA, fakeClient } from './helpers';

vi.mock('../../web/src/telegram', () => ({ getInitData: () => '', getStartParam: () => null, prepare: vi.fn(), inTelegram: () => false, showBackButton: () => () => {} }));
afterEach(cleanup);
const groups: MyGroupsResponse = { botUsername: 'our_test_bot', groups: [
  { id: 1, title: 'Japan', tripName: 'Autumn', balance: { amount: 184441, currency: 'SGD' }, draftsCount: 2, launch: 'japan-link' },
  { id: 2, title: 'Bali', tripName: 'Beach', balance: { amount: -4093, currency: 'SGD' }, draftsCount: 0, launch: 'bali-link' },
  { id: 3, title: 'Home', tripName: null, balance: null, draftsCount: 0, launch: 'home-link' },
  { id: 4, title: 'Settled', tripName: 'Weekend', balance: { amount: 0, currency: 'SGD' }, draftsCount: 0, launch: 'settled-link' },
] };
const group = (title: string): GroupResponse => ({ group: { id: 1, title, linkVersion: 1 }, me: ANA, members: [ANA], access: 'write', activeTrip: null, newTripCurrency: 'SGD', destination: { view: 'home' }, link: 'https://example.test' });

it('shows balances, drafts and no-trip rows, then opens and switches groups using their launch', async () => {
  const client = fakeClient();
  client.getMyGroups.mockResolvedValue(groups);
  client.getGroup.mockImplementation(() => Promise.resolve(group('Selected group')));
  client.listTrips.mockResolvedValue({ trips: [] });
  const user = userEvent.setup();
  render(<App client={client} startParam={null} />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading groups');
  expect(await screen.findByText('You are owed 1,844.41 SGD')).toBeInTheDocument();
  expect(screen.getByText('You owe 40.93 SGD')).toBeInTheDocument();
  expect(screen.getByText("You're settled up")).toBeInTheDocument();
  expect(screen.getByText('2 drafts to finish')).toBeInTheDocument();
  expect(screen.getByText('No active trip')).toBeInTheDocument();
  expect(client.getGroup).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: /Japan/ }));
  expect(client.setLaunch).toHaveBeenLastCalledWith('japan-link');
  await screen.findByRole('heading', { name: 'Selected group' });
  await user.click(screen.getByRole('button', { name: 'All my groups' }));
  await user.click(await screen.findByRole('button', { name: /Bali/ }));
  expect(client.setLaunch).toHaveBeenLastCalledWith('bali-link');
  await screen.findByRole('heading', { name: 'Selected group' });
  expect(client.getGroup).toHaveBeenCalledTimes(2);
});

it('keeps the list for a single group and supports entry from a group launch', async () => {
  const client = fakeClient();
  client.getMyGroups.mockResolvedValue({ ...groups, groups: groups.groups.slice(0, 1) });
  client.getGroup.mockResolvedValue(group('Linked group'));
  client.listTrips.mockResolvedValue({ trips: [] });
  render(<App client={client} startParam="original-link" />);
  await screen.findByRole('heading', { name: 'Linked group' });
  expect(client.getMyGroups).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'All my groups' }));
  await screen.findByRole('button', { name: /Japan/ });
  expect(screen.getByRole('heading', { name: 'Your groups' })).toBeInTheDocument();
  expect(client.getGroup).toHaveBeenCalledTimes(1);
});

it('retries a failed list request and uses the API bot username in the empty state', async () => {
  const client = fakeClient();
  client.getMyGroups.mockRejectedValueOnce(new ApiError(0, 'network', 'Connection lost')).mockResolvedValue({ botUsername: 'from_api_bot', groups: [] });
  render(<App client={client} startParam={null} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText("You're not in any groups yet. Add @from_api_bot to a Telegram group to start.")).toBeInTheDocument();
});

it('shows the explanatory page in an ordinary browser when no dev identity is accepted', async () => {
  const client = fakeClient();
  client.getMyGroups.mockRejectedValue(new ApiError(401, 'unauthorized', 'No sign-in data'));
  render(<App client={client} startParam={null} />);
  expect(await screen.findByRole('heading', { name: 'Open this from your group' })).toBeInTheDocument();
});

it('sends authentication alone for discovery and the chosen launch for later requests', async () => {
  const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { status: 200 }));
  const client = createApiClient({ initData: 'signed-data', launch: 'old', fetch: send });
  await client.getMyGroups();
  expect(send.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: 'tma signed-data' });
  client.setLaunch('chosen');
  await client.getGroup();
  expect(send.mock.calls[1]?.[1]?.headers).toEqual({ Authorization: 'tma signed-data', 'X-Launch': 'chosen' });
});
