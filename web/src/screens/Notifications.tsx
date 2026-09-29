import { useState } from 'react';
import type { NotificationsResponse } from '../api/types';
import { ActionError, ErrorState, Loading, Screen, Section } from '../components/ui';
import { useApp } from '../state';
import { useLoad } from '../useLoad';

export const GROUP_NOTICES = [
  ['expense_added', 'New expenses', 'An expense is added or a receipt is approved.'],
  ['expense_changed', 'Expense edits', 'An expense is changed.'],
  ['expense_removed', 'Removed expenses', 'An expense is deleted or restored.'],
  ['payment', 'Payments', 'A payment is recorded, undone or restored.'],
  ['exchange_rate', 'Exchange rates', 'A trip rate is set or changed.'],
  ['trip', 'Trip status', 'The trip is ended or reopened.'],
  ['member_joined', 'New members', 'Someone joins through the group link.'],
] as const;
export const PERSONAL_NOTICES = [
  ['added_me', 'Expenses including me', 'Someone adds or approves an expense that includes you.'],
  ['changed_mine', 'Changes to my expenses', 'Someone edits, deletes or restores an expense involving you.'],
  ['payments_me', 'My payments', 'Someone records, undoes or restores a payment to or from you.'],
  ['exchange_rate', 'Changes to my balance', 'Someone changes a trip rate that changes your balance.'],
  ['draft_waiting', 'Receipts to approve', 'Someone creates a receipt draft in this group.'],
] as const;

type Kind = 'group' | 'personal';
function NotificationSwitch(props: { kind: Kind; type: string; label: string; description: string; initial: boolean }) {
  const { client } = useApp();
  const [enabled, setEnabled] = useState(props.initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const id = `notification-${props.kind}-${props.type}`;
  async function save() {
    const before = enabled;
    setEnabled(!before);
    setSaving(true);
    setError(undefined);
    try {
      await client.request('PUT', `/api/notifications/${props.kind}/${props.type}`, { enabled: !before });
    } catch (problem) {
      setEnabled(before);
      setError(problem);
    } finally {
      setSaving(false);
    }
  }
  return <li className="notification-item">
    <div className="item">
      <span className="row-main">
        <label className="row-title" id={`${id}-label`} htmlFor={id}>{props.label}</label>
        <span className="row-sub wrap" id={`${id}-description`}>{props.description}</span>
        {saving ? <span className="hint small" role="status">Saving…</span> : null}
      </span>
      <button id={id} type="button" role="switch" className="notification-switch" aria-checked={enabled}
        aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} aria-busy={saving} disabled={saving} onClick={() => void save()}>
        <span aria-hidden="true" className="notification-track"><span /></span>
      </button>
    </div>
    <ActionError error={error} onClose={() => setError(undefined)} />
  </li>;
}

export function Notifications() {
  const { client, group } = useApp();
  const loaded = useLoad(() => client.request<NotificationsResponse>('GET', '/api/notifications'), 'notifications');
  const data = loaded.data;
  return <Screen title="Notifications" subtitle={group.group.title}>
    {data === undefined ? loaded.error !== undefined ? <ErrorState error={loaded.error} onRetry={() => void loaded.reload()} /> : <Loading what="notifications" /> : <>
      <Section title="In the group chat">
        <p className="field-hint">Changes here apply to everyone in the group</p>
        <ul className="list-card">{GROUP_NOTICES.map(([type, label, description]) => <NotificationSwitch key={type} kind="group" type={type} label={label} description={description} initial={data.group[type]} />)}</ul>
      </Section>
      <Section title="Just for me">
        <p className="field-hint">Private messages from the bot. Start a chat with @{data.botUsername} first so it can message you. You won’t hear about your own actions.</p>
        <a className="btn btn-secondary" href={`https://t.me/${data.botUsername}?start=notify`} target="_blank" rel="noreferrer">Open chat</a>
        <ul className="list-card">{PERSONAL_NOTICES.map(([type, label, description]) => <NotificationSwitch key={type} kind="personal" type={type} label={label} description={description} initial={data.personal[type]} />)}</ul>
      </Section>
    </>}
  </Screen>;
}
