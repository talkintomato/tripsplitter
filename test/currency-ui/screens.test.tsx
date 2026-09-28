// @vitest-environment node
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../web/src/App';
import { createApiClient } from '../../web/src/api/client';
import { createApi } from '../../src/api/index';
import { createConsoleNotifier } from '../../src/api/dev-server';
import { buildConfig } from '../../src/config';
import { encodeLaunch } from '../../src/core/launch';
import { completeSetup, createExpense, getTrip, listTripRates, setTripRate } from '../../src/db/index';
import { ramen, seed, type Seed } from '../db/helpers';

// Keep server modules in Node's transform pipeline (SQLite loads migrations via
// import.meta.url), while providing a DOM for the real React/API integration.
vi.hoisted(async () => {
  const { createRequire } = await import('node:module');
  const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
    JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis };
  };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'getComputedStyle'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
});

vi.mock('../../web/src/telegram', () => ({
  prepare: () => {}, getInitData: () => '', getStartParam: () => '',
  inTelegram: () => false, showBackButton: () => () => {},
}));
let s: Seed;
beforeEach(() => { s = seed(); });
afterEach(() => { cleanup(); s.db.close(); });
function open() {
  const config = buildConfig({ nodeEnv: 'development', devFakeUser: { id: 101, firstName: 'Ana' } });
  const launch = encodeLaunch({ groupId: s.group.id, linkVersion: s.group.linkVersion, view: 'home' }, config.linkSecret);
  const api = createApi(config, s.db, { notifier: createConsoleNotifier(() => {}), suggestRate: async () => '112.4' });
  const client = createApiClient({ initData: '', launch, fetch: (async (input, init) => api.request(String(input), init)) as typeof fetch });
  render(<App client={client} startParam={launch} />);
  return userEvent.setup();
}
it('shows setup automatically, suggests a home-first rate, reviews it, and saves as member', async () => {
  const user = open();
  await screen.findByRole('heading', { name: 'Set up your trip' });
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('checkbox', { name: /JPY/ }));
  expect(await screen.findByDisplayValue('112.4')).toBeVisible();
  expect(screen.getByText('1 SGD = 112.4 JPY')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Review currencies' }));
  await user.click(await screen.findByRole('button', { name: 'Confirm currencies' }));
  await screen.findByRole('heading', { name: s.trip.name });
  expect(getTrip(s.db, s.asAna, s.trip.id).setupDone).toBe(true);
  expect(listTripRates(s.db, s.asAna, s.trip.id)[0]).toMatchObject({ currency: 'JPY', rate: '112.4', origin: 'member' });
});
it('skips setup without adding any rate', async () => {
  const user = open();
  await user.click(await screen.findByRole('button', { name: 'Skip for now' }));
  await screen.findByRole('heading', { name: s.trip.name });
  expect(getTrip(s.db, s.asAna, s.trip.id).setupDone).toBe(true);
  expect(listTripRates(s.db, s.asAna, s.trip.id)).toEqual([]);
});
it('renames the trip through Home settings and asks before clearing rates for a new home currency', async () => {
  completeSetup(s.db, s.asAna, s.trip.id);
  setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '100', 'member');
  const user = open();
  // Trip settings are in the trip's menu.
  await user.click(await screen.findByRole('button', { name: 'Trip settings' }));
  await user.click(screen.getByRole('button', { name: 'Rename trip' }));
  const input = await screen.findByRole('textbox', { name: 'Name' });
  await user.clear(input); await user.type(input, 'Autumn trip');
  await user.click(screen.getByRole('button', { name: 'Save name' }));
  await waitFor(() => expect(getTrip(s.db, s.asAna, s.trip.id).name).toBe('Autumn trip'));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Home currency' }), 'USD');
  await user.click(screen.getByRole('button', { name: 'Change home currency' }));
  expect(screen.getByText(/All trip rates and rates entered for individual expenses will be cleared/)).toBeVisible();
  expect(getTrip(s.db, s.asAna, s.trip.id).homeCurrency).toBe('SGD');
  await user.click(screen.getAllByRole('button', { name: 'Change home currency' })[1]!);
  await waitFor(() => expect(getTrip(s.db, s.asAna, s.trip.id).homeCurrency).toBe('USD'));
  expect(listTripRates(s.db, s.asAna, s.trip.id)).toEqual([]);
});
it('shows a refreshed preview on a stale rate and only applies after a second confirmation', async () => {
  completeSetup(s.db, s.asAna, s.trip.id);
  setTripRate(s.db, s.asAna, s.trip.id, 'JPY', '100', 'member');
  createExpense(s.db, s.asAna, ramen(s));
  const user = open();
  await user.click(await screen.findByRole('button', { name: 'Trip settings' }));
  await user.click(screen.getByRole('button', { name: 'Currencies and rates' }));
  await user.click(await screen.findByRole('link', { name: 'Change rate' }));
  const input = await screen.findByRole('textbox', { name: /how many JPY/ });
  await user.clear(input); await user.type(input, '120');
  await user.click(screen.getByRole('button', { name: 'Preview change' }));
  await screen.findByRole('button', { name: 'Confirm rate' });
  createExpense(s.db, s.asAna, ramen(s, { status: 'draft' }));
  await user.click(screen.getByRole('button', { name: 'Confirm rate' }));
  await screen.findByText(/Check the updated preview/);
  expect(listTripRates(s.db, s.asAna, s.trip.id)[0]?.rate).toBe('100');
  expect(screen.getByText(/2 saved expenses will change/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Confirm rate' }));
  await screen.findByRole('heading', { name: 'Trip settings' });
  expect(listTripRates(s.db, s.asAna, s.trip.id)[0]?.rate).toBe('120');
});
