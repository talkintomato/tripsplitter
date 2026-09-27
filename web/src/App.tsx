import { useCallback, useEffect, useMemo, useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError, createApiClient, messageOf, type ApiClient } from './api/client';
import type { GroupResponse } from './api/types';
import { Activity } from './screens/Activity';
import { Balances } from './screens/Balances';
import { AddExpense, Drafts, EditExpense, ExpenseDetail } from './screens/Expense';
import { YourGroups } from './screens/YourGroups';
import { Home, PastTrips, TripScreen } from './screens/Home';
import { Currencies } from './screens/Currencies';
import { ChangeRate } from './screens/ChangeRate';
import { TripSetup } from './screens/TripSetup';
import { Members } from './screens/Members';
import { AppProvider, type AppState } from './state';
import { getInitData, getStartParam, prepare } from './telegram';

/** Where the link asked to go. Home is always underneath, so that Back has somewhere to go. */
export function initialEntries(group: GroupResponse): string[] {
  const { destination, activeTrip } = group;
  if (destination.view === 'add') return ['/', `/trips/${activeTrip ? activeTrip.id : 'active'}/add`];
  if (destination.view === 'balances' && activeTrip) return ['/', `/trips/${activeTrip.id}/balances`];
  if (destination.view === 'expense' && destination.expenseId !== undefined) return ['/', `/expenses/${destination.expenseId}`];
  return ['/'];
}

function Page(props: { title: string; children: React.ReactNode }) {
  return (
    <main className="screen">
      <header className="screen-head">
        <h1>{props.title}</h1>
      </header>
      {props.children}
    </main>
  );
}

export function NoLink() {
  return (
    <Page title="Open this from your group">
      <p>TripSplitter works inside a Telegram group.</p>
      <p>Go to the group chat and tap the button on the pinned TripSplitter message. That opens the trip of that group.</p>
      <p className="hint">If there is no pinned message, add the bot to the group first.</p>
    </Page>
  );
}

export interface AppProps {
  /** For tests. */
  client?: ApiClient;
  startParam?: string | null;
}

export function App(props: AppProps) {
  const startParam = props.startParam !== undefined ? props.startParam : getStartParam();
  const client = useMemo(
    () => props.client ?? createApiClient({ initData: getInitData(), launch: startParam ?? '' }),
    [props.client, startParam],
  );
  const [showGroups, setShowGroups] = useState(!startParam);
  const [group, setGroupState] = useState<GroupResponse | null>(null);
  const [entries, setEntries] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(undefined);

  const refresh = useCallback(async () => {
    const next = await client.getGroup();
    setGroupState(next);
    return next;
  }, [client]);

  const open = useCallback(async () => {
    setError(undefined);
    try {
      const first = await client.getGroup();
      setGroupState(first);
      setEntries(initialEntries(first));
    } catch (problem) {
      setError(problem);
    }
  }, [client]);

  useEffect(() => {
    prepare();
    if (startParam) void open();
  }, [open, startParam]);

  const allGroups = () => {
    setShowGroups(true);
    setGroupState(null);
    setEntries(null);
    setError(undefined);
  };
  if (showGroups) return <YourGroups client={client} noTelegram={<NoLink />} onOpen={(launch) => {
    client.setLaunch(launch);
    setShowGroups(false);
    void open();
  }} />;

  if (error !== undefined) {
    const refused = error instanceof ApiError && (error.status === 401 || error.status === 403);
    return (
      <Page title={refused ? 'This link does not work' : 'Could not open the trip'}>
        <p role="alert">{messageOf(error)}</p>
        <button type="button" className="link" onClick={allGroups}>All my groups</button>
        {refused ? (
          <p className="hint">Go to the group chat and tap the button on the pinned TripSplitter message.</p>
        ) : (
          <button type="button" className="button" onClick={() => void open()}>
            Try again
          </button>
        )}
      </Page>
    );
  }

  if (group === null || entries === null) {
    return (
      <Page title="TripSplitter">
        <p className="state" role="status">
          Loading…
        </p>
      </Page>
    );
  }

  const state: AppState = {
    client,
    group,
    allGroups,
    refresh,
    setGroup: (update) => setGroupState((current) => (current ? update(current) : current)),
  };

  return (
    <AppProvider value={state}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        {group.activeTrip && !group.activeTrip.setupDone ? <><div className="screen all-groups"><button type="button" className="link small" onClick={allGroups}>All my groups</button></div><TripSetup tripId={group.activeTrip.id} automatic /></> : <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/trips/:tripId/setup" element={<TripSetup />} />
          <Route path="/trips/:tripId/currencies" element={<Currencies />} />
          <Route path="/trips/:tripId/rates/:currency" element={<ChangeRate />} />
          <Route path="/past-trips" element={<PastTrips />} />
          <Route path="/trips/:tripId" element={<TripScreen />} />
          <Route path="/trips/:tripId/add" element={<AddExpense />} />
          <Route path="/trips/:tripId/drafts" element={<Drafts />} />
          <Route path="/trips/:tripId/balances" element={<Balances />} />
          <Route path="/expenses/:id" element={<ExpenseDetail />} />
          <Route path="/expenses/:id/edit" element={<EditExpense />} />
          <Route path="/members" element={<Members />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="*" element={<Home />} />
        </Routes>}
      </MemoryRouter>
    </AppProvider>
  );
}
