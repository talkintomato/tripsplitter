import type { ReactNode } from 'react';
import { ApiError, type ApiClient } from '../api/client';
import { Empty, ErrorState, Loading } from '../components/ui';
import { myBalanceText } from '../format';
import { getInitData } from '../telegram';
import { useLoad } from '../useLoad';

export function YourGroups(props: { client: ApiClient; onOpen(launch: string): void; noTelegram: ReactNode }) {
  const loaded = useLoad(() => props.client.getMyGroups(), 'my-groups');
  if (!getInitData() && loaded.error instanceof ApiError && loaded.error.status === 401) return props.noTelegram;
  return (
    <main className="screen">
      <header className="screen-head"><h1>Your groups</h1></header>
      {loaded.loading ? <Loading what="groups" /> : loaded.error !== undefined ? (
        <ErrorState error={loaded.error} onRetry={() => void loaded.reload()} />
      ) : loaded.data ? loaded.data.groups.length === 0 ? (
        <Empty>You're not in any groups yet. Add @{loaded.data.botUsername} to a Telegram group to start.</Empty>
      ) : (
        <ul className="list">
          {loaded.data.groups.map((group) => (
            <li key={group.id}>
              <button type="button" className="row group-choice" onClick={() => props.onOpen(group.launch)}>
                <span className="row-main">
                  <span className="row-title">{group.title}</span>
                  <span className="hint small">{group.tripName ?? 'No active trip'}</span>
                  {group.balance ? <span>{group.balance.amount === 0 ? "You're settled up" : myBalanceText(group.balance.amount, group.balance.currency)}</span> : null}
                  {group.draftsCount > 0 ? <span className="hint small">{group.draftsCount} {group.draftsCount === 1 ? 'draft' : 'drafts'} to finish</span> : null}
                </span>
                <span className="chevron">›</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
