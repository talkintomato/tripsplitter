import { useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Settlement } from '../api/types';
import { ActionError, Confirm, Empty, ErrorState, Loading, Screen, Section } from '../components/ui';
import { balanceText, momentText, money, nameOf } from '../format';
import { useApp } from '../state';
import { useLoad } from '../useLoad';

interface Payment {
  fromMemberId: number;
  toMemberId: number;
  amount: number;
}

export function Balances() {
  const { client, group } = useApp();
  const tripId = Number(useParams().tripId);
  const loaded = useLoad(() => client.getBalances(tripId), `balances-${tripId}`);
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
      await loaded.reload();
      setBusy(false);
      setPaying(null);
    }
  }

  if (loaded.error !== undefined && loaded.data === undefined) {
    return (
      <Screen title="Balances">
        <ErrorState error={loaded.error} onRetry={() => void loaded.reload()} />
      </Screen>
    );
  }
  if (loaded.data === undefined) {
    return (
      <Screen title="Balances">
        <Loading what="balances" />
      </Screen>
    );
  }

  const { trip, balances, payments, settlements } = loaded.data;
  const currency = trip.homeCurrency;
  const ids = new Set<number>([...Object.keys(balances).map(Number), ...group.members.filter((m) => m.active).map((m) => m.id)]);
  const rows = [...ids]
    .map((id) => ({ id, name: nameOf(group.members, id), amount: balances[id] ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const who = (id: number): string => (id === group.me.id ? 'You' : nameOf(group.members, id));
  const line = (s: Payment): string => `${who(s.fromMemberId)} paid ${who(s.toMemberId) === 'You' ? 'you' : who(s.toMemberId)}`;

  return (
    <Screen title="Balances" subtitle={`${trip.name} · in ${currency}`}>
      <ActionError error={error} onClose={() => setError(undefined)} />

      <Section title="Where everyone stands">
        <ul className="list">
          {rows.map((row) => (
            <li key={row.id} className="row">
              <span className="row-title">{row.id === group.me.id ? `${row.name} (you)` : row.name}</span>
              <span className={`row-amount ${row.amount < 0 ? 'neg' : row.amount > 0 ? 'pos' : 'hint'}`}>{balanceText(row.amount, currency)}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="To settle up">
        {payments.length === 0 ? (
          <Empty>Everyone is settled up.</Empty>
        ) : (
          <ul className="list">
            {payments.map((payment) => (
              <li key={`${payment.fromMemberId}-${payment.toMemberId}`} className="card">
                <p className="pay-line">
                  <strong>{who(payment.fromMemberId)}</strong> {payment.fromMemberId === group.me.id ? 'pay' : 'pays'}{' '}
                  <strong>{payment.toMemberId === group.me.id ? 'you' : nameOf(group.members, payment.toMemberId)}</strong>
                  <span className="row-amount">{money(payment.amount, currency)}</span>
                </p>
                <div className="card-actions">
                  <button type="button" className="button button-small" disabled={busy} onClick={() => setPaying(payment)}>
                    Mark as paid
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Payments recorded">
        {settlements.length === 0 ? (
          <Empty>No payments recorded yet.</Empty>
        ) : (
          <ul className="list">
            {settlements.map((settlement: Settlement) => (
              <li key={settlement.id} className={`row ${settlement.status === 'undone' ? 'struck' : ''}`}>
                <span className="row-main">
                  <span className="row-title">
                    {line(settlement)} {money(settlement.amount, currency)}
                  </span>
                  <span className="hint small">
                    {momentText(settlement.createdAt)}
                    {settlement.status === 'undone' ? ' · undone' : ''}
                  </span>
                </span>
                {settlement.status === 'active' ? (
                  <button type="button" className="button button-small button-quiet" disabled={busy} onClick={() => void change(() => client.undoSettlement(settlement.id, settlement.version))}>
                    Undo
                  </button>
                ) : settlement.fromMemberId !== settlement.toMemberId ? (
                  <button type="button" className="button button-small button-quiet" disabled={busy} onClick={() => void change(() => client.restoreSettlement(settlement.id, settlement.version))}>
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
    </Screen>
  );
}
