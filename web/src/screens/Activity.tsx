import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { activityText } from '../activityText';
import type { ActivityKind } from '../api/client';
import type { ActivityEntry, Trip } from '../api/types';
import { ActionError, Avatar, Empty, ErrorState, Loading, Screen } from '../components/ui';
import { Clock } from '../components/icons';
import { momentText } from '../format';
import { useApp } from '../state';

/** Entries fetched at a time. More are fetched as the end of the list comes into view. */
export const ACTIVITY_BATCH = 10;

const KINDS: Array<{ value: ActivityKind | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'expenses', label: 'Expenses' },
  { value: 'payments', label: 'Payments' },
  { value: 'people', label: 'People' },
  { value: 'trip', label: 'Trip' },
];

interface Feed {
  entries: ActivityEntry[];
  nextBefore: number | null;
}

export function Activity() {
  const { client, group } = useApp();
  const [kind, setKind] = useState<ActivityKind | 'all'>('all');
  const [actor, setActor] = useState<number | 'anyone'>('anyone');
  const [feed, setFeed] = useState<Feed | undefined>(undefined);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loadError, setLoadError] = useState<unknown>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  // A request started for an earlier filter must not overwrite the list of the current one.
  const generation = useRef(0);
  const sentinel = useRef<HTMLDivElement | null>(null);

  const filters = useCallback(
    () => ({ ...(kind === 'all' ? {} : { kind }), ...(actor === 'anyone' ? {} : { actor }), limit: ACTIVITY_BATCH }),
    [kind, actor],
  );

  const loadFirst = useCallback(async () => {
    const mine = ++generation.current;
    setFeed(undefined);
    setLoadError(undefined);
    try {
      const page = await client.listActivity(filters());
      if (mine === generation.current) setFeed({ entries: page.entries, nextBefore: page.nextBefore });
    } catch (problem) {
      if (mine === generation.current) setLoadError(problem);
    }
  }, [client, filters]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  useEffect(() => {
    let live = true;
    client.listTrips().then((result) => { if (live) setTrips(result.trips); }, () => {});
    return () => { live = false; };
  }, [client]);

  const more = useCallback(async () => {
    if (!feed || feed.nextBefore === null || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    setError(undefined);
    try {
      const page = await client.listActivity({ ...filters(), before: feed.nextBefore });
      if (mine === generation.current) {
        setFeed((current) => (current ? { entries: [...current.entries, ...page.entries], nextBefore: page.nextBefore } : current));
      }
    } catch (problem) {
      if (mine === generation.current) setError(problem);
    } finally {
      setLoadingMore(false);
    }
  }, [client, feed, filters, loadingMore]);

  // Fetch the next batch when the end of the list scrolls into view.
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !feed || feed.nextBefore === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((seen) => {
      if (seen.some((entry) => entry.isIntersecting)) void more();
    }, { rootMargin: '200px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [feed, more]);

  async function restore(entry: ActivityEntry): Promise<void> {
    if (!entry.restore) return;
    const { kind: target, id, version } = entry.restore;
    setBusy(true);
    setError(undefined);
    try {
      if (target === 'expense') await client.restoreExpense(id, version);
      else await client.restoreSettlement(id, version);
    } catch (problem) {
      setError(problem);
    } finally {
      await loadFirst();
      setBusy(false);
    }
  }

  const people = group.members.filter((member) => member.mergedInto === null || member.mergedInto === undefined);
  const filtered = kind !== 'all' || actor !== 'anyone';

  return (
    <Screen title="Activity">
      <div className="activity-filters">
        <div className="chip-row" role="radiogroup" aria-label="Show">
          {KINDS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={kind === option.value}
              className={`filter-chip ${kind === option.value ? 'is-on' : ''}`}
              onClick={() => setKind(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="picker filter-person">
          <span className="visually-hidden">By</span>
          <select aria-label="By" value={actor} onChange={(event) => setActor(event.target.value === 'anyone' ? 'anyone' : Number(event.target.value))}>
            <option value="anyone">By anyone</option>
            {people.map((member) => (
              <option key={member.id} value={member.id}>By {member.displayName}</option>
            ))}
          </select>
        </label>
      </div>

      <ActionError error={error} onClose={() => setError(undefined)} />
      {loadError !== undefined && feed === undefined ? (
        <ErrorState error={loadError} onRetry={() => void loadFirst()} />
      ) : feed === undefined ? (
        <Loading what="activity" />
      ) : feed.entries.length === 0 ? (
        <Empty icon={Clock}>{filtered ? 'Nothing matches these filters.' : 'Nothing has happened yet.'}</Empty>
      ) : (
        <>
          <ul className="list-card">
            {feed.entries.map((entry) => {
              const line = activityText(entry, group.members, trips);
              const own = entry.action.startsWith('member.') && entry.action !== 'member.claim' && entry.actor.kind === 'system';
              return (
                <li key={entry.id} className="item activity">
                  {own ? <span className="tile" aria-hidden="true"><Clock /></span> : <Avatar name={entry.actorName} id={entry.actor.kind === 'member' ? entry.actor.memberId : undefined} size="lg" />}
                  <span className="row-main">
                    <span className="row-title wrap activity-line">
                      {own ? null : <strong>{entry.actorName} </strong>}
                      {entry.entityType === 'expense' ? <Link to={`/expenses/${entry.entityId}`}>{line}</Link> : line}
                    </span>
                    <span className="row-sub">{momentText(entry.createdAt)}</span>
                  </span>
                  {entry.restore ? (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void restore(entry)}>
                      Restore
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {feed.nextBefore !== null ? (
            <div ref={sentinel} className="actions">
              {/* Scrolling fetches the next batch; the button is there for when it does not, and for keyboards. */}
              <button type="button" className="btn btn-ghost btn-block" disabled={loadingMore} onClick={() => void more()}>
                {loadingMore ? 'Loading…' : 'Show older'}
              </button>
            </div>
          ) : (
            <p className="hint small list-end">That's everything.</p>
          )}
        </>
      )}
    </Screen>
  );
}
