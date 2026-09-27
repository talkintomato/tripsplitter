import { useState } from 'react';
import { historyText } from '../activityText';
import type { ActivityEntry } from '../api/types';
import { editChanges } from '../expenseChanges';
import { whenText } from '../format';
import { useApp } from '../state';
import { useLoad } from '../useLoad';
import { Section } from './ui';

const SHOWN = 3;

/** What an entry changed, one line per field. Only edits and rate changes have lines. */
function changeLines(entry: ActivityEntry, members: Parameters<typeof editChanges>[0]): string[] {
  if (entry.action !== 'expense.save' && entry.action !== 'expense.rate_change' && entry.action !== 'expense.member_merged') return [];
  return editChanges(members, entry.before, entry.after).map((row) => `${row.label}: ${row.before} → ${row.after}`);
}

/**
 * The history of one expense or payment, newest first: who did what, and when. Read only; restoring stays on the
 * Activity screen and on the record itself. `version` loads it again after the record changed.
 */
export function History(props: { type: 'expense' | 'settlement'; id: number; version: number; now?: Date }) {
  const { client, group } = useApp();
  const loaded = useLoad(() => client.listActivity({ entity: { type: props.type, id: props.id } }), `history-${props.type}-${props.id}-${props.version}`);
  const [all, setAll] = useState(false);

  if (loaded.data === undefined) {
    return (
      <Section title="History">
        {loaded.error !== undefined ? (
          <p className="list-empty">
            The history could not be loaded.{' '}
            <button type="button" className="link-btn small" onClick={() => void loaded.reload()}>Try again</button>
          </p>
        ) : (
          <p className="field-hint">Loading the history…</p>
        )}
      </Section>
    );
  }
  // Only this record's entries. The API filters already; this also keeps an older server that ignores the filter
  // from showing the whole group's activity here.
  const entries = loaded.data.entries.filter((entry) => entry.entityType === props.type && entry.entityId === props.id);
  if (entries.length === 0) return null;
  const shown = all ? entries : entries.slice(0, SHOWN);
  return (
    <Section title="History" className="history">
      <ol className="list-card history-list" aria-label="History">
        {shown.map((entry) => {
          const lines = changeLines(entry, group.members);
          return (
            <li key={entry.id} className="item history-item">
              <span className="history-dot" aria-hidden="true" />
              <span className="row-main">
                <span className="row-title wrap">{historyText(entry)}</span>
                {lines.length > 0 ? (
                  <ul className="history-changes">
                    {lines.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                ) : null}
                <span className="row-sub">{entry.actorName} · {whenText(entry.createdAt, props.now)}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {entries.length > SHOWN && !all ? (
        <button type="button" className="btn btn-ghost btn-block" onClick={() => setAll(true)}>
          Show all ({entries.length})
        </button>
      ) : null}
    </Section>
  );
}
