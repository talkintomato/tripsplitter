import { useCallback, useEffect, useMemo, useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError, createApiClient, messageOf, type ApiClient } from './api/client';
import type { GroupResponse } from './api/types';
import { Activity } from './screens/Activity';
import { AddExpense, Drafts, EditExpense, ExpenseDetail } from './screens/Expense';
import { YourGroups } from './screens/YourGroups';
import { Home, PastTrips, TripScreen } from './screens/Home';
import { Currencies } from './screens/Currencies';
import { ChangeRate } from './screens/ChangeRate';
import { TripSetup } from './screens/TripSetup';
import { Members } from './screens/Members';
import { AppProvider, type AppState } from './state';
import { getInitData, getStartParam, prepare } from './telegram';
import { GroupsBack, Loading, PlainPage } from './components/ui';
import { Alert, People } from './components/icons';

/** Where the link asked to go. Home is always underneath, so that Back has somewhere to go. */
export function initialEntries(group: GroupResponse): string[] {
  const { destination, activeTrip } = group;
  if (destination.view === 'add') return ['/', `/trips/${activeTrip ? activeTrip.id : 'active'}/add`];
  if (destination.view === 'balances' && activeTrip) return ['/', `/trips/${activeTrip.id}/balances`];
  if (destination.view === 'expense' && destination.expenseId !== undefined) return ['/', `/expenses/${destination.expenseId}`];
  return ['/'];
}

export function NoLink() {
  return (
    <PlainPage title="Open this from your group">
      <div className="state">
        <span className="state-icon" aria-hidden="true"><People size={22} /></span>
        <p className="muted-2">TripSplitter works inside a Telegram group.</p>
        <p className="muted-2">Go to the group chat and tap the button on the pinned TripSplitter message. That opens the trip of that group.</p>
        <p className="hint small">If there is no pinned message, add the bot to the group first.</p>
      </div>
    </PlainPage>
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
      <PlainPage title={refused ? 'This link does not work' : 'Could not open the trip'} leading={<GroupsBack onClick={allGroups} />}>
        <div className="state">
          <span className="state-icon state-icon-error" aria-hidden="true"><Alert size={22} /></span>
          <p role="alert">{messageOf(error)}</p>
          {refused ? (
            <p className="hint small">Go to the group chat and tap the button on the pinned TripSplitter message.</p>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => void open()}>
              Try again
            </button>
          )}
        </div>
      </PlainPage>
    );
  }

  if (group === null || entries === null) {
    return (
      <PlainPage title="TripSplitter">
        <Loading />
      </PlainPage>
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
        {group.activeTrip && !group.activeTrip.setupDone ? <TripSetup tripId={group.activeTrip.id} automatic leading={<GroupsBack onClick={allGroups} />} /> : <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/trips/:tripId/setup" element={<TripSetup />} />
          <Route path="/trips/:tripId/currencies" element={<Currencies />} />
          <Route path="/trips/:tripId/rates/:currency" element={<ChangeRate />} />
          <Route path="/past-trips" element={<PastTrips />} />
          <Route path="/trips/:tripId" element={<TripScreen />} />
          <Route path="/trips/:tripId/add" element={<AddExpense />} />
          <Route path="/trips/:tripId/drafts" element={<Drafts />} />
          <Route path="/trips/:tripId/balances" element={<TripScreen tab="balances" />} />
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
