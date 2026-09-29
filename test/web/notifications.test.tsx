// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../web/src/api/client';
import type { GroupResponse } from '../../web/src/api/types';
import { Notifications, GROUP_NOTICES, PERSONAL_NOTICES } from '../../web/src/screens/Notifications';
import { AppProvider } from '../../web/src/state';
import { MEMBERS, SAM, fakeClient } from './helpers';
afterEach(cleanup);
function setup() {
  const client = fakeClient();
  client.request.mockResolvedValueOnce({ group: Object.fromEntries(GROUP_NOTICES.map(([type]) => [type, true])), personal: Object.fromEntries(PERSONAL_NOTICES.map(([type]) => [type, false])), canMessageMe: null, botUsername: 'tripsplit_bot' });
  const group: GroupResponse = { group: { id: 1, title: 'Friends', linkVersion: 1 }, me: SAM, members: MEMBERS, access: 'write', activeTrip: null, newTripCurrency: 'SGD', destination: { view: 'home' }, link: '' };
  render(<AppProvider value={{ client, group, refresh: vi.fn(async () => group), setGroup: vi.fn() }}><MemoryRouter><Notifications /></MemoryRouter></AppProvider>);
  return { client, user: userEvent.setup() };
}
it('shows all labeled switches, defaults, descriptions, and the private chat link', async () => {
  setup();
  await screen.findByRole('switch', { name: 'New expenses' });
  expect(screen.getAllByRole('switch')).toHaveLength(12);
  for (const [type, label, description] of GROUP_NOTICES) {
    expect(screen.getByRole('switch', { name: label })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: label })).toHaveAccessibleDescription(description);
    expect(screen.getByLabelText(label)).toHaveAttribute('id', `notification-group-${type}`);
  }
  for (const [, label] of PERSONAL_NOTICES) expect(screen.getByRole('switch', { name: label })).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByRole('link', { name: 'Open chat' })).toHaveAttribute('href', 'https://t.me/tripsplit_bot?start=notify');
  expect(screen.getByText('Changes here apply to everyone in the group')).toBeInTheDocument();
});
it('saves a group switch immediately and shows a saving state until it completes', async () => {
  const { client, user } = setup();
  const control = await screen.findByRole('switch', { name: 'Payments' });
  let finish!: (value: unknown) => void;
  client.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await user.click(control);
  expect(client.request).toHaveBeenLastCalledWith('PUT', '/api/notifications/group/payment', { enabled: false });
  expect(control).toHaveAttribute('aria-checked', 'false');
  expect(control).toBeDisabled();
  expect(screen.getByText('Saving…')).toBeInTheDocument();
  await act(async () => finish({ enabled: false }));
  expect(control).toBeEnabled();
  expect(screen.queryByText('Saving…')).not.toBeInTheDocument();
});
it('rolls back a failed personal save with an error and supports retry', async () => {
  const { client, user } = setup();
  const control = await screen.findByRole('switch', { name: 'My payments' });
  client.request.mockRejectedValueOnce(new ApiError(0, 'network', 'Could not save. Try again.'));
  await user.click(control);
  await screen.findByRole('alert');
  expect(control).toHaveAttribute('aria-checked', 'false');
  expect(control).toBeEnabled();
  expect(screen.getByText('Could not save. Try again.')).toBeInTheDocument();
  expect(client.request).toHaveBeenLastCalledWith('PUT', '/api/notifications/personal/payments_me', { enabled: true });
  client.request.mockResolvedValueOnce({ enabled: true });
  await user.click(control);
  await waitFor(() => expect(control).toBeEnabled());
  expect(control).toHaveAttribute('aria-checked', 'true');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
