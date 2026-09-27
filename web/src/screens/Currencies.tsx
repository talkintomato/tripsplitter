import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CURRENCIES } from '../../../src/core/currencies';
import { ratesApi } from '../api/rates';
import type { Trip } from '../api/types';
import { ActionError, Banner, Confirm, ErrorState, Loading, Screen, Section } from '../components/ui';
import { Coins } from '../components/icons';
import { useApp } from '../state';
import { useLoad } from '../useLoad';
import { CurrencyField } from './RateFields';

export function Currencies() {
  const { client, refresh } = useApp();
  const tripId = Number(useParams().tripId);
  const loaded = useLoad(() => ratesApi(client).list(tripId), `currencies-${tripId}`);
  const [currency, setCurrency] = useState('JPY');
  return <Screen title="Trip settings" back="/">
    {loaded.error !== undefined ? <ErrorState error={loaded.error} onRetry={() => void loaded.reload()} /> : !loaded.data ? <Loading /> : <>
      <TripSettings key={loaded.data.trip.id} trip={loaded.data.trip} onSaved={async () => { await refresh(); await loaded.reload(); }} />
      <Section title="Currencies and rates">
        {loaded.data.rates.length === 0 ? <p className="list-empty">No foreign currencies added yet.</p> : <ul className="list-card">{loaded.data.rates.map((r) => <li className="item" key={r.currency}>
          <span className="tile" aria-hidden="true"><Coins /></span>
          <span className="row-main">
            <span className="row-title">1 {loaded.data!.trip.homeCurrency} = {r.rate} {r.currency}</span>
            <span className="row-sub">{r.origin === 'member' ? 'Set by a member' : 'Suggested rate'}</span>
          </span>
          {loaded.data!.trip.status === 'active' ? <Link className="btn btn-secondary btn-sm" to={`/trips/${tripId}/rates/${r.currency}`}>Change rate</Link> : null}
        </li>)}</ul>}
        <p className="field-hint">Rates stay fixed until someone changes them.</p>
        {loaded.data.trip.status === 'active' ? <AddCurrency tripId={tripId} taken={[loaded.data.trip.homeCurrency, ...loaded.data.rates.map((r) => r.currency)]} currency={currency} onChange={setCurrency} /> : null}
      </Section>
    </>}
  </Screen>;
}

/** Offers only the currencies the trip does not have yet. The ones it has are changed from the list above. */
function AddCurrency({ tripId, taken, currency, onChange }: { tripId: number; taken: string[]; currency: string; onChange(value: string): void }) {
  const open = CURRENCIES.filter((c) => !taken.includes(c.code));
  const first = open[0];
  if (first === undefined) return null;
  const chosen = open.some((c) => c.code === currency) ? currency : first.code;
  return <div className="card card-pad">
    <CurrencyField label="Add currency" value={chosen} exclude={taken} onChange={onChange} />
    <Link className="btn btn-secondary btn-block" to={`/trips/${tripId}/rates/${chosen}`}>Set rate</Link>
  </div>;
}

function TripSettings({ trip, onSaved }: { trip: Trip; onSaved(): Promise<void> }) {
  const { client } = useApp();
  const [name, setName] = useState(trip.name);
  const [home, setHome] = useState<string>(trip.homeCurrency);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [done, setDone] = useState(false);
  async function save(body: { name?: string; homeCurrency?: string }) {
    setBusy(true); setError(undefined); setDone(false);
    try { await client.patchTrip(trip.id, body); await onSaved(); setDone(true); }
    catch (e) { setError(e); }
    finally { setBusy(false); setConfirm(false); }
  }
  const ended = trip.status === 'ended';
  return <>
    <ActionError error={error} />{done ? <Banner kind="success">Trip settings saved.</Banner> : null}
    <Section title="Trip name">
      <form className="card card-pad" onSubmit={(e) => { e.preventDefault(); void save({ name: name.trim() }); }}>
        <label className="field"><span>Name</span><input value={name} maxLength={100} autoComplete="off" disabled={busy || ended} onChange={(e) => setName(e.target.value)} /></label>
        {!ended ? <button className="btn btn-secondary btn-block" disabled={busy || !name.trim() || name.trim() === trip.name}>Save name</button> : null}
      </form>
    </Section>
    <Section title="Home currency">
      <div className="card card-pad">
        <p>Balances and payments are in <strong>{trip.homeCurrency}</strong>.</p>
        {trip.homeCurrencyLocked ? <p className="field-hint">The home currency is locked because an expense or payment has been confirmed.</p> : !ended ? <>
          <CurrencyField label="Home currency" value={home} onChange={setHome} disabled={busy} />
          <button className="btn btn-secondary btn-block" disabled={busy || home === trip.homeCurrency} onClick={() => setConfirm(true)}>Change home currency</button>
        </> : null}
      </div>
    </Section>
    {confirm ? <Confirm title={`Change home currency to ${home}?`} confirmLabel="Change home currency" busy={busy} onCancel={() => { if (!busy) setConfirm(false); }} onConfirm={() => void save({ homeCurrency: home })}>
      <p>All trip rates and rates entered for individual expenses will be cleared. Foreign expenses will need new rates.</p>
    </Confirm> : null}
  </>;
}
