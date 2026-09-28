import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Settlement, Trip } from '../api/types';
import { History } from '../components/History';
import { ExpenseList } from '../components/ExpenseRow';
import { Alert, Archive, ChevronRight, Clock, Coins, Flag, Gear, Pencil, People, Plus, Restore } from '../components/icons';
import { ActionError, Badge, Banner, Confirm, Empty, ErrorState, GroupsBack, IconButton, Loading, MenuItem, Screen, Section, Segmented, Sheet } from '../components/ui';
import { dayText, money, myBalanceText, nameOf, whenText } from '../format';
import { useApp } from '../state';
import { useLoad } from '../useLoad';
import { BalancesPanel } from './Balances';

type Tab = 'expenses' | 'balances';

/** The first screen: the active trip, or the way to start one. */
export function Home() {
  const { group } = useApp();
  return group.activeTrip ? <TripHome tripId={group.activeTrip.id} root /> : <NoTrip />;
}

/** A trip opened from the list of past trips, or its balances opened from a link. */
export function TripScreen(props: { tab?: Tab }) {
  const tripId = Number(useParams().tripId);
  return <TripHome key={`${tripId}-${props.tab ?? 'expenses'}`} tripId={tripId} root={false} tab={props.tab ?? 'expenses'} />;
}

function useGroupsBack() {
  const { allGroups } = useApp();
  return allGroups ? <GroupsBack onClick={allGroups} /> : undefined;
}

function NoTrip() {
  const { client, group, refresh } = useApp();
  const navigate = useNavigate();
  const leading = useGroupsBack();
  const trips = useLoad(() => client.listTrips(), 'trips');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  async function start(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await client.createTrip();
      await refresh();
    } catch (problem) {
      setError(problem);
      // Someone else may have started one in the meantime.
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const past = trips.data?.trips.filter((t) => t.status === 'ended') ?? [];
  return (
    <Screen title={group.group.title} subtitle="No trip is going on right now." back={false} leading={leading} largeTitle>
      <ActionError error={error} onClose={() => setError(undefined)} />
      <div className="card card-pad center">
        <p className="muted-2">Start a trip to add expenses and see who owes whom.</p>
        <button type="button" className="btn btn-primary btn-block btn-lg" disabled={busy} onClick={() => void start()}>
          {busy ? 'Starting…' : 'Start new trip'}
        </button>
      </div>
      <div className="actions-row">
        <button type="button" className="btn btn-secondary" onClick={() => navigate('/members')}>
          <People /> Members
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => navigate('/activity')}>
          <Clock /> Activity
        </button>
      </div>
      <Section title="Past trips">
        {trips.error !== undefined ? (
          <ErrorState error={trips.error} onRetry={() => void trips.reload()} />
        ) : trips.data === undefined ? (
          <Loading what="trips" />
        ) : past.length === 0 ? (
          <p className="list-empty">No past trips yet.</p>
        ) : (
          <TripList trips={past} />
        )}
      </Section>
    </Screen>
  );
}

export function TripList(props: { trips: Trip[] }) {
  return (
    <ul className="cards">
      {props.trips.map((trip) => (
        <li key={trip.id}>
          <Link className="card-row" to={`/trips/${trip.id}`}>
            <span className="tile" aria-hidden="true"><Archive /></span>
            <span className="row-main">
              <span className="row-title">{trip.name}</span>
              <span className="row-sub">
                {trip.endedAt ? `Ended ${dayText(trip.endedAt.slice(0, 10))}` : 'Going on now'} · {trip.homeCurrency}
              </span>
            </span>
            <span className="chevron" aria-hidden="true"><ChevronRight /></span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function TripHome(props: { tripId: number; root: boolean; tab?: Tab }) {
  const { client, group, refresh } = useApp();
  const navigate = useNavigate();
  const groupsBack = useGroupsBack();
  const { tripId } = props;
  const loaded = useLoad(async () => {
    const [trip, expenses, balances] = await Promise.all([client.getTrip(tripId), client.listExpenses(tripId), client.getBalances(tripId)]);
    return { trip: trip.trip, expenses: expenses.expenses, balances };
  }, `trip-${tripId}`);
  const [tab, setTab] = useState<Tab>(props.tab ?? 'expenses');
  const [menu, setMenu] = useState(false);
  const [asking, setAsking] = useState<'end' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [done, setDone] = useState<string | null>(null);
  const [payment, setPayment] = useState<number | null>(null);

  const leading = props.root ? groupsBack : undefined;
  const back = props.root ? false : true;
  const menuButton = <IconButton label="Trip settings" icon={Gear} onClick={() => setMenu(true)} />;

  if (loaded.error !== undefined && loaded.data === undefined) {
    return (
      <Screen title="Trip" back={back} leading={leading}>
        <ErrorState error={loaded.error} onRetry={() => void loaded.reload()} />
      </Screen>
    );
  }
  if (loaded.data === undefined) {
    return (
      <Screen title={group.activeTrip?.id === tripId ? group.activeTrip.name : 'Trip'} back={back} leading={leading} largeTitle>
        <Loading />
      </Screen>
    );
  }

  const { trip, expenses, balances } = loaded.data;
  const ended = trip.status === 'ended';
  const currency = trip.homeCurrency;
  const drafts = expenses.filter((e) => e.status === 'draft');
  const needRate = drafts.filter((e) => e.problems.some((p) => p.code === 'rate_missing')).length;
  const checkCurrency = drafts.filter((e) => e.currencyNeedsReview).length;
  const confirmed = expenses.filter((e) => e.status === 'confirmed');
  const payments = balances.settlements.filter((s) => s.status === 'active');
  const mine = balances.balances[group.me.id] ?? 0;

  async function change(run: () => Promise<unknown>, after?: () => void): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await run();
      await refresh();
      await loaded.reload();
      after?.();
    } catch (problem) {
      setError(problem);
    } finally {
      setBusy(false);
      setAsking(null);
    }
  }

  const go = (path: string) => () => {
    setMenu(false);
    navigate(path);
  };

  return (
    <Screen
      title={trip.name}
      back={back}
      leading={leading}
      actions={menuButton}
      largeTitle
      titleExtra={ended ? <Badge tone="neutral">Ended</Badge> : null}
      className={tab === 'expenses' && !ended ? 'with-fab' : ''}
    >
      <Segmented<Tab>
        label="Show"
        role="tablist"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'expenses', label: 'Expenses', controls: 'panel-expenses' },
          { value: 'balances', label: 'Balances', controls: 'panel-balances' },
        ]}
      />

      <div className="card summary">
        <p className={`summary-balance ${mine > 0 ? 'owed' : mine < 0 ? 'owes' : ''}`}>{myBalanceText(mine, currency)}</p>
        <div className="stats">
          <div className="stat">
            <span className="stat-label">My expenses</span>
            <span className="stat-value">{money(balances.summary.myExpenses, currency)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Total expenses</span>
            <span className="stat-value">{money(balances.summary.totalExpenses, currency)}</span>
          </div>
        </div>
      </div>

      {ended ? <p className="hint small center">This trip has ended. Payments can still be recorded.</p> : null}
      {done ? <Banner kind="success" onClose={() => setDone(null)}>{done}</Banner> : null}
      <ActionError error={error} onClose={() => setError(undefined)} />

      {drafts.length > 0 ? (
        <Link className="notice-row" to={`/trips/${trip.id}/drafts`}>
          <span className="banner-icon" aria-hidden="true"><Alert size={18} /></span>
          <span className="row-main">
            <span className="row-title">
              {drafts.length} {drafts.length === 1 ? 'draft' : 'drafts'} to finish
            </span>
            {needRate > 0 || checkCurrency > 0 ? (
              <span className="badges">
                {needRate > 0 ? <Badge tone="warn">{needRate === 1 ? 'Needs rate' : `${needRate} need a rate`}</Badge> : null}
                {checkCurrency > 0 ? <Badge tone="warn">{checkCurrency === 1 ? 'Check currency' : `${checkCurrency} to check currency`}</Badge> : null}
              </span>
            ) : (
              <span className="row-sub wrap">Drafts do not count until they are approved.</span>
            )}
          </span>
          <span className="chevron" aria-hidden="true"><ChevronRight /></span>
        </Link>
      ) : null}

      {tab === 'expenses' ? (
        <div className="panel" id="panel-expenses" role="tabpanel" aria-label="Expenses">
          <ExpenseList
            expenses={confirmed}
            settlements={payments}
            currency={currency}
            empty={ended ? 'This trip has no expenses.' : 'No expenses yet. Add the first one.'}
            onSettlement={(settlement) => setPayment(settlement.id)}
          />
        </div>
      ) : (
        <BalancesPanel tripId={trip.id} data={balances} onChanged={() => loaded.reload()} />
      )}

      {tab === 'expenses' && !ended ? (
        <button type="button" className="fab" onClick={() => navigate(`/trips/${trip.id}/add`)}>
          <Plus size={20} /> Add expense
        </button>
      ) : null}

      {menu ? (
        <Sheet label="Trip menu" onClose={() => setMenu(false)}>
          <h2 className="sheet-title">{trip.name}</h2>
          <ul className="menu">
            <MenuItem icon={People} label="Members" onClick={go('/members')} />
            <MenuItem icon={Clock} label="Activity" hint="Changes, and restoring removed items" onClick={go('/activity')} />
            <MenuItem icon={Coins} label="Currencies and rates" onClick={go(`/trips/${trip.id}/currencies`)} />
            {ended ? null : <MenuItem icon={Pencil} label="Rename trip" onClick={go(`/trips/${trip.id}/currencies`)} />}
            {props.root ? <MenuItem icon={Archive} label="Past trips" onClick={go('/past-trips')} /> : null}
          </ul>
          <div className="menu-divider" />
          <ul className="menu">
            {ended ? (
              group.activeTrip === null ? (
                <MenuItem icon={Restore} label="Reopen this trip" disabled={busy} onClick={() => { setMenu(false); void change(() => client.reopenTrip(trip.id), () => navigate('/', { replace: true })); }} />
              ) : (
                <li className="hint small" style={{ padding: '8px' }}>This trip can be reopened once the current trip has ended.</li>
              )
            ) : (
              <MenuItem icon={Flag} label="End trip" tone="danger" onClick={() => { setMenu(false); setAsking('end'); }} />
            )}
          </ul>
        </Sheet>
      ) : null}

      {asking === 'end' ? (
        <Confirm
          title={`End ${trip.name}?`}
          confirmLabel="End trip"
          danger
          busy={busy}
          onCancel={() => setAsking(null)}
          onConfirm={() => void change(() => client.endTrip(trip.id), () => navigate('/', { replace: true }))}
        >
          <p>No more expenses can be added or changed. Payments can still be recorded, and the trip can be reopened later.</p>
        </Confirm>
      ) : null}
      {payment !== null ? (() => {
        const settlement = balances.settlements.find((s) => s.id === payment);
        return settlement ? (
          <PaymentSheet
            settlement={settlement}
            currency={currency}
            busy={busy}
            onClose={() => setPayment(null)}
            onUndo={() => void change(() => client.undoSettlement(settlement.id, settlement.version))}
            onRestore={() => void change(() => client.restoreSettlement(settlement.id, settlement.version))}
          />
        ) : null;
      })() : null}
    </Screen>
  );
}

/** One payment: who paid whom, who recorded it and when, its history, and Undo or Restore. */
function PaymentSheet(props: { settlement: Settlement; currency: string; busy: boolean; onClose(): void; onUndo(): void; onRestore(): void }) {
  const { group } = useApp();
  const { settlement } = props;
  const who = (id: number): string => (id === group.me.id ? 'You' : nameOf(group.members, id));
  const to = settlement.toMemberId === group.me.id ? 'you' : nameOf(group.members, settlement.toMemberId);
  return (
    <Sheet label="Payment" onClose={props.onClose}>
      <h2 className="sheet-title">{who(settlement.fromMemberId)} paid {to} {money(settlement.amount, props.currency)}</h2>
      <p className="sheet-body">
        Recorded by {settlement.createdBy === group.me.id ? 'you' : nameOf(group.members, settlement.createdBy)} · {whenText(settlement.createdAt)}
        {settlement.status === 'undone' ? ' · undone' : ''}
      </p>
      <History type="settlement" id={settlement.id} version={settlement.version} />
      <div className="sheet-actions">
        {settlement.status === 'active' ? (
          <button type="button" className="btn btn-danger btn-block" disabled={props.busy} onClick={props.onUndo}>Undo this payment</button>
        ) : settlement.fromMemberId !== settlement.toMemberId ? (
          <button type="button" className="btn btn-primary btn-block" disabled={props.busy} onClick={props.onRestore}>Restore this payment</button>
        ) : null}
        <button type="button" className="btn btn-ghost btn-block" onClick={props.onClose}>Close</button>
      </div>
    </Sheet>
  );
}

export function PastTrips() {
  const { client } = useApp();
  const trips = useLoad(() => client.listTrips(), 'past-trips');
  const past = trips.data?.trips.filter((t) => t.status === 'ended') ?? [];
  return (
    <Screen title="Past trips">
      {trips.error !== undefined ? (
        <ErrorState error={trips.error} onRetry={() => void trips.reload()} />
      ) : trips.data === undefined ? (
        <Loading what="trips" />
      ) : past.length === 0 ? (
        <Empty icon={Archive}>No past trips yet. A trip is listed here once it has ended.</Empty>
      ) : (
        <TripList trips={past} />
      )}
    </Screen>
  );
}
