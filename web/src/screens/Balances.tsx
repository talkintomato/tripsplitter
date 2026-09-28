import { useState } from 'react';
import type { BalancesResponse, Settlement } from '../api/types';
import { Transfer } from '../components/icons';
import { ActionError, Avatar, Confirm, Section } from '../components/ui';
import { balanceText, momentText, money, nameOf } from '../format';
import { useApp } from '../state';

interface Payment {
  fromMemberId: number;
  toMemberId: number;
  amount: number;
}

/**
 * The Balances tab of a trip: where everyone stands, the payments that would settle everyone up, and the
 * payments recorded so far. `onChanged` loads the trip again after a change, and after a refusal.
 */
export function BalancesPanel(props: { tripId: number; data: BalancesResponse; onChanged(): Promise<void> }) {
  const { client, group } = useApp();
  const { tripId } = props;
  const [paying, setPaying] = useState<Payment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  async function change(run: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (problem) {
      setError(problem);
    } finally {
      // Loaded again either way: after a refusal the latest state is what should be shown.
      await props.onChanged().catch(() => undefined);
      setBusy(false);
      setPaying(null);
    }
  }

  const { trip, balances, payments, settlements } = props.data;
  const currency = trip.homeCurrency;
  const ids = new Set<number>([...Object.keys(balances).map(Number), ...group.members.filter((m) => m.active).map((m) => m.id)]);
  const rows = [...ids]
    .map((id) => ({ id, name: nameOf(group.members, id), amount: balances[id] ?? 0 }))
    .sort((a, b) => (a.id === group.me.id ? -1 : b.id === group.me.id ? 1 : a.name.localeCompare(b.name)));
  const who = (id: number): string => (id === group.me.id ? 'You' : nameOf(group.members, id));
  const line = (s: Payment): string => `${who(s.fromMemberId)} paid ${who(s.toMemberId) === 'You' ? 'you' : who(s.toMemberId)}`;

  return (
    <div className="panel" id="panel-balances" role="tabpanel" aria-label="Balances">
      <ActionError error={error} onClose={() => setError(undefined)} />

      <Section title="Suggested payments">
        {payments.length === 0 ? (
          <p className="list-empty">Everyone is settled up.</p>
        ) : (
          <ul className="cards">
            {payments.map((payment) => (
              <li key={`${payment.fromMemberId}-${payment.toMemberId}`} className="card pay-card">
                <p className="pay-line">
                  <Avatar name={nameOf(group.members, payment.fromMemberId)} id={payment.fromMemberId} size="sm" />
                  <span className="pay-who">
                    <strong>{who(payment.fromMemberId)}</strong> {payment.fromMemberId === group.me.id ? 'pay' : 'pays'}{' '}
                    <strong>{payment.toMemberId === group.me.id ? 'you' : nameOf(group.members, payment.toMemberId)}</strong>
                  </span>
                </p>
                <div className="pay-foot">
                  <span className="pay-amount">{money(payment.amount, currency)}</span>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setPaying(payment)}>
                    Mark as paid
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Where everyone stands · ${currency}`}>
        <ul className="list-card">
          {rows.map((row) => (
            <li key={row.id} className="item">
              <Avatar name={row.name} id={row.id} />
              <span className="row-main">
                <span className="row-title">{row.id === group.me.id ? `${row.name} (you)` : row.name}</span>
              </span>
              <span className={`balance-word ${row.amount < 0 ? 'neg' : row.amount > 0 ? 'pos' : 'zero'}`}>{balanceText(row.amount, currency)}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Payments recorded">
        {settlements.length === 0 ? (
          <p className="list-empty">No payments recorded yet.</p>
        ) : (
          <ul className="list-card">
            {settlements.map((settlement: Settlement) => (
              <li key={settlement.id} className={`item ${settlement.status === 'undone' ? 'struck' : ''}`}>
                <span className="tile" aria-hidden="true"><Transfer /></span>
                <span className="row-main">
                  <span className="row-title wrap">
                    {line(settlement)} <span className="row-amount">{money(settlement.amount, currency)}</span>
                  </span>
                  <span className="row-sub">
                    {momentText(settlement.createdAt)}
                    {settlement.status === 'undone' ? ' · undone' : ''}
                  </span>
                </span>
                {settlement.status === 'active' ? (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void change(() => client.undoSettlement(settlement.id, settlement.version))}>
                    Undo
                  </button>
                ) : settlement.fromMemberId !== settlement.toMemberId ? (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void change(() => client.restoreSettlement(settlement.id, settlement.version))}>
                    Restore
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {paying ? (
        <Confirm
          title="Mark as paid?"
          confirmLabel="Yes, it was paid"
          busy={busy}
          onCancel={() => setPaying(null)}
          onConfirm={() => void change(() => client.createSettlement(tripId, paying))}
        >
          <p>
            {line(paying)} {money(paying.amount, currency)}. The group is told, and it can be undone.
          </p>
        </Confirm>
      ) : null}
    </div>
  );
}
