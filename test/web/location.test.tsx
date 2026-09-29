// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gps } from 'exifr/dist/lite.esm.mjs';
import { activityText, historyText } from '../../web/src/activityText';
import type { ActivityEntry, ExpenseView, GroupResponse, Trip } from '../../web/src/api/types';
import { ExpenseForm } from '../../web/src/expense-form/ExpenseForm';
import { editChanges } from '../../web/src/expenseChanges';
import { ExpenseDetail } from '../../web/src/screens/Expense';
import { AppProvider } from '../../web/src/state';
import { currentLocation } from '../../web/src/telegram';
import { MEMBERS, expenseView, fakeClient, previewAnswer, written } from './helpers';

vi.mock('exifr/dist/lite.esm.mjs', () => ({ gps: vi.fn() }));
vi.mock('../../web/src/photos/shrink', () => ({ shrinkPhoto: vi.fn(async () => new Blob(['image'], { type: 'image/jpeg' })) }));
const location = { locationLat: 35.6595, locationLng: 139.7005, placeName: 'Shibuya', locationSource: 'photo' as const };
beforeEach(() => {
  vi.mocked(gps).mockResolvedValue(undefined);
  vi.stubGlobal('URL', class extends URL { static override createObjectURL = vi.fn(() => 'blob:photo'); static override revokeObjectURL = vi.fn(); });
  vi.stubGlobal('Telegram', { WebApp: { initData: '' } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function form(expense?: ExpenseView) {
  const client = fakeClient();
  client.previewExpense.mockImplementation(async body => previewAnswer(body));
  client.lookupPlace.mockResolvedValue({ name: 'Shibuya' });
  client.uploadPhoto.mockResolvedValue({ id: 1, width: 10, height: 10 });
  client.createExpense.mockResolvedValue(written(expenseView()));
  client.saveExpense.mockResolvedValue(written(expenseView()));
  render(<ExpenseForm client={client} members={MEMBERS} meId={1} tripId={1} homeCurrency="SGD" onSaved={vi.fn()} {...(expense ? { expense } : {})} />);
  return { client, user: userEvent.setup() };
}
async function addPhoto(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText('Choose photo'), new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add photo' })).toBeEnabled());
}

it('suggests photo GPS locally and sends coordinates only after Tag location, then saves them', async () => {
  vi.mocked(gps).mockResolvedValue({ latitude: 35.659504, longitude: 139.700504 });
  const { client, user } = form();
  await addPhoto(user);
  expect(screen.getByText('📍 This photo has a location')).toBeInTheDocument();
  expect(client.lookupPlace).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Tag location' }));
  await waitFor(() => expect(client.lookupPlace).toHaveBeenCalledWith(35.6595, 139.7005));
  expect(await screen.findByText('Shibuya')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Tag location' })).not.toBeInTheDocument();
  await user.type(screen.getByLabelText('Amount'), '10');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(client.createExpense).toHaveBeenCalledWith(1, expect.objectContaining(location)));
});

it('dismisses a suggestion permanently for that photo and permits only one suggestion', async () => {
  vi.mocked(gps).mockResolvedValue({ latitude: 1, longitude: 2 });
  const { client, user } = form();
  await addPhoto(user); await addPhoto(user);
  expect(screen.getAllByRole('button', { name: 'Tag location' })).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Dismiss location suggestion' }));
  await user.type(screen.getByLabelText('What was it for?'), 'Trip');
  await user.click(screen.getByRole('button', { name: /More options/ }));
  expect(screen.queryByText('📍 This photo has a location')).not.toBeInTheDocument();
  expect(client.lookupPlace).not.toHaveBeenCalled();
});

it.each(['absent', 'failed', 'already tagged'])('does not suggest location when GPS is %s', async mode => {
  if (mode === 'failed') vi.mocked(gps).mockRejectedValueOnce(new Error('Bad EXIF'));
  if (mode === 'already tagged') vi.mocked(gps).mockResolvedValue({ latitude: 1, longitude: 2 });
  const { client, user } = form(mode === 'already tagged' ? expenseView(location) : undefined);
  await addPhoto(user);
  expect(screen.queryByRole('button', { name: 'Tag location' })).not.toBeInTheDocument();
  expect(client.lookupPlace).not.toHaveBeenCalled();
});

it('removes a saved location through the versioned edit form', async () => {
  const { client, user } = form(expenseView(location));
  await user.click(screen.getByRole('button', { name: /More options/ }));
  await user.click(screen.getByRole('button', { name: 'Remove location' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(client.saveExpense).toHaveBeenCalledWith(7, expect.objectContaining({ locationLat: null, locationLng: null, placeName: null, locationSource: null })));
});

it('asks Telegram LocationManager only on a tap and tags device coordinates even without a name', async () => {
  const init = vi.fn((callback: () => void) => callback());
  const getLocation = vi.fn((callback: (value: { latitude: number; longitude: number }) => void) => callback({ latitude: 35.6595, longitude: 139.7005 }));
  vi.stubGlobal('Telegram', { WebApp: { initData: 'signed', LocationManager: { init, getLocation, isLocationAvailable: true } } });
  const { client, user } = form(); client.lookupPlace.mockRejectedValue(new Error('offline'));
  expect(init).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Use my current location' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /More options/ }));
  expect(init).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Use my current location' }));
  expect(await screen.findByText('Near 35.65950, 139.70050')).toBeInTheDocument();
  expect(init).toHaveBeenCalledTimes(1); expect(getLocation).toHaveBeenCalledTimes(1);
  expect(init.mock.invocationCallOrder[0]).toBeLessThan(getLocation.mock.invocationCallOrder[0]!);
  await user.type(screen.getByLabelText('Amount'), '10');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(client.createExpense).toHaveBeenCalledWith(1, expect.objectContaining({ ...location, placeName: null, locationSource: 'device' })));
});

it.each(['denied', 'missing', 'unavailable', 'throws'])('handles Telegram location %s without a browser fallback', async mode => {
  const openSettings = vi.fn();
  const browser = vi.fn();
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: browser } });
  const manager = { init: (callback: () => void) => { if (mode === 'throws') throw new Error('unsupported'); callback(); }, getLocation: (callback: (value: null) => void) => callback(null), openSettings, isLocationAvailable: mode !== 'unavailable' };
  vi.stubGlobal('Telegram', { WebApp: { initData: 'signed', ...(mode === 'missing' ? {} : { LocationManager: manager }) } });
  const { client, user } = form();
  await user.click(screen.getByRole('button', { name: /More options/ }));
  await user.click(screen.getByRole('button', { name: 'Use my current location' }));
  expect(await screen.findByText("Location isn't available. Allow location for Telegram in your phone's settings.")).toBeInTheDocument();
  expect(browser).not.toHaveBeenCalled(); expect(client.lookupPlace).not.toHaveBeenCalled();
  if (mode !== 'missing') { await user.click(screen.getByRole('button', { name: 'Open location settings' })); expect(openSettings).toHaveBeenCalledOnce(); }
  else expect(screen.queryByRole('button', { name: 'Open location settings' })).not.toBeInTheDocument();
});

it('uses navigator.geolocation outside Telegram', async () => {
  const getCurrentPosition = vi.fn((callback: (value: { coords: { latitude: number; longitude: number } }) => void) => callback({ coords: { latitude: 1, longitude: 2 } }));
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } });
  expect(await currentLocation()).toEqual({ lat: 1, lng: 2 });
  expect(getCurrentPosition).toHaveBeenCalledOnce();
});

function detail(over: Partial<ExpenseView>) {
  const client = fakeClient(); const expense = expenseView({ receiptFileId: null, ...over });
  const trip: Trip = { id: 1, groupId: 1, name: 'Trip', homeCurrency: 'SGD', homeCurrencyLocked: true, status: 'active', setupDone: true, createdAt: '', endedAt: null };
  const group: GroupResponse = { group: { id: 1, title: 'Group', linkVersion: 1 }, me: MEMBERS[0]!, members: MEMBERS, access: 'write', activeTrip: trip, newTripCurrency: 'SGD', destination: { view: 'home' }, link: '' };
  client.getExpense.mockResolvedValue({ expense }); client.getTrip.mockResolvedValue({ trip }); client.listActivity.mockResolvedValue({ entries: [], nextBefore: null });
  render(<AppProvider value={{ client, group, refresh: vi.fn(), setGroup: vi.fn() }}><MemoryRouter initialEntries={['/expenses/7']}><Routes><Route path="/expenses/:id" element={<ExpenseDetail />} /></Routes></MemoryRouter></AppProvider>);
}

it.each([true, false])('shows Where with a map link, with place name available: %s', async named => {
  const openLink = vi.fn();
  vi.stubGlobal('Telegram', { WebApp: { initData: 'signed', openLink } });
  detail({ ...location, placeName: named ? 'Shibuya' : null });
  expect(await screen.findByText('Where')).toBeInTheDocument();
  const link = screen.getByRole('link', { name: named ? 'Shibuya' : 'Near 35.65950, 139.70050' });
  expect(link).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=35.6595,139.7005');
  await userEvent.setup().click(link);
  expect(openLink).toHaveBeenCalledWith('https://www.google.com/maps/search/?api=1&query=35.6595,139.7005');
});

it('omits Where without location', async () => {
  detail({}); await screen.findByText('Date');
  expect(screen.queryByText('Where')).not.toBeInTheDocument();
});

it('describes location changes in History, Activity and expense comparisons, including old snapshots', () => {
  const before = expenseView(location); const after = expenseView();
  const entry = { action: 'expense.save', before, after } as ActivityEntry;
  expect(historyText(entry)).toContain('location removed');
  expect(activityText(entry, MEMBERS, [])).toContain('location removed');
  expect(editChanges(MEMBERS, before, after)).toContainEqual({ label: 'Location', before: 'Shibuya', after: 'none' });
  expect(activityText({ ...entry, before: after, after: before }, MEMBERS, [])).toContain('location set to Shibuya');
  expect(editChanges(MEMBERS, { ...after, locationLat: undefined, locationLng: undefined }, after)).toEqual([]);
});

it('keeps Save disabled during photo tagging and ignores a dismissed lookup result', async () => {
  vi.mocked(gps).mockResolvedValue({ latitude: 1, longitude: 2 });
  const { client, user } = form();
  let finish!: (value: { name: string | null }) => void;
  client.lookupPlace.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await user.type(screen.getByLabelText('Amount'), '10');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  await addPhoto(user);
  await user.click(screen.getByRole('button', { name: 'Tag location' }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Dismiss location suggestion' }));
  finish({ name: 'Place' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: /More options/ }));
  expect(screen.getByRole('button', { name: 'Use my current location' })).toBeInTheDocument();
  expect(screen.queryByText('Place')).not.toBeInTheDocument();
});

it('offers a normal maps anchor outside Telegram', async () => {
  detail(location);
  expect(await screen.findByRole('link', { name: 'Shibuya' })).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=35.6595,139.7005');
});

it('shows changed coordinates even when both locations have the same place name', () => {
  const rows = editChanges(MEMBERS, expenseView(location), expenseView({ ...location, locationLat: 35.66 }));
  expect(rows).toContainEqual({ label: 'Location', before: 'Shibuya (Near 35.65950, 139.70050)', after: 'Shibuya (Near 35.66000, 139.70050)' });
});
