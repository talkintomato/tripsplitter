import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ExpenseView, Trip } from '../api/types';
import { ExpenseRow } from '../components/ExpenseRow';
import { ActionError, Confirm, Empty, ErrorState, Loading, Screen, Section } from '../components/ui';
import { dayText, myBalanceText } from '../format';
import { useApp } from '../state';
import { useLoad } from '../useLoad';

/** The first screen: the active trip, or the way to start one. */
export function Home() {
  const { group } = useApp();
  if (group.activeTrip) return <TripHome tripId={group.activeTrip.id} root />;
  return <NoTrip />;
}

/** A trip opened from the list of past trips. */
export function TripScreen() {
  const tripId = Number(useParams().tripId);
  return <TripHome tripId={tripId} root={false} />;
}

function NoTrip() {
  const { client, group, refresh } = useApp();
  const navigate = useNavigate();
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
    <Screen title={group.group.title} subtitle="No trip is going on right now." back={false}>
      <ActionError error={error} onClose={() => setError(undefined)} />
      <div className="actions">
        <button type="button" className="button" disabled={busy} onClick={() => void start()}>
          {busy ? 'Starting…' : 'Start new trip'}
        </button>
        <button type="button" className="button button-quiet" onClick={() => navigate('/members')}>
          Members
        </button>
        <button type="button" className="button button-quiet" onClick={() => navigate('/activity')}>
          Activity
        </button>
      </div>
      <Section title="Past trips">
        {trips.error !== undefined ? (
          <ErrorState error={trips.error} onRetry={() => void trips.reload()} />
        ) : trips.data === undefined ? (
          <Loading what="trips" />
        ) : past.length === 0 ? (
          <Empty>No past trips yet.</Empty>
        ) : (
          <TripList trips={past} />
        )}
      </Section>
    </Screen>
  );
}

export function TripList(props: { trips: Trip[] }) {
  return (
    <ul className="list">
      {props.trips.map((trip) => (
        <li key={trip.id}>
          <Link className="row" to={`/trips/${trip.id}`}>
            <span className="row-main">
              <span className="row-title">{trip.name}</span>
              <span className="hint small">
                {trip.endedAt ? `Ended ${dayText(trip.endedAt.slice(0, 10))}` : 'Going on now'} · {trip.homeCurrency}
              </span>
            </span>
            <span className="chevron">›</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function TripHome(props: { tripId: number; root: boolean }) {
  const { client, group, refresh } = useApp();
  const navigate = useNavigate();
  const { tripId } = props;
  const loaded = useLoad(async () => {
    const [trip, expenses, balances] = await Promise.all([client.getTrip(tripId), client.listExpenses(tripId), client.getBalances(tripId)]);
    return { trip: trip.trip, expenses: expenses.expenses, balances };
  }, `trip-${tripId}`);
  const [asking, setAsking] = useState<'end' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  if (loaded.error !== undefined && loaded.data === undefined) {
    return (
      <Screen title="Trip" back={!props.root}>
        <ErrorState error={loaded.error} onRetry={() => void loaded.reload()} />
      </Screen>
    );
  }
  if (loaded.data === undefined) {
    return (
      <Screen title={group.activeTrip?.id === tripId ? group.activeTrip.name : 'Trip'} back={!props.root}>
        <Loading />
      </Screen>
    );
  }

  const { trip, expenses, balances } = loaded.data;
  const ended = trip.status === 'ended';
  const drafts = expenses.filter((e) => e.status === 'draft');
  const recent: ExpenseView[] = expenses.filter((e) => e.status === 'confirmed').slice(0, 10);
  const confirmedCount = expenses.filter((e) => e.status === 'confirmed').length;
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

  return (
    <Screen title={trip.name} subtitle={ended ? 'This trip has ended. Payments can still be recorded.' : group.group.title} back={!props.root}>
      <ActionError error={error} onClose={() => setError(undefined)} />

      <button type="button" className={`balance-card ${mine < 0 ? 'owes' : mine > 0 ? 'owed' : ''}`} onClick={() => navigate(`/trips/${trip.id}/balances`)}>
        <span className="balance-text">{myBalanceText(mine, trip.homeCurrency)}</span>
        <span className="hint small">See balances and settle up ›</span>
      </button>

      <div className="actions">
        {ended ? null : (
          <button type="button" className="button" onClick={() => navigate(`/trips/${trip.id}/add`)}>
            Add expense
          </button>
        )}
        <div className="actions-grid">
          <button type="button" className="button button-quiet" onClick={() => navigate(`/trips/${trip.id}/balances`)}>
            Balances
          </button>
          <button type="button" className="button button-quiet" onClick={() => navigate('/members')}>
            Members
          </button>
          <button type="button" className="button button-quiet" onClick={() => navigate('/activity')}>
            Activity
          </button>
        </div>
      </div>

      <Link className="button button-quiet" to={`/trips/${trip.id}/currencies`}>Trip settings · Currencies and name</Link>

      {drafts.length > 0 ? (
        <Link className="row row-card" to={`/trips/${trip.id}/drafts`}>
          <span className="row-main">
            <span className="row-title">
              {drafts.length} {drafts.length === 1 ? 'draft' : 'drafts'} to finish
            </span>
            <span className="hint small">Drafts do not count until they are finished.</span>
          </span>
          <span className="chevron">›</span>
        </Link>
      ) : null}

      <Section title={ended ? 'Expenses' : 'Recent expenses'}>
        {recent.length === 0 ? (
          <Empty>{ended ? 'This trip has no expenses.' : 'No expenses yet. Add the first one.'}</Empty>
        ) : (
          <ul className="list">
            {(ended ? expenses.filter((e) => e.status === 'confirmed') : recent).map((expense) => (
              <li key={expense.id}>
                <ExpenseRow expense={expense} />
              </li>
            ))}
          </ul>
        )}
        {!ended && confirmedCount > recent.length ? <p className="hint small center">Showing the latest {recent.length} of {confirmedCount}.</p> : null}
      </Section>

      <div className="actions quiet-actions">
        {props.root ? (
          <button type="button" className="link" onClick={() => navigate('/past-trips')}>
            Past trips
          </button>
        ) : null}
        {ended ? (
          group.activeTrip === null ? (
            <button type="button" className="link" disabled={busy} onClick={() => void change(() => client.reopenTrip(trip.id), () => navigate('/', { replace: true }))}>
              Reopen this trip
            </button>
          ) : (
            <span className="hint small">This trip can be reopened once the current trip has ended.</span>
          )
        ) : (
          <button type="button" className="link danger" onClick={() => setAsking('end')}>
            End trip
          </button>
        )}
      </div>

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
    </Screen>
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
        <Empty>No past trips yet.</Empty>
      ) : (
        <TripList trips={past} />
      )}
    </Screen>
  );
}
