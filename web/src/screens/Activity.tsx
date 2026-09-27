import { useState } from 'react';
import { Link } from 'react-router-dom';
import { activityText } from '../activityText';
import type { ActivityEntry } from '../api/types';
import { ActionError, Empty, ErrorState, Loading, Screen } from '../components/ui';
import { momentText } from '../format';
import { useApp } from '../state';
import { useLoad } from '../useLoad';

export function Activity() {
  const { client, group } = useApp();
  const loaded = useLoad(async () => {
    const [page, trips] = await Promise.all([client.listActivity(), client.listTrips()]);
    return { entries: page.entries, nextBefore: page.nextBefore, trips: trips.trips };
  }, 'activity');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  async function more(): Promise<void> {
    const data = loaded.data;
    if (!data || data.nextBefore === null) return;
    setBusy(true);
    setError(undefined);
    try {
      const page = await client.listActivity({ before: data.nextBefore });
      loaded.set({ ...data, entries: [...data.entries, ...page.entries], nextBefore: page.nextBefore });
    } catch (problem) {
      setError(problem);
    } finally {
      setBusy(false);
    }
  }

  async function restore(entry: ActivityEntry): Promise<void> {
    if (!entry.restore) return;
    const { kind, id, version } = entry.restore;
    setBusy(true);
    setError(undefined);
    try {
      if (kind === 'expense') await client.restoreExpense(id, version);
      else await client.restoreSettlement(id, version);
    } catch (problem) {
      setError(problem);
    } finally {
      await loaded.reload();
      setBusy(false);
    }
  }

  return (
    <Screen title="Activity" subtitle="Everything that was changed, newest first.">
      <ActionError error={error} onClose={() => setError(undefined)} />
      {loaded.error !== undefined && loaded.data === undefined ? (
        <ErrorState error={loaded.error} onRetry={() => void loaded.reload()} />
      ) : loaded.data === undefined ? (
        <Loading what="activity" />
      ) : loaded.data.entries.length === 0 ? (
        <Empty>Nothing has happened yet.</Empty>
      ) : (
        <>
          <ul className="list">
            {loaded.data.entries.map((entry) => {
              const data = loaded.data!;
              const line = activityText(entry, group.members, data.trips);
              const own = entry.action.startsWith('member.') && entry.action !== 'member.claim' && entry.actor.kind === 'system';
              return (
                <li key={entry.id} className="row activity">
                  <span className="row-main">
                    <span className="row-title wrap">
                      {own ? null : <strong>{entry.actorName} </strong>}
                      {entry.entityType === 'expense' ? <Link to={`/expenses/${entry.entityId}`}>{line}</Link> : line}
                    </span>
                    <span className="hint small">{momentText(entry.createdAt)}</span>
                  </span>
                  {entry.restore ? (
                    <button type="button" className="button button-small button-quiet" disabled={busy} onClick={() => void restore(entry)}>
                      Restore
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {loaded.data.nextBefore !== null ? (
            <div className="actions">
              <button type="button" className="button button-quiet" disabled={busy} onClick={() => void more()}>
                {busy ? 'Loading…' : 'Show older'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </Screen>
  );
}
