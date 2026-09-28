import type { ReactNode } from 'react';
import { ApiError, type ApiClient } from '../api/client';
import { ChevronRight, People } from '../components/icons';
import { Badge, Empty, ErrorState, Loading } from '../components/ui';
import { myBalanceText } from '../format';
import { getInitData } from '../telegram';
import { useLoad } from '../useLoad';

/** The emoji a name starts with, such as the flag in "🇯🇵 Japan", or its first letter. */
export function groupMark(title: string): { text: string; emoji: boolean } {
  const trimmed = title.trim();
  const emoji = /^(\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*)/u.exec(trimmed);
  if (emoji) return { text: emoji[0], emoji: true };
  const letter = [...trimmed.replace(/^[^\p{L}\p{N}]+/u, '')][0];
  return { text: (letter ?? '?').toUpperCase(), emoji: false };
}

export function YourGroups(props: { client: ApiClient; onOpen(launch: string): void; noTelegram: ReactNode }) {
  const loaded = useLoad(() => props.client.getMyGroups(), 'my-groups');
  if (!getInitData() && loaded.error instanceof ApiError && loaded.error.status === 401) return props.noTelegram;
  return (
    <main className="screen">
      <header className="brand">
        <h1>Your groups</h1>
      </header>
      {loaded.loading ? <Loading what="groups" shape="cards" /> : loaded.error !== undefined ? (
        <ErrorState error={loaded.error} onRetry={() => void loaded.reload()} />
      ) : loaded.data ? loaded.data.groups.length === 0 ? (
        <Empty icon={People}>You're not in any groups yet. Add @{loaded.data.botUsername} to a Telegram group to start.</Empty>
      ) : (
        <ul className="cards">
          {loaded.data.groups.map((group) => {
            const mark = groupMark(group.tripName ?? group.title);
            const balance = group.balance;
            return (
              <li key={group.id}>
                <button type="button" className="card-row group-choice" onClick={() => props.onOpen(group.launch)}>
                  <span className={`tile tile-accent tile-lg ${mark.emoji ? 'tile-emoji' : ''}`} aria-hidden="true">{mark.text}</span>
                  <span className="row-main">
                    <span className="row-title">{group.title}</span>
                    <span className="group-meta">
                      <span>{group.tripName ?? 'No active trip'}</span>
                      {balance ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className={`group-balance ${balance.amount > 0 ? 'pos' : balance.amount < 0 ? 'neg' : ''}`}>
                            {balance.amount === 0 ? "You're settled up" : myBalanceText(balance.amount, balance.currency)}
                          </span>
                        </>
                      ) : null}
                    </span>
                    {group.draftsCount > 0 ? (
                      <span className="badges">
                        <Badge tone="draft">{group.draftsCount} {group.draftsCount === 1 ? 'draft' : 'drafts'} to finish</Badge>
                      </span>
                    ) : null}
                  </span>
                  <span className="chevron" aria-hidden="true"><ChevronRight /></span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </main>
  );
}
