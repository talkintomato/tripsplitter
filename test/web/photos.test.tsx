// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { activityText, historyText } from '../../web/src/activityText';
import type { ActivityEntry, GroupResponse, Trip } from '../../web/src/api/types';
import { createApiClient } from '../../web/src/api/client';
import { ExpenseForm } from '../../web/src/expense-form/ExpenseForm';
import { PhotoImage } from '../../web/src/photos/PhotoImage';
import { Photos } from '../../web/src/photos/Photos';
import { shrinkPhoto } from '../../web/src/photos/shrink';
import { ExpenseDetail } from '../../web/src/screens/Expense';
import { AppProvider } from '../../web/src/state';
import { MEMBERS, expenseView, fakeClient, previewAnswer, written } from './helpers';

vi.mock('exifr/dist/lite.esm.mjs', () => ({ gps: vi.fn(async () => undefined) }));
vi.mock('../../web/src/photos/shrink', () => ({ shrinkPhoto: vi.fn() }));
const jpeg = new Blob(['shrunk'], { type: 'image/jpeg' });
let sequence = 0;
beforeEach(() => {
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => `blob:photo-${++sequence}`);
    static override revokeObjectURL = vi.fn();
  });
  vi.mocked(shrinkPhoto).mockResolvedValue(jpeg);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function form(edit = false) {
  const client = fakeClient();
  const expense = expenseView({ photos: edit ? [{ id: 42, width: 80, height: 40 }] : [] });
  client.previewExpense.mockImplementation(async body => previewAnswer(body));
  client.photoBlob.mockResolvedValue(jpeg);
  client.createExpense.mockResolvedValue(written(expense));
  client.saveExpense.mockResolvedValue(written(expense));
  client.uploadPhoto.mockResolvedValue({ id: 43, width: 80, height: 40 });
  client.removePhoto.mockResolvedValue(undefined);
  const onSaved = vi.fn();
  render(<ExpenseForm client={client} members={MEMBERS} meId={1} tripId={1} homeCurrency="SGD" onSaved={onSaved} {...(edit ? { expense } : {})} />);
  return { client, onSaved, user: userEvent.setup(), expense };
}

it('holds photos on add, uploads only after saving, and shows a thumbnail with an upload indicator', async () => {
  const { client, user, onSaved } = form();
  await user.upload(screen.getByLabelText('Choose photo'), new File(['original'], 'image.png', { type: 'image/png' }));
  await waitFor(() => expect(screen.getByAltText('Expense photo')).toBeInTheDocument());
  expect(client.uploadPhoto).not.toHaveBeenCalled();
  let finish!: (value: { id: number; width: number; height: number }) => void;
  client.uploadPhoto.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await user.type(screen.getByLabelText('Amount'), '10');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(client.uploadPhoto).toHaveBeenCalledWith(7, jpeg));
  expect(client.createExpense.mock.invocationCallOrder[0]).toBeLessThan(client.uploadPhoto.mock.invocationCallOrder[0]!);
  expect(screen.getByRole('status', { name: 'Preparing or uploading photo' })).toBeInTheDocument();
  expect(onSaved).not.toHaveBeenCalled();
  finish({ id: 43, width: 80, height: 40 });
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
});

it('keeps the expense saved if a photo fails and passes only failed blobs for retry', async () => {
  const { client, user, onSaved, expense } = form();
  client.uploadPhoto.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ id: 43, width: 80, height: 40 });
  for (let i = 0; i < 2; i++) {
    await user.upload(screen.getByLabelText('Choose photo'), new File(['original'], 'image.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add photo' })).toBeEnabled());
  }
  await user.type(screen.getByLabelText('Amount'), '10');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(written(expense), [jpeg]));
  expect(client.createExpense).toHaveBeenCalledTimes(1);
  expect(client.uploadPhoto).toHaveBeenCalledTimes(2);
});

it('hides Add photo at three and removes a held photo without making a request', async () => {
  const { client, user } = form();
  for (let i = 0; i < 3; i++) {
    await user.upload(screen.getByLabelText('Choose photo'), new File(['original'], 'image.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove photo' })[i]).toBeEnabled());
  }
  expect(screen.queryByRole('button', { name: 'Add photo' })).not.toBeInTheDocument();
  await user.click(screen.getAllByRole('button', { name: 'Remove photo' })[0]!);
  expect(screen.getByRole('button', { name: 'Add photo' })).toBeInTheDocument();
  expect(client.removePhoto).not.toHaveBeenCalled();
});

it('adds and removes photos immediately when editing', async () => {
  const { client, user } = form(true);
  await user.click(screen.getByRole('button', { name: 'Remove photo' }));
  expect(client.removePhoto).toHaveBeenCalledWith(42);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove photo' })).not.toBeInTheDocument());
  await user.upload(screen.getByLabelText('Choose photo'), new File(['original'], 'image.png', { type: 'image/png' }));
  await waitFor(() => expect(client.uploadPhoto).toHaveBeenCalledWith(7, jpeg));
  expect(client.saveExpense).not.toHaveBeenCalled();
});

it('opens receipt first, moves with buttons and horizontal swipe, and closes with Escape and Close', async () => {
  const client = fakeClient(); client.photoBlob.mockResolvedValue(jpeg);
  const user = userEvent.setup();
  render(<main data-testid="page"><Photos client={client} expense={expenseView({ hasReceiptPhoto: true, photos: [{ id: 42, width: 80, height: 40 }] })} /></main>);
  const nativeStart = vi.fn();
  screen.getByTestId('page').addEventListener('touchstart', nativeStart);
  await user.click(screen.getByRole('button', { name: 'Open Receipt' }));
  const viewer = screen.getByRole('dialog', { name: 'Photo viewer' });
  expect(viewer.parentElement).toBe(document.body);
  expect(within(viewer).getByText('Receipt · 1 / 2')).toBeInTheDocument();
  await user.click(within(viewer).getByRole('button', { name: 'Next photo' }));
  expect(within(viewer).getByText('Photo 1 · 2 / 2')).toBeInTheDocument();
  fireEvent.touchStart(viewer, { touches: [{ clientX: 5, clientY: 100 }] });
  fireEvent.touchEnd(viewer, { changedTouches: [{ clientX: 120, clientY: 104 }] });
  expect(within(viewer).getByText('Receipt · 1 / 2')).toBeInTheDocument();
  expect(nativeStart).not.toHaveBeenCalled();
  await user.click(within(viewer).getByRole('button', { name: 'Previous photo' }));
  expect(within(viewer).getByText('Photo 1 · 2 / 2')).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open Receipt' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Open Photo 1' }));
  await user.click(screen.getByRole('button', { name: 'Close photo viewer' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('uses skeletons and revokes authenticated object URLs on change and unmount', async () => {
  const client = fakeClient();
  let finish!: (blob: Blob) => void;
  client.photoBlob.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<PhotoImage client={client} source="/api/photos/1" alt="Photo" />);
  expect(screen.getByRole('status', { name: 'Loading Photo' })).toHaveClass('sk');
  finish(jpeg);
  const first = await screen.findByAltText('Photo');
  const url = first.getAttribute('src');
  client.photoBlob.mockResolvedValue(jpeg);
  view.rerender(<PhotoImage client={client} source="/api/photos/2" alt="Photo" />);
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith(url));
  await screen.findByAltText('Photo');
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
});

it('sends sign-in headers on blobs and lets the browser set the multipart boundary', async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8, 0xff]))).mockResolvedValueOnce(Response.json({ id: 42, width: 80, height: 40 }));
  const client = createApiClient({ initData: 'signed', launch: 'launch', fetch: send });
  await client.photoBlob('/api/photos/42');
  await client.uploadPhoto(7, jpeg);
  expect(send.mock.calls[0]![1]?.headers).toEqual({ Authorization: 'tma signed', 'X-Launch': 'launch' });
  expect(send.mock.calls[1]![1]?.headers).toEqual({ Authorization: 'tma signed', 'X-Launch': 'launch' });
  expect(send.mock.calls[1]![1]?.body).toBeInstanceOf(FormData);
});

it('shows the failed-upload message on the saved expense and retries without creating another expense', async () => {
  const client = fakeClient();
  const expense = expenseView();
  const trip: Trip = { id: 1, groupId: 1, name: 'Trip', homeCurrency: 'SGD', homeCurrencyLocked: true, status: 'active', setupDone: true, createdAt: '', endedAt: null };
  const group: GroupResponse = { group: { id: 1, title: 'Group', linkVersion: 1 }, me: MEMBERS[0]!, members: MEMBERS, access: 'write', activeTrip: trip, newTripCurrency: 'SGD', destination: { view: 'home' }, link: '' };
  client.getExpense.mockResolvedValue({ expense }); client.getTrip.mockResolvedValue({ trip });
  client.listActivity.mockResolvedValue({ entries: [], nextBefore: null });
  client.uploadPhoto.mockResolvedValue({ id: 42, width: 80, height: 40 });
  render(<AppProvider value={{ client, group, refresh: vi.fn(), setGroup: vi.fn() }}><MemoryRouter initialEntries={[{ pathname: '/expenses/7', state: { failedPhotos: [jpeg] } }]}><Routes><Route path="/expenses/:id" element={<ExpenseDetail />} /></Routes></MemoryRouter></AppProvider>);
  expect(await screen.findByText('A photo could not be uploaded')).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(screen.queryByText('A photo could not be uploaded')).not.toBeInTheDocument());
  expect(client.uploadPhoto).toHaveBeenCalledWith(7, jpeg);
  expect(client.createExpense).not.toHaveBeenCalled();
});

it('describes photo changes in both History and Activity', () => {
  for (const [action, word] of [['expense.photo_added', 'added'], ['expense.photo_removed', 'removed']] as const) {
    const entry = { action } as ActivityEntry;
    expect(activityText(entry, [], [])).toBe(`${word} a photo`);
    expect(historyText(entry).toLowerCase()).toBe(`${word} a photo`);
  }
});
