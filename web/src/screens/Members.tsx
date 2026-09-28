import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, messageOf } from '../api/client';
import type { Member } from '../api/types';
import { ActionError, Avatar, Banner, Confirm, Screen, Section } from '../components/ui';
import { ResetLinkConfirm } from '../components/ResetLink';
import { dayText, expenseTitle, money } from '../format';
import { useApp } from '../state';

function MemberRow(props: { member: Member; me: boolean; note: string; action?: React.ReactNode }) {
  return (
    <li className="item">
      <Avatar name={props.member.displayName} id={props.member.id} size="lg" />
      <span className="row-main">
        <span className="row-title">
          {props.member.displayName}
          {props.me ? ' (you)' : ''}
        </span>
        <span className="row-sub">{props.note}</span>
      </span>
      {props.action}
    </li>
  );
}

export function Members() {
  const { client, group, refresh, setGroup } = useApp();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [claimName, setClaimName] = useState('');
  const [claiming, setClaiming] = useState<Member | null>(null);
  const [resetting, setResetting] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const active = group.members.filter((m) => m.active && m.joinedVia !== 'manual');
  const inactive = group.members.filter((m) => !m.active && m.joinedVia !== 'manual');
  const manual = group.members.filter((m) => m.joinedVia === 'manual');

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(undefined);
    setDone(null);
    try {
      await work();
    } catch (problem) {
      setError(problem);
    } finally {
      setBusy(false);
      setClaiming(null);
      setResetting(false);
    }
  }

  function add(event: FormEvent): void {
    event.preventDefault();
    if (name.trim() === '') return;
    void run(async () => {
      const { member } = await client.addMember({ displayName: name.trim() });
      setName('');
      setDone(`${member.displayName} was added.`);
      await refresh();
    });
  }

  const refusedClaim = error instanceof ApiError && error.expenses.length > 0 ? error : null;

  return (
    <Screen title="Members" subtitle={group.group.title}>
      {done ? (
        <Banner kind="success" onClose={() => setDone(null)}>
          {done}
        </Banner>
      ) : null}
      {refusedClaim ? (
        <Banner kind="error" onClose={() => setError(undefined)}>
          <p>{messageOf(refusedClaim)}</p>
          <p>Remove {claimName} or {group.me.displayName} from these expenses first. Then tap "That's me" again.</p>
          <ul className="plain-list">
            {refusedClaim.expenses.map((expense) => (
              <li key={expense.id}>
                <Link to={`/expenses/${expense.id}`}>
                  {expenseTitle(expense)}, {money(expense.total, expense.currency)}, {dayText(expense.expenseDate)}
                  {expense.status !== 'confirmed' ? ` (${expense.status})` : ''}
                </Link>
              </li>
            ))}
          </ul>
        </Banner>
      ) : (
        <ActionError error={error} onClose={() => setError(undefined)} />
      )}

      <Section title="In the trip">
        {active.length === 0 ? (
          <p className="list-empty">Nobody yet.</p>
        ) : (
          <ul className="list-card">
            {active.map((member) => (
              <MemberRow key={member.id} member={member} me={member.id === group.me.id} note={member.joinedVia === 'link' ? 'Joined through the link' : 'In the group chat'} />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Added by name">
        {manual.length === 0 ? (
          <p className="list-empty">Nobody added by name yet.</p>
        ) : (
          <ul className="list-card">
            {manual.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                me={false}
                note="Not linked to a Telegram account"
                action={
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setClaiming(member)}>
                    That's me
                  </button>
                }
              />
            ))}
          </ul>
        )}
        <form className="inline-form" onSubmit={add}>
          <label className="field">
            <span>Add a person</span>
            <input type="text" value={name} maxLength={100} placeholder="Name" autoComplete="off" enterKeyHint="done" onChange={(event) => setName(event.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || name.trim() === ''}>
            Add
          </button>
        </form>
        <p className="field-hint">For someone who is not on Telegram. If that person joins later, they can tap “That's me”.</p>
      </Section>

      {inactive.length > 0 ? (
        <Section title="Left the chat">
          <p className="field-hint">They are left out of new expenses unless you tick them.</p>
          <ul className="list-card">
            {inactive.map((member) => (
              <MemberRow key={member.id} member={member} me={member.id === group.me.id} note={member.joinedVia === 'link' ? 'Joined through the link' : 'Was in the group chat'} />
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="The group's link">
        <div className="card card-pad">
          <p className="muted-2">Anyone who opens the link pinned in the group joins this trip. If the link got into the wrong hands, reset it.</p>
          <button type="button" className="btn btn-danger btn-block" disabled={busy} onClick={() => setResetting(true)}>
            Reset link
          </button>
        </div>
      </Section>

      {claiming ? (
        <Confirm
          title={`Are you ${claiming.displayName}?`}
          confirmLabel="Yes, that's me"
          busy={busy}
          onCancel={() => setClaiming(null)}
          onConfirm={() =>
            void run(async () => {
              setClaimName(claiming.displayName);
              const result = await client.claimMember(claiming.id);
              setGroup((current) => ({ ...current, me: result.me, members: result.members }));
              setDone(`Everything recorded for ${claiming.displayName} is now yours.`);
            })
          }
        >
          <p>
            Everything recorded for {claiming.displayName} moves to you, and {claiming.displayName} disappears from the list. This cannot be undone.
          </p>
        </Confirm>
      ) : null}

      {resetting ? <ResetLinkConfirm onCancel={() => setResetting(false)} onDone={(message) => { setResetting(false); setDone(message); }} /> : null}
    </Screen>
  );
}
